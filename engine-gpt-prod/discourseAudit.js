'use strict';

const { splitSentences } = require('../engine/koreanText');
const { splitLogicalProseParagraphs } = require('./proseParagraphs');

const VERSION = 2;
const VIOLATION_CODES = Object.freeze([
  'scope_expansion',
  'new_evaluation',
  'intensity_amplification',
  'duplicate_conclusion',
  'repeated_reflection_conclusion',
  'overstructured_causality',
  'rhetorical_role_shift',
  'topic_restart',
  'personal_balance_shift'
]);

const REFLECTION_PATTERNS = [
  /깊이\s*(?:이해|인식|생각)하게\s*되/gu,
  /(?:절감|깨달|통감)했|(?:절감|깨달|통감)하게\s*되/gu,
  /공고히\s*(?:하|하게\s*되)/gu,
  /(?:배우|느끼|알게|확인하게|생각하게)\s*되었|(?:배울|느낄|확인할)\s*수\s*있었/gu,
  /뜻깊(?:었|은\s*경험)/gu
];

const STRONG_MODIFIER_PATTERNS = [
  /(?:파멸적|막강한|거대한|극심한|압도적|치명적|엄청난|획기적|전례\s*없는|절대적|근원적|심각한)/gu,
  /(?:완전히|엄청나게|압도적으로|극단적으로|결정적으로)\s+(?:바꾸|뒤흔들|무너뜨리|위협|좌우)/gu
];

const CONCLUSION_PATTERN = /(?:^|[.!?]\s*)(?:결론적으로|종합하면|종합적으로|결국|이처럼)|(?:의미를\s*가진다|의미가\s*있다|중요하다고\s*(?:볼|생각할)\s*수\s*있다|교훈을\s*(?:얻|주))/gu;
const CAUSAL_PATTERN = /(?:때문에|따라서|그러므로|그\s*결과|이로\s*인해|덕분에|결과적으로|이어졌|연결되었|영향을\s*미쳤)/gu;
const EXPANSION_PATTERN = /(?:뿐만\s*아니라|더\s*나아가|나아가|을\s*넘어|를\s*넘어|까지\s*(?:확장|연결)|여러\s*(?:영역|차원|문제)|다양한\s*(?:영역|차원|관점|문제)|전반으로\s*확장|포괄(?:하|하는)|아우르)/gu;
const ACTIVITY_PATTERN = /(?:조사|탐구|분석|비교|검색|찾아보|살펴보|정리|기록|발표|토론|실험|관찰|측정|제작|작성|수집|검토|질문|답변|참여|수행|맡아|계획)/gu;
const RESTART_OPENING_PATTERN = /^(?:또\s*다른|다음으로|한편|별도로|이번에는|추가로|이어서|새롭게)?\s*[^.!?\n]{0,32}(?:조사|탐구|분석|살펴보|알아보|검토)(?:했|하였|하게|한다|하였다|했습니다)/u;
const HEADING_PATTERN = /^(?:#{1,6}\s+|제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){0,3}[.)]?\s+|서론$|본론$|결론$|목\s*차$|참고\s*문헌$)/u;

const STOP_TOKENS = new Set([
  '그리고', '그러나', '하지만', '따라서', '또한', '이러한', '그러한', '것이다', '있다', '없다',
  '합니다', '했습니다', '됩니다', '되었습니다', '하였다', '하는', '하며', '해서', '통해', '위해',
  '대한', '관한', '관련', '경우', '부분', '내용', '과정', '결과', '이번', '다음', '정도', '사실',
  '정말', '매우', '보다', '같은', '여러', '다양한', '우리', '저는', '제가', '나는', '이를'
]);

function buildDiscourseProfile(value) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  const paragraphs = splitParagraphs(text).map((paragraph, index) => analyzeParagraph(paragraph, index));
  const body = paragraphs.filter(paragraph => paragraph.primaryRole !== 'heading');
  const sentences = splitSentences(text);
  const actionSentenceCount = sentences.filter(sentence => matchesPattern(sentence, ACTIVITY_PATTERN)).length;
  const reflectionCounts = REFLECTION_PATTERNS.map(pattern => countPattern(text, pattern));
  const conclusionParagraphCount = body.filter(paragraph => paragraph.roles.includes('conclusion')).length;
  const reflectionParagraphCount = body.filter(paragraph => paragraph.roles.includes('reflection')).length;
  const perfectCausalParagraphCount = body.filter(paragraph => paragraph.causalCount > 0
    && (paragraph.roles.includes('conclusion') || paragraph.roles.includes('reflection'))).length;
  const conclusionMarkerCount = countPattern(text, CONCLUSION_PATTERN);
  const causalClosureSentenceCount = sentences.filter(sentence => matchesPattern(sentence, CAUSAL_PATTERN)
    && (REFLECTION_PATTERNS.some(pattern => matchesPattern(sentence, pattern)) || matchesPattern(sentence, CONCLUSION_PATTERN))).length;
  const topicRestartCount = countTopicRestarts(sentences);
  return {
    version: VERSION,
    paragraphCount: paragraphs.length,
    bodyParagraphCount: body.length,
    sentenceCount: sentences.length,
    actionSentenceCount,
    actionSentenceRatio: round4(sentences.length ? actionSentenceCount / sentences.length : 0),
    reflectionClosureCount: reflectionCounts.reduce((sum, count) => sum + count, 0),
    maxRepeatedReflectionClosure: reflectionCounts.length ? Math.max(...reflectionCounts) : 0,
    strongModifierCount: STRONG_MODIFIER_PATTERNS.reduce((sum, pattern) => sum + countPattern(text, pattern), 0),
    conclusionParagraphCount,
    conclusionMarkerCount,
    reflectionParagraphCount,
    perfectCausalParagraphCount,
    causalClosureSentenceCount,
    topicRestartCount,
    expansionConstructionCount: countPattern(text, EXPANSION_PATTERN),
    paragraphs,
    contentTokens: extractContentTokens(text)
  };
}

function compareDiscourse(source, outputText) {
  const before = buildDiscourseProfile(source);
  const after = buildDiscourseProfile(outputText);
  const remediationPlan = buildRemediationPlan(before);
  const remediation = compareRemediationTargets(before, after, remediationPlan);
  const violations = [];
  const add = (code, count, detail = '') => {
    if (!(count > 0) || violations.some(item => item.code === code)) return;
    violations.push({ code, count, detail });
  };

  const reflectionDelta = after.reflectionClosureCount - before.reflectionClosureCount;
  const intensityDelta = after.strongModifierCount - before.strongModifierCount;
  const conclusionDelta = after.conclusionParagraphCount - before.conclusionParagraphCount;
  const conclusionMarkerDelta = after.conclusionMarkerCount - before.conclusionMarkerCount;
  const repeatedReflectionDelta = after.maxRepeatedReflectionClosure - before.maxRepeatedReflectionClosure;
  const causalClosureDelta = after.causalClosureSentenceCount - before.causalClosureSentenceCount;
  const topicRestartDelta = after.topicRestartCount - before.topicRestartCount;
  const roleShiftCount = countRoleShifts(before.paragraphs, after.paragraphs);
  const scopeExpansionCount = countScopeExpansionSignals(before, after);
  const personalBalanceShift = before.actionSentenceCount >= 2
    && after.actionSentenceRatio < before.actionSentenceRatio - 0.12;

  add('new_evaluation', reflectionDelta, 'source_relative_reflection_closure_increase');
  add('intensity_amplification', intensityDelta, 'source_relative_modifier_increase');
  add('duplicate_conclusion', conclusionMarkerDelta > 0 && after.conclusionParagraphCount >= 2 ? conclusionMarkerDelta : 0, 'conclusion_marker_increase');
  add('repeated_reflection_conclusion', repeatedReflectionDelta > 0 && after.maxRepeatedReflectionClosure >= 2 ? repeatedReflectionDelta : 0, 'repeated_reflection_formula');
  add('overstructured_causality', causalClosureDelta > 0 && after.causalClosureSentenceCount >= 2 ? causalClosureDelta : 0, 'causal_closure_sentence_increase');
  add('rhetorical_role_shift', roleShiftCount, 'paragraph_role_changed_to_reflection_or_conclusion');
  add('scope_expansion', scopeExpansionCount, 'novel_topic_cluster_with_expansion_construction');
  add('topic_restart', topicRestartDelta, 'conclusion_followed_by_new_investigation');
  add('personal_balance_shift', personalBalanceShift ? 1 : 0, 'source_activity_share_decreased');

  return {
    version: VERSION,
    pass: violations.length === 0,
    codes: violations.map(item => item.code),
    violations,
    remediation,
    metrics: {
      before: compactProfile(before),
      after: compactProfile(after),
      remediation,
      deltas: {
        reflectionClosureCount: reflectionDelta,
        strongModifierCount: intensityDelta,
        conclusionParagraphCount: conclusionDelta,
        conclusionMarkerCount: conclusionMarkerDelta,
        repeatedReflectionClosure: repeatedReflectionDelta,
        causalClosureSentenceCount: causalClosureDelta,
        topicRestartCount: topicRestartDelta,
        rhetoricalRoleShiftCount: roleShiftCount,
        scopeExpansionSignalCount: scopeExpansionCount,
        actionSentenceRatio: round4(after.actionSentenceRatio - before.actionSentenceRatio)
      }
    }
  };
}

function discoursePromptBlock(profile) {
  if (!profile) return '';
  const remediationPlan = buildRemediationPlan(profile);
  const roles = (profile.paragraphs || [])
    .filter(paragraph => paragraph.primaryRole !== 'heading')
    .slice(0, 16)
    .map((paragraph, index) => `${index + 1}:${paragraph.primaryRole}`)
    .join(', ');
  const lines = [
    '[원문 담화 계약]',
    `본문 문단 수=${profile.bodyParagraphCount}; 문단 역할=${roles || 'single'}.`,
    `원문 성찰형 결론=${profile.reflectionClosureCount}; 강한 수식=${profile.strongModifierCount}; 결론 문단=${profile.conclusionParagraphCount}.`,
    '각 문단의 역할과 주제 범위를 그대로 둔다. 설명 문단을 성찰·교훈·결론 문단으로 바꾸지 않는다.',
    '원문에 없는 상위 개념, 사회적 쟁점, 파급 효과, 평가 강도나 새 결론을 만들지 않는다.',
    '개인의 조사·비교·발표 같은 실제 행동이 원문에 있으면 일반 설명보다 뒤로 밀어내지 않는다.',
    '변화량은 같은 주장 안의 절 순서·주어 위치·연결 방식·호흡으로 만들고, 내용 범위를 넓혀 채우지 않는다.'
  ];
  if (remediationPlan.targetCount > 0) {
    const labels = remediationPlan.categories.map(item => item.label).join(', ');
    lines.push(
      '[원문에 이미 있는 AI식 담화 흔적 개선]',
      `원문에서 다음 개선 대상이 확인됐다: ${labels}.`,
      '이 표현이 원문에 있었다는 이유로 그대로 복사하지 않는다. 주장·평가 강도·사실은 남기면서 같은 문단 안에서 직접적이고 덜 정형적인 문장으로 다시 쓴다.',
      '성찰 공식은 실제 행동이나 판단을 직접 서술하고, 반복 결론은 각 문단의 고유한 역할이 드러나게 표현한다. 인과 연결은 근거가 있는 범위만 남기고 모든 문단을 완벽한 원인-결과-교훈 구조로 맞추지 않는다.',
      '새 주제를 삭제해 수치를 맞추거나 원문의 범위를 줄이지 않는다. 특히 원문에 있던 주제 확장은 보존하며, 개선은 표현 방식에만 적용한다.'
    );
  }
  return lines.join('\n');
}

function buildRemediationPlan(value) {
  const profile = value && typeof value === 'object' && Number(value.version) >= 1
    ? value
    : buildDiscourseProfile(value);
  const categories = [];
  const add = (code, label, sourceCount, requiredReduction, sentenceOrdinals = []) => {
    if (!(sourceCount > 0) || !(requiredReduction > 0)) return;
    categories.push({
      code,
      label,
      sourceCount,
      requiredReduction: Math.min(sourceCount, requiredReduction),
      sentenceOrdinals: uniqueNumbers(sentenceOrdinals).slice(0, 20)
    });
  };
  const sourceText = (profile.paragraphs || []).map(item => item.text || '').join('\n\n');
  const sentences = splitSentences(sourceText);
  const ordinalsFor = predicate => sentences
    .map((sentence, index) => (predicate(sentence) ? index + 1 : 0))
    .filter(Boolean);

  add(
    'reflection_formula',
    '깊이 이해하게 되었습니다·절감했습니다 같은 정형 성찰 결론',
    profile.reflectionClosureCount,
    profile.reflectionClosureCount,
    ordinalsFor(sentence => REFLECTION_PATTERNS.some(pattern => matchesPattern(sentence, pattern)))
  );
  if (profile.strongModifierCount >= 2) {
    add(
      'stacked_strong_modifiers',
      '파멸적·막강한·거대한 같은 강한 수식의 반복',
      profile.strongModifierCount,
      Math.max(1, profile.strongModifierCount - 1),
      ordinalsFor(sentence => STRONG_MODIFIER_PATTERNS.some(pattern => matchesPattern(sentence, pattern)))
    );
  }
  if (profile.conclusionMarkerCount >= 2) {
    add(
      'repeated_conclusion_markers',
      '결국·이처럼·중요한 의미 같은 결론 표지의 반복',
      profile.conclusionMarkerCount,
      profile.conclusionMarkerCount - 1,
      ordinalsFor(sentence => matchesPattern(sentence, CONCLUSION_PATTERN))
    );
  }
  const causalSourceCount = Math.max(profile.causalClosureSentenceCount, profile.perfectCausalParagraphCount);
  if (causalSourceCount >= 2) {
    add(
      'overstructured_causal_closure',
      '원인-결과-교훈으로 매번 닫히는 문단 구조',
      causalSourceCount,
      causalSourceCount - 1,
      ordinalsFor(sentence => matchesPattern(sentence, CAUSAL_PATTERN)
        && (REFLECTION_PATTERNS.some(pattern => matchesPattern(sentence, pattern)) || matchesPattern(sentence, CONCLUSION_PATTERN)))
    );
  }
  if (profile.topicRestartCount > 0) {
    add(
      'topic_restart_after_conclusion',
      '결론 직후 새 탐구가 다시 시작되는 연결',
      profile.topicRestartCount,
      profile.topicRestartCount,
      ordinalsFor(sentence => RESTART_OPENING_PATTERN.test(String(sentence || '').trim()))
    );
  }
  return {
    version: VERSION,
    applicable: categories.length > 0,
    targetCount: categories.reduce((sum, item) => sum + item.requiredReduction, 0),
    categoryCount: categories.length,
    categories
  };
}

function compareRemediationTargets(beforeValue, afterValue, plan = null) {
  const before = beforeValue && typeof beforeValue === 'object' && Number(beforeValue.version) >= 1
    ? beforeValue
    : buildDiscourseProfile(beforeValue);
  const after = afterValue && typeof afterValue === 'object' && Number(afterValue.version) >= 1
    ? afterValue
    : buildDiscourseProfile(afterValue);
  const selectedPlan = plan || buildRemediationPlan(before);
  const rows = (selectedPlan.categories || []).map(item => {
    const afterCount = remediationMetric(after, item.code);
    const reduction = Math.max(0, item.sourceCount - afterCount);
    const achievedReduction = Math.min(item.requiredReduction, reduction);
    return {
      code: item.code,
      sourceCount: item.sourceCount,
      afterCount,
      requiredReduction: item.requiredReduction,
      achievedReduction,
      residualRequiredReduction: Math.max(0, item.requiredReduction - achievedReduction)
    };
  });
  const targetCount = rows.reduce((sum, item) => sum + item.requiredReduction, 0);
  const achievedReduction = rows.reduce((sum, item) => sum + item.achievedReduction, 0);
  return {
    applicable: targetCount > 0,
    targetCount,
    achievedReduction,
    residualTargetCount: Math.max(0, targetCount - achievedReduction),
    coverage: round4(targetCount ? achievedReduction / targetCount : 1),
    categories: rows
  };
}

function remediationMetric(profile, code) {
  if (code === 'reflection_formula') return profile.reflectionClosureCount || 0;
  if (code === 'stacked_strong_modifiers') return profile.strongModifierCount || 0;
  if (code === 'repeated_conclusion_markers') return profile.conclusionMarkerCount || 0;
  if (code === 'overstructured_causal_closure') {
    return Math.max(profile.causalClosureSentenceCount || 0, profile.perfectCausalParagraphCount || 0);
  }
  if (code === 'topic_restart_after_conclusion') return profile.topicRestartCount || 0;
  return 0;
}

function compactProfile(profile) {
  return {
    paragraphCount: profile.paragraphCount,
    bodyParagraphCount: profile.bodyParagraphCount,
    sentenceCount: profile.sentenceCount,
    actionSentenceCount: profile.actionSentenceCount,
    actionSentenceRatio: profile.actionSentenceRatio,
    reflectionClosureCount: profile.reflectionClosureCount,
    maxRepeatedReflectionClosure: profile.maxRepeatedReflectionClosure,
    strongModifierCount: profile.strongModifierCount,
    conclusionParagraphCount: profile.conclusionParagraphCount,
    conclusionMarkerCount: profile.conclusionMarkerCount,
    reflectionParagraphCount: profile.reflectionParagraphCount,
    perfectCausalParagraphCount: profile.perfectCausalParagraphCount,
    causalClosureSentenceCount: profile.causalClosureSentenceCount,
    topicRestartCount: profile.topicRestartCount,
    expansionConstructionCount: profile.expansionConstructionCount
  };
}

function analyzeParagraph(text, index) {
  const clean = String(text || '').trim();
  if (HEADING_PATTERN.test(clean) && clean.length <= 100) {
    return paragraphProfile(index, clean, ['heading'], 'heading');
  }
  const reflectionCount = REFLECTION_PATTERNS.reduce((sum, pattern) => sum + countPattern(clean, pattern), 0);
  const conclusionCount = countPattern(clean, CONCLUSION_PATTERN);
  const activityCount = countPattern(clean, ACTIVITY_PATTERN);
  const roles = [];
  if (activityCount > 0) roles.push('activity');
  if (reflectionCount > 0) roles.push('reflection');
  if (conclusionCount > 0) roles.push('conclusion');
  if (!roles.length) roles.push('exposition');
  const primaryRole = roles.includes('conclusion')
    ? 'conclusion'
    : (roles.includes('reflection') ? 'reflection' : (roles.includes('activity') ? 'activity' : 'exposition'));
  return {
    ...paragraphProfile(index, clean, roles, primaryRole),
    reflectionCount,
    conclusionCount,
    activityCount,
    causalCount: countPattern(clean, CAUSAL_PATTERN),
    expansionCount: countPattern(clean, EXPANSION_PATTERN),
    contentTokens: extractContentTokens(clean)
  };
}

function paragraphProfile(index, text, roles, primaryRole) {
  return {
    index,
    text,
    primaryRole,
    roles,
    charLength: text.replace(/\s+/gu, '').length,
    reflectionCount: 0,
    conclusionCount: 0,
    activityCount: 0,
    causalCount: 0,
    expansionCount: 0,
    contentTokens: new Set()
  };
}

function countRoleShifts(beforeParagraphs, afterParagraphs) {
  if (!beforeParagraphs.length || beforeParagraphs.length !== afterParagraphs.length) return 0;
  let count = 0;
  beforeParagraphs.forEach((sourceParagraph, index) => {
    if (sourceParagraph.primaryRole === 'heading') return;
    const outputParagraph = afterParagraphs[index];
    if (!outputParagraph || outputParagraph.primaryRole === 'heading') return;
    const addedReflection = !sourceParagraph.roles.includes('reflection') && outputParagraph.roles.includes('reflection');
    const addedConclusion = !sourceParagraph.roles.includes('conclusion') && outputParagraph.roles.includes('conclusion');
    if (addedReflection || addedConclusion) count += 1;
  });
  return count;
}

function countScopeExpansionSignals(before, after) {
  const expansionDelta = after.expansionConstructionCount - before.expansionConstructionCount;
  if (expansionDelta <= 0) return 0;
  const novelTokens = [...after.contentTokens].filter(token => !before.contentTokens.has(token));
  // 문단 재배치만으로 신호가 생기지 않게 문서 전체 기준으로 비교한다.
  // 확장 담화 표지가 실제로 늘고 새 내용어 묶음이 동반될 때만 범위 확장으로 본다.
  return novelTokens.length >= 3 ? expansionDelta : 0;
}

function countTopicRestarts(sentences) {
  let count = 0;
  for (let index = 0; index < sentences.length - 1; index += 1) {
    const current = String(sentences[index] || '');
    const next = String(sentences[index + 1] || '');
    const closes = matchesPattern(current, CONCLUSION_PATTERN)
      || REFLECTION_PATTERNS.some(pattern => matchesPattern(current, pattern));
    if (closes && RESTART_OPENING_PATTERN.test(next.trim())) count += 1;
  }
  return count;
}

function extractContentTokens(value) {
  const out = new Set();
  const tokens = String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}/gu) || [];
  for (const raw of tokens) {
    const token = normalizeToken(raw);
    if (token.length < 2 || STOP_TOKENS.has(token) || /(?:했다|한다|된다|입니다|습니다|하였다|되었다|하면서|하였으며|되면서)$/u.test(token)) continue;
    out.add(token);
  }
  return out;
}

function normalizeToken(value) {
  let token = String(value || '').normalize('NFC').toLowerCase();
  for (const particle of ['에서는', '으로는', '에게는', '이라는', '까지의', '부터의', '으로', '에서', '에게', '보다', '처럼', '와의', '과의', '은', '는', '이', '가', '을', '를', '의', '에', '도', '만', '와', '과', '로']) {
    if (token.length >= particle.length + 2 && token.endsWith(particle)) {
      token = token.slice(0, -particle.length);
      break;
    }
  }
  return token;
}

function splitParagraphs(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return splitLogicalProseParagraphs(text);
}

function countPattern(value, pattern) {
  return (String(value || '').match(new RegExp(pattern.source, pattern.flags)) || []).length;
}

function matchesPattern(value, pattern) {
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
}

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
}

function uniqueNumbers(values) {
  return [...new Set((values || []).map(value => Number(value)).filter(Number.isFinite))];
}

function isDiscourseViolationCode(value) {
  return VIOLATION_CODES.includes(String(value || ''));
}

module.exports = {
  VERSION,
  VIOLATION_CODES,
  isDiscourseViolationCode,
  buildDiscourseProfile,
  buildRemediationPlan,
  compareRemediationTargets,
  compareDiscourse,
  discoursePromptBlock
};
