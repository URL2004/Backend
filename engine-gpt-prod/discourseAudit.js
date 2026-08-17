'use strict';

const { splitSentences } = require('../engine/koreanText');
const { splitLogicalProseParagraphs } = require('./proseParagraphs');
const layoutStructure = require('./layoutStructure');
const { alignSourceSentence } = require('./sentenceAlignment');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');

const VERSION = 9;
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
  /(?:절감|깨달|깨닫|통감)했|(?:절감|깨달|깨닫|통감)게?\s*되/gu,
  /공고히\s*(?:하|하게\s*되)/gu,
  /(?:배우|느끼|알게|확인하게|생각하게)\s*되었|(?:배울|느낄|확인할|알)\s*수\s*있었/gu,
  /알았(?:다|습니다|어요)?/gu,
  /뜻깊(?:었|은\s*경험)/gu
];
// 수사적 상투구보다 넓은 “성찰 기능” 판정이다. `조금씩 보이기
// 시작했다`를 `알게 되었다`로 바꾼 것처럼 같은 문단의 기존 판단을
// 의역한 경우를 새 교훈·평가 주입으로 오인하지 않기 위해 사용한다.
const REFLECTION_FUNCTION_PATTERN = /(?:깨달|깨닫|알았(?:다|습니다|어요)?|알\s*수\s*있었|알게\s*되|보이기\s*시작|돌아보|되돌아보|생각하게\s*되|느끼게\s*되|확인하게\s*되|인식하게\s*되|이해하게\s*되|통찰|배움(?:을|이)?[^.!?\n]{0,24}(?:주|얻))/gu;
// 책·프로그램·기회를 "알게 되었다"는 발견 경로이지 새로운 교훈이나
// 자기평가가 아니다. 성찰 공식의 넓은 `알게 되다` 패턴에서 따로 뺀다.
const NON_REFLECTIVE_DISCOVERY_PATTERN = /(?:책|도서|프로그램|기회|공고|캠프|서비스|제품|기관|학교|회사|행사|작품|전시|채용|현장\s*실습)(?:을|를)\s+알게\s*되/gu;
const EVALUATION_CLOSURE_FAMILIES = Object.freeze([
  /(?:다시\s*)?느꼈|느낌을?\s*받/gu,
  /다시\s*생각|생각하게\s*되/gu,
  /인상\s*깊|기억에\s*남|오래\s*남/gu,
  /깨달|알게\s*되|이해하게\s*되/gu,
  /중요(?:성|하다|하다고)|의미를\s*가지/gu
]);

const STRONG_MODIFIER_PATTERNS = [
  /(?:파멸적|막강한|거대한|극심한|압도적|치명적|엄청난|획기적|전례\s*없는|절대적|근원적|심각한)/gu,
  /(?:완전히|엄청나게|압도적으로|극단적으로|결정적으로)\s+(?:바꾸|뒤흔들|무너뜨리|위협|좌우)/gu
];

const CONCLUSION_PATTERN = /(?:^|[.!?]\s*)(?:결론적으로|종합하면|종합적으로|정리하면|요컨대|즉|결국|이처럼)|(?:의미를\s*가진다|의미가\s*있다|중요하다고\s*(?:볼|생각할)\s*수\s*있다|교훈을\s*(?:얻|주)|(?:점|사실)(?:을|이)\s*(?:보여|드러내|시사|의미))/gu;
const CONCLUSION_PREDICATE_PATTERN = /(?:의미를\s*가진다|의미가\s*있다|중요하다고\s*(?:볼|생각할)\s*수\s*있다|교훈을\s*(?:얻|주)|(?:점|사실)(?:을|이)\s*(?:보여|드러내|시사|의미))/gu;
const SOURCE_EVALUATION_EVIDENCE_PATTERN = /(?:생각|느꼈|느끼|인상|힘들|부담|바랐|알\s*수\s*있었|배웠|배우|깨달|이해|판단|의미|중요|확인할\s*수\s*있었)/gu;
const CAUSAL_PATTERN = /(?:때문에|따라서|그러므로|그\s*결과|이로\s*인해|덕분에|결과적으로|이어졌|연결되었|영향을\s*미쳤)/gu;
const EXPANSION_PATTERN = /(?:뿐만\s*아니라|더\s*나아가|나아가|(?:데|데서|에)\s*(?:그치지|멈추지|머무르지)\s*않고|(?:을|를)\s*넘어\s+(?:사회|세계|국가|인권|기후|문화|경제|정치|환경|산업|공동체|차원|영역|문제)|(?:차원|수준|범위|영역|대상|도구|성격|한계|단계|수습|관점|틀|접근)(?:을|를|에|에서)?\s*(?:넘어|벗어나|나아가)|더\s*이상[^.!?。！？\n]{0,45}(?:이|가)\s*아니라|까지\s*(?:확장|연결)|여러\s*(?:영역|차원|문제)|다양한\s*(?:영역|차원|관점|문제)|전반으로\s*확장|포괄(?:하|하는)|아우르)/gu;
const SCOPE_TOPIC_TOKENS = new Set([
  '사회', '세계', '국가', '국제', '시민', '세계시민', '인권', '기후', '난민',
  '식량', '안보', '문화', '경제', '정치', '환경', '산업', '공동체', '윤리',
  '법률', '교육', '보건', '주거', '고용', '불평등'
]);
// `찾아보다`의 관형형은 음절 조합상 `찾아본`이 되어 `찾아보` 정규식과
// 일치하지 않는다. 어간 기능을 포괄해 조사→찾아본 같은 정상 의역이
// 실제 활동 삭제로 계산되지 않게 한다.
const ACTIVITY_PATTERN = /(?:조사|탐구|분석|비교|검색|찾아|살펴보|정리|기록|발표|토론|실험|관찰|측정|제작|작성|수집|검토|질문|답변|참여|수행|맡아|계획)/gu;
const RESTART_OPENING_PATTERN = /^(?:또\s*다른|다음으로|한편|별도로|이번에는|추가로|이어서|새롭게)?\s*[^.!?\n]{0,32}(?:조사|탐구|분석|살펴보|알아보|검토)(?:했|하였|하게|한다|하였다|했습니다)/u;

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
  const add = (code, count, detail = '', metadata = {}) => {
    if (!(count > 0) || violations.some(item => item.code === code)) return;
    violations.push({ code, count, detail, ...metadata });
  };

  const reflectionDelta = after.reflectionClosureCount - before.reflectionClosureCount;
  const novelReflectionCount = countNovelReflectionFunctions(source, outputText);
  const intensityDelta = after.strongModifierCount - before.strongModifierCount;
  const conclusionDelta = after.conclusionParagraphCount - before.conclusionParagraphCount;
  const conclusionMarkerDelta = after.conclusionMarkerCount - before.conclusionMarkerCount;
  const repeatedReflectionDelta = after.maxRepeatedReflectionClosure - before.maxRepeatedReflectionClosure;
  const causalClosureDelta = after.causalClosureSentenceCount - before.causalClosureSentenceCount;
  const topicRestartDelta = after.topicRestartCount - before.topicRestartCount;
  const roleShiftCount = countRoleShifts(before.paragraphs, after.paragraphs);
  const scopeExpansionCount = countScopeExpansionSignals(source, outputText, before, after);
  const personalBalance = inspectPersonalBalanceShift(source, outputText, before, after);
  const personalBalanceShift = personalBalance.shift;

  add(
    'new_evaluation',
    novelReflectionCount,
    'source_relative_novel_reflection_function',
    { sentenceOrdinals: introducedReflectionOutputOrdinals(source, outputText) }
  );
  add(
    'intensity_amplification',
    intensityDelta,
    'source_relative_modifier_increase',
    { sentenceOrdinals: introducedStrongModifierOutputOrdinals(source, outputText) }
  );
  add('duplicate_conclusion', conclusionMarkerDelta > 0 && after.conclusionParagraphCount >= 2 ? conclusionMarkerDelta : 0, 'conclusion_marker_increase');
  add(
    'repeated_reflection_conclusion',
    novelReflectionCount > 0 && repeatedReflectionDelta > 0 && after.maxRepeatedReflectionClosure >= 2
      ? Math.min(novelReflectionCount, repeatedReflectionDelta)
      : 0,
    'new_repeated_reflection_formula'
  );
  add('overstructured_causality', causalClosureDelta > 0 && after.causalClosureSentenceCount >= 2 ? causalClosureDelta : 0, 'causal_closure_sentence_increase');
  add('rhetorical_role_shift', roleShiftCount, 'paragraph_role_changed_to_reflection_or_conclusion');
  add('scope_expansion', scopeExpansionCount, 'novel_topic_cluster_with_expansion_construction');
  add('topic_restart', topicRestartDelta, 'conclusion_followed_by_new_investigation');
  add(
    'personal_balance_shift',
    personalBalanceShift ? 1 : 0,
    'source_activity_evidence_lost_or_replaced',
    {
      lostActionSentenceCount: personalBalance.lostActionSentenceCount,
      novelNonActivitySentenceCount: personalBalance.novelNonActivitySentenceCount
    }
  );

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
        novelReflectionFunctionCount: novelReflectionCount,
        strongModifierCount: intensityDelta,
        conclusionParagraphCount: conclusionDelta,
        conclusionMarkerCount: conclusionMarkerDelta,
        repeatedReflectionClosure: repeatedReflectionDelta,
        causalClosureSentenceCount: causalClosureDelta,
        topicRestartCount: topicRestartDelta,
        rhetoricalRoleShiftCount: roleShiftCount,
        scopeExpansionSignalCount: scopeExpansionCount,
        actionSentenceRatio: round4(after.actionSentenceRatio - before.actionSentenceRatio),
        lostActionSentenceCount: personalBalance.lostActionSentenceCount,
        novelNonActivitySentenceCount: personalBalance.novelNonActivitySentenceCount
      }
    }
  };
}

// 문장 편집률과 별개로, 문단 역할·반복 평가·아이디어 순서가
// 문서 전체에서 어떻게 바뀌었는지를 본다. 자연스러운 재작성을
// 자의적 문단 이동으로 착각하지 않도록, 순서 보존과 내용 토큰 연결을
// 먼저 검사하고 반복·담화 개선만 점수로 인정한다.
function compareMacroDiscourse(source, outputText) {
  const before = buildDiscourseProfile(source);
  const after = buildDiscourseProfile(outputText);
  const beforeBody = before.paragraphs.filter(item => item.primaryRole !== 'heading');
  const afterBody = after.paragraphs.filter(item => item.primaryRole !== 'heading');
  const applicable = beforeBody.length >= 3 && afterBody.length >= 1;
  const sourceRepeatedEvaluationExcess = repeatedEvaluationExcess(source);
  const outputRepeatedEvaluationExcess = repeatedEvaluationExcess(outputText);
  const repeatedEvaluationReduction = Math.max(
    0,
    sourceRepeatedEvaluationExcess - outputRepeatedEvaluationExcess
  );
  const remediation = compareRemediationTargets(before, after, buildRemediationPlan(before));
  const alignment = alignMacroParagraphs(beforeBody, afterBody);
  const roleOrderRetention = roleSequenceRetention(
    beforeBody.map(item => item.primaryRole),
    afterBody.map(item => item.primaryRole)
  );
  const ideaOrderRetention = alignment.ideaOrderRetention;
  const safeOrder = roleOrderRetention >= 0.72 && ideaOrderRetention >= 0.72;
  const paragraphBoundaryDelta = Math.abs(afterBody.length - beforeBody.length);
  const recomposedParagraphCount = alignment.recomposedParagraphCount;
  const evaluationProgress = sourceRepeatedEvaluationExcess > 0
    ? Math.min(1, repeatedEvaluationReduction / sourceRepeatedEvaluationExcess)
    : 0;
  const remediationProgress = remediation.targetCount > 0 ? remediation.coverage : 0;
  const recompositionProgress = safeOrder && (paragraphBoundaryDelta > 0 || recomposedParagraphCount > 0)
    ? 1
    : 0;
  const score = applicable && safeOrder
    ? round4((evaluationProgress * 0.45) + (remediationProgress * 0.40) + (recompositionProgress * 0.15))
    : 0;
  return {
    version: 1,
    applicable,
    pass: !applicable || safeOrder,
    score,
    sourceBodyParagraphCount: beforeBody.length,
    outputBodyParagraphCount: afterBody.length,
    paragraphBoundaryDelta,
    recomposedParagraphCount,
    sourceRepeatedEvaluationExcess,
    outputRepeatedEvaluationExcess,
    repeatedEvaluationReduction,
    roleOrderRetention: round4(roleOrderRetention),
    ideaOrderRetention: round4(ideaOrderRetention),
    remediation
  };
}

function buildMacroDiscoursePlan(source, {
  requestStrength = 'basic',
  documentProfile = null,
  rhetoricalRemediationPlan = null
} = {}) {
  const profile = String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
  const discourseProfile = buildDiscourseProfile(source);
  const narrativeProfile = [
    'personal_essay', 'general', 'review_blog',
    // 과거 관리자·평가 데이터의 호환 별칭
    'general_essay', 'blog_review'
  ].includes(profile);
  const repeatedEvaluationTargetCount = repeatedEvaluationExcess(source);
  const rhetoricalTargetCount = Number(
    rhetoricalRemediationPlan?.targetCount
      ?? buildRemediationPlan(discourseProfile).targetCount
      ?? 0
  );
  const applicable = String(requestStrength || '') === 'advanced'
    && narrativeProfile
    && discourseProfile.bodyParagraphCount >= 3
    && (repeatedEvaluationTargetCount > 0 || rhetoricalTargetCount > 0);
  return {
    version: 1,
    applicable,
    profile,
    sourceBodyParagraphCount: discourseProfile.bodyParagraphCount,
    repeatedEvaluationTargetCount,
    rhetoricalTargetCount,
    minScore: applicable ? 0.25 : 0
  };
}

function repeatedEvaluationExcess(value) {
  return EVALUATION_CLOSURE_FAMILIES.reduce((sum, pattern) => {
    const count = countPattern(value, pattern);
    return sum + Math.max(0, count - 1);
  }, 0);
}

function alignMacroParagraphs(sourceParagraphs, outputParagraphs) {
  const bestSourceIndices = [];
  const sourceLinkCounts = sourceParagraphs.map(() => 0);
  let multiSourceOutputCount = 0;
  for (const output of outputParagraphs) {
    const links = sourceParagraphs
      .map((source, index) => ({ index, score: tokenJaccard(source.contentTokens, output.contentTokens) }))
      .filter(item => item.score >= 0.16)
      .sort((left, right) => right.score - left.score);
    if (links.length > 1) multiSourceOutputCount += 1;
    for (const link of links) sourceLinkCounts[link.index] += 1;
    if (links.length) bestSourceIndices.push(links[0].index);
  }
  let orderedPairCount = 0;
  for (let index = 1; index < bestSourceIndices.length; index += 1) {
    if (bestSourceIndices[index] >= bestSourceIndices[index - 1]) orderedPairCount += 1;
  }
  const ideaOrderRetention = bestSourceIndices.length <= 1
    ? 1
    : orderedPairCount / (bestSourceIndices.length - 1);
  return {
    ideaOrderRetention,
    recomposedParagraphCount: multiSourceOutputCount
      + sourceLinkCounts.filter(count => count > 1).length
  };
}

function tokenJaccard(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left || []);
  const rightSet = right instanceof Set ? right : new Set(right || []);
  if (!leftSet.size && !rightSet.size) return 1;
  let overlap = 0;
  for (const token of leftSet) if (rightSet.has(token)) overlap += 1;
  return overlap / Math.max(1, leftSet.size + rightSet.size - overlap);
}

function roleSequenceRetention(left, right) {
  if (!left.length) return 1;
  const rows = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      rows[i][j] = left[i - 1] === right[j - 1]
        ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  return rows[left.length][right.length] / left.length;
}

function inspectPersonalBalanceShift(source, outputText, before, after) {
  const ratioCandidate = before.sentenceCount >= 4
    && before.actionSentenceCount >= 2
    && after.actionSentenceRatio < before.actionSentenceRatio - 0.12;
  if (!ratioCandidate) {
    return { shift: false, lostActionSentenceCount: 0, novelNonActivitySentenceCount: 0 };
  }

  const sourceSentences = splitSentences(source);
  const outputSentences = splitSentences(outputText);
  const lostActionSentenceCount = sourceSentences.reduce((count, sentence, index) => {
    if (!matchesPattern(sentence, ACTIVITY_PATTERN)) return count;
    const alignment = alignSourceSentence(
      sentence,
      index,
      sourceSentences.length,
      outputSentences,
      { window: 6, maxOutputGroup: 3 }
    );
    const covered = Number(alignment?.rawScore || 0) >= 0.26
      || Number(alignment?.score || 0) >= 0.22;
    return count + (covered ? 0 : 1);
  }, 0);

  const novelNonActivitySentenceCount = outputSentences.reduce((count, sentence, index) => {
    if (matchesPattern(sentence, ACTIVITY_PATTERN)) return count;
    const alignment = alignSourceSentence(
      sentence,
      index,
      outputSentences.length,
      sourceSentences,
      { window: 8, maxOutputGroup: 3 }
    );
    const sourceBacked = Number(alignment?.rawScore || 0) >= 0.24
      || Number(alignment?.score || 0) >= 0.20;
    return count + (sourceBacked ? 0 : 1);
  }, 0);

  // 문장 분리만으로 활동 문장 비율이 낮아진 경우에는 경고하지 않는다.
  // 실제 활동 근거가 사라졌거나, 활동 대신 원문에 없던 일반론·평가 문장이
  // 여러 개 생겼다는 정렬 증거가 함께 있을 때만 개인 서사 축소로 본다.
  const shift = lostActionSentenceCount >= 2
    || novelNonActivitySentenceCount >= 3
    || (lostActionSentenceCount >= 1 && novelNonActivitySentenceCount >= 2);
  return { shift, lostActionSentenceCount, novelNonActivitySentenceCount };
}

function introducedStrongModifierOutputOrdinals(source, outputText) {
  const remaining = new Map();
  for (const occurrence of strongModifierOccurrences(source)) {
    remaining.set(occurrence, Number(remaining.get(occurrence) || 0) + 1);
  }
  const ordinals = [];
  splitSentences(String(outputText || '')).forEach((sentence, index) => {
    let introduced = false;
    for (const occurrence of strongModifierOccurrences(sentence)) {
      const count = Number(remaining.get(occurrence) || 0);
      if (count > 0) remaining.set(occurrence, count - 1);
      else introduced = true;
    }
    if (introduced) ordinals.push(index + 1);
  });
  return uniqueNumbers(ordinals);
}

function strongModifierOccurrences(value) {
  const occurrences = [];
  for (const pattern of STRONG_MODIFIER_PATTERNS) {
    const matches = String(value || '').match(new RegExp(pattern.source, pattern.flags)) || [];
    occurrences.push(...matches.map(item => String(item || '').replace(/\s+/gu, ' ').trim()));
  }
  return occurrences;
}

function reflectionFormulaCount(value) {
  return Math.max(0, REFLECTION_PATTERNS
    .reduce((sum, pattern) => sum + countPattern(value, pattern), 0)
    - countPattern(value, NON_REFLECTIVE_DISCOVERY_PATTERN));
}

function hasSourceEvaluationFunction(value) {
  return matchesPattern(value, SOURCE_EVALUATION_EVIDENCE_PATTERN)
    || matchesPattern(value, REFLECTION_FUNCTION_PATTERN)
    || REFLECTION_PATTERNS.some(pattern => matchesPattern(value, pattern));
}

// `new_evaluation`은 문서 단위 개수만 알면 경고는 만들 수 있지만, 안전하게
// 되돌리려면 실제로 새 성찰 기능을 만든 결과 문장의 위치가 필요하다. 원문과
// 결과의 문단 수가 같으면 같은 문단의 기존 평가 기능을 먼저 인정하고, 문단
// 수가 달라졌을 때만 공통 문장 정렬 결과를 사용한다. 이 함수는 탐지기의
// 판정 범위를 넓히지 않고 기존 판정에 복원 좌표만 붙인다.
function introducedReflectionOutputOrdinals(source, outputText) {
  const sourceParagraphs = splitParagraphs(source);
  const outputParagraphs = splitParagraphs(outputText);
  const ordinals = [];

  if (sourceParagraphs.length === outputParagraphs.length && sourceParagraphs.length > 0) {
    let sentenceOffset = 0;
    outputParagraphs.forEach((paragraph, paragraphIndex) => {
      const sentences = splitSentences(paragraph);
      const sourceParagraph = sourceParagraphs[paragraphIndex] || '';
      if (!hasSourceEvaluationFunction(sourceParagraph)) {
        sentences.forEach((sentence, sentenceIndex) => {
          if (reflectionFormulaCount(sentence) > 0) {
            ordinals.push(sentenceOffset + sentenceIndex + 1);
          }
        });
      }
      sentenceOffset += sentences.length;
    });
    return uniqueNumbers(ordinals);
  }

  const sourceSentences = splitSentences(source);
  const outputSentences = splitSentences(outputText);
  outputSentences.forEach((sentence, index) => {
    if (reflectionFormulaCount(sentence) <= 0) return;
    const alignment = alignSourceSentence(
      sentence,
      index,
      outputSentences.length,
      sourceSentences,
      { window: 8, maxOutputGroup: 3 }
    );
    const alignedSource = Number(alignment?.score || 0) >= 0.2
      ? String(alignment?.text || '')
      : '';
    if (!hasSourceEvaluationFunction(alignedSource)) ordinals.push(index + 1);
  });
  return uniqueNumbers(ordinals);
}

// 의미 심사기가 강도 증폭을 고치지 못해도 문서 전체를 버리거나 경고만
// 남기지 않는다. 원문에 없던 강한 수식이 생긴 결과 문장만 공통 정렬기로
// 원문 대응 문장에 되돌린다. 후보 채택은 호출부의 수치·화자·구조·깊이
// 비퇴행 감사를 다시 통과해야 한다.
function restoreIntroducedIntensitySentences(source, outputText, audit = null) {
  const report = audit || compareDiscourse(source, outputText);
  const ordinals = [];
  for (const violation of report?.violations || []) {
    if (violation.code !== 'intensity_amplification') continue;
    ordinals.push(...(violation.sentenceOrdinals || []));
  }
  return restoreSourceSentenceOrdinals(source, outputText, ordinals, {
    maxRestoreCount: 6,
    minSimilarity: 0.24,
    ordinalSpace: 'output'
  });
}

// 의미 심사 수리가 끝난 뒤에도 남은 새 교훈·평가 문장만 원문 대응 문장으로
// 되돌린다. 문서 전체를 원문으로 복귀시키지 않으며, 호출부가 공통 후보 감사와
// 구조·깊이 비퇴행 검사를 다시 수행해야만 결과에 반영한다.
function restoreIntroducedEvaluationSentences(source, outputText, audit = null) {
  const report = audit || compareDiscourse(source, outputText);
  const ordinals = [];
  for (const violation of report?.violations || []) {
    if (violation.code !== 'new_evaluation') continue;
    ordinals.push(...(violation.sentenceOrdinals || []));
  }
  return restoreSourceSentenceOrdinals(source, outputText, ordinals, {
    maxRestoreCount: 6,
    minSimilarity: 0.24,
    ordinalSpace: 'output'
  });
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
      '새 주제를 삭제해 수치를 맞추거나 원문의 범위를 줄이지 않는다. 특히 원문에 있던 주제 확장은 보존하며, 개선은 표현 방식에만 적용한다.',
      remediationPromptGuidance(remediationPlan)
    );
  }
  return lines.join('\n');
}

function remediationPromptGuidance(plan) {
  const categories = Array.isArray(plan?.categories) ? plan.categories : [];
  if (!categories.length) return '';
  const lines = ['[담화 개선 대상별 실행 지시]'];
  for (const item of categories) {
    const ordinals = uniqueNumbers(item.sentenceOrdinals || []);
    const target = ordinals.length ? `대상 일반 문장=${ordinals.join(',')}` : '대상=해당 표현이 있는 문장';
    if (item.code === 'reflection_formula') {
      lines.push(`- ${target}: ‘깊이 이해했다·절감했다·알게 되었다’ 같은 결론 공식을 다른 감상 표현으로 치환하지 않는다. 원문에 이미 있는 행동·관찰·판단을 문장의 주어와 서술어로 직접 제시하고, 새 경험이나 교훈은 만들지 않는다.`);
    } else if (item.code === 'stacked_strong_modifiers') {
      lines.push(`- ${target}: 강한 수식어를 약한 동의어로 하나씩 바꾸는 방식은 피한다. 핵심 평가 한 곳은 보존하고, 나머지는 같은 문장에 이미 적힌 구체적 대상·영향을 직접 서술해 반복 수식을 걷어낸다. 예를 들어 “심각한 X가 Y를 초래할 수 있다”는 X를 가볍다고 낮추지 말고 “X가 이어지면 Y로 번질 수 있다”처럼 이미 있는 조건과 결과로 강도를 표현한다. 부정, 가능성, 우려, 단정의 강도는 원문과 같아야 한다.`);
    } else if (item.code === 'repeated_conclusion_markers') {
      lines.push(`- ${target}: ‘결국·이처럼·종합하면’의 반복을 다른 결론 표지로 교체하지 않는다. 필요한 결론 표지 한 곳만 남기고 나머지는 원래 결론 명제를 바로 시작하되, 결론 자체는 삭제하지 않는다.`);
    } else if (item.code === 'overstructured_causal_closure') {
      lines.push(`- ${target}: 매 문단을 ‘원인→결과→이를 통해 배운 점’으로 다시 닫지 않는다. 원문에 있던 인과와 판단은 유지하되, 일부 문장은 관찰·행동·결과를 직접 끝맺어 동일한 교훈형 골격의 반복을 줄인다.`);
    } else if (item.code === 'topic_restart_after_conclusion') {
      lines.push(`- ${target}: 앞 결론 뒤에 별개의 글처럼 새 탐구를 시작하지 않는다. 두 주제의 원래 순서와 내용을 보존하면서, SOURCE에 근거가 있는 연결 기준만 짧게 밝혀 다음 문단으로 잇는다.`);
    }
  }
  lines.push('대상 번호 밖의 문장을 억지로 바꾸어 감축 횟수를 채우지 않는다.');
  return lines.join('\n');
}

/**
 * 담화 개선 미달이 남았을 때 실제로 같은 상투 구조가 잔존한 원문 문장
 * 번호를 돌려준다. 일반 깊이 대상과 한 목록으로만 섞으면 앞쪽의 쉬운
 * 문장부터 재시도하고 정작 강한 수식·반복 결론 문장은 건드리지 않는
 * 문제가 생겼다. 원문 문장을 현재 결과의 1:N 정렬 결과와 대조해 우선
 * 회복 대상을 좁힌다.
 */
function unresolvedRemediationSentenceOrdinals(source, outputText, plan = null) {
  const selectedPlan = plan || buildRemediationPlan(source);
  const categories = Array.isArray(selectedPlan?.categories) ? selectedPlan.categories : [];
  if (!categories.length) return [];
  const sourceSentences = splitSentences(String(source || ''));
  const outputSentences = splitSentences(String(outputText || ''));
  const outputProfile = buildDiscourseProfile(outputText);
  const unresolved = [];
  for (const category of categories) {
    if (remediationMetric(outputProfile, category.code) <= 0) continue;
    const categoryOrdinals = uniqueNumbers(category.sentenceOrdinals || [])
      .filter(ordinal => ordinal >= 1 && ordinal <= sourceSentences.length);
    const matched = [];
    for (const ordinal of categoryOrdinals) {
      const sourceIndex = ordinal - 1;
      const alignment = alignSourceSentence(
        sourceSentences[sourceIndex],
        sourceIndex,
        sourceSentences.length,
        outputSentences,
        { window: 3, maxOutputGroup: 2 }
      );
      if (alignment?.text && sentenceMatchesRemediationCategory(alignment.text, category.code)) {
        matched.push(ordinal);
      }
    }
    unresolved.push(...(matched.length ? matched : categoryOrdinals));
  }
  return uniqueNumbers(unresolved).sort((left, right) => left - right);
}

function sentenceMatchesRemediationCategory(value, code) {
  const sentence = String(value || '');
  if (code === 'reflection_formula') {
    return REFLECTION_PATTERNS.some(pattern => matchesPattern(sentence, pattern));
  }
  if (code === 'stacked_strong_modifiers') {
    return STRONG_MODIFIER_PATTERNS.some(pattern => matchesPattern(sentence, pattern));
  }
  if (code === 'repeated_conclusion_markers') return matchesPattern(sentence, CONCLUSION_PATTERN);
  if (code === 'overstructured_causal_closure') {
    return matchesPattern(sentence, CAUSAL_PATTERN)
      && (
        REFLECTION_PATTERNS.some(pattern => matchesPattern(sentence, pattern))
        || matchesPattern(sentence, CONCLUSION_PATTERN)
      );
  }
  if (code === 'topic_restart_after_conclusion') {
    RESTART_OPENING_PATTERN.lastIndex = 0;
    return RESTART_OPENING_PATTERN.test(sentence.trim());
  }
  return false;
}

function remediationTargetTerms(value, categories = []) {
  const codes = new Set((categories || []).map(item => String(item?.code || item || '')));
  const terms = [];
  if (codes.has('stacked_strong_modifiers')) {
    for (const pattern of STRONG_MODIFIER_PATTERNS) {
      terms.push(...(String(value || '').match(new RegExp(pattern.source, pattern.flags)) || []));
    }
  }
  return [...new Set(terms.map(item => String(item || '').trim()).filter(Boolean))];
}

function remediationCategoryCount(value, code) {
  return remediationMetric(buildDiscourseProfile(value), code);
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
  if (layoutStructure.isKnownHeadingLine(clean) && clean.length <= 140) {
    return paragraphProfile(index, clean, ['heading'], 'heading');
  }
  const reflectionCount = REFLECTION_PATTERNS.reduce((sum, pattern) => sum + countPattern(clean, pattern), 0);
  const conclusionCount = countPattern(clean, CONCLUSION_PATTERN);
  const activityCount = countPattern(clean, ACTIVITY_PATTERN);
  const roles = [];
  if (activityCount > 0) roles.push('activity');
  if (reflectionCount > 0 || matchesPattern(clean, REFLECTION_FUNCTION_PATTERN)) roles.push('reflection');
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
    // 이미 성찰·결론 기능을 가진 문단 안에서 표현만 바뀐 것은 역할 이동이
    // 아니다. 설명·활동 문단의 주된 기능 자체가 성찰·결론으로 바뀐 경우만 센다.
    if (['reflection', 'conclusion'].includes(sourceParagraph.primaryRole)) return;
    // 원문 문단에 이미 감정·판단·성찰 기능이 있으면 `돌아보면`, `이처럼`,
    // `결국` 같은 연결 표지 하나가 생겨도 문단 역할 자체가 바뀐 것이 아니다.
    if (matchesPattern(sourceParagraph.text, SOURCE_EVALUATION_EVIDENCE_PATTERN)) return;
    if (outputParagraph.primaryRole === 'reflection') {
      const sourceReflection = Number(sourceParagraph.reflectionCount || 0);
      const outputReflection = Number(outputParagraph.reflectionCount || 0);
      if (outputReflection > sourceReflection
          || (matchesPattern(outputParagraph.text, REFLECTION_FUNCTION_PATTERN)
            && !matchesPattern(sourceParagraph.text, REFLECTION_FUNCTION_PATTERN))) count += 1;
      return;
    }
    if (outputParagraph.primaryRole === 'conclusion'
        && matchesPattern(outputParagraph.text, CONCLUSION_PREDICATE_PATTERN)
        && !matchesPattern(sourceParagraph.text, CONCLUSION_PREDICATE_PATTERN)) count += 1;
  });
  return count;
}

function countNovelReflectionFunctions(source, outputText) {
  const sourceParagraphs = splitParagraphs(source);
  const outputParagraphs = splitParagraphs(outputText);
  let count = 0;
  if (sourceParagraphs.length === outputParagraphs.length && sourceParagraphs.length > 0) {
    outputParagraphs.forEach((paragraph, index) => {
      const formulaCount = reflectionFormulaCount(paragraph);
      if (!formulaCount) return;
      const sourceParagraph = sourceParagraphs[index] || '';
      // 해당 원문 문단에 이미 성찰·판단 기능이 있으면 상투 표현 빈도
      // 증가는 자연성 개선 대상일 수는 있어도 새 평가 사실은 아니다.
      if (hasSourceEvaluationFunction(sourceParagraph)) return;
      count += formulaCount;
    });
    return count;
  }

  const sourceSentences = splitSentences(source);
  const outputSentences = splitSentences(outputText);
  outputSentences.forEach((sentence, index) => {
    const formulaCount = reflectionFormulaCount(sentence);
    if (!formulaCount) return;
    const alignment = alignSourceSentence(
      sentence,
      index,
      outputSentences.length,
      sourceSentences,
      { window: 8, maxOutputGroup: 3 }
    );
    const alignedSource = Number(alignment?.score || 0) >= 0.2
      ? String(alignment?.text || '')
      : '';
    if (hasSourceEvaluationFunction(alignedSource)) return;
    count += formulaCount;
  });
  return count;
}

function countScopeExpansionSignals(source, outputText, before, after) {
  const expansionDelta = after.expansionConstructionCount - before.expansionConstructionCount;
  if (expansionDelta <= 0) return 0;
  const sourceSentences = splitSentences(source);
  const outputSentences = splitSentences(outputText);
  let detected = 0;
  for (let index = 0; index < outputSentences.length; index += 1) {
    const outputSentence = outputSentences[index];
    const outputExpansionCount = countPattern(outputSentence, EXPANSION_PATTERN);
    if (outputExpansionCount <= 0) continue;
    // “더 이상 X가 아니라”→“X를 넘어”, “도구를 넘어”→“도구에
    // 그치지 않고”처럼 기능이 같은 관계 표지의 치환은 문서 전체 빈도만
    // 세면 범위 확장으로 오인된다. 결과 문장을 대응 원문(최대 1:N)과
    // 비교해 관계 표지와 실제 새 주제 묶음이 함께 늘어난 경우만 잡는다.
    const alignment = alignSourceSentence(
      outputSentence,
      index,
      outputSentences.length,
      sourceSentences,
      { window: 8, maxOutputGroup: 3 }
    );
    const alignedSource = alignment?.score >= 0.2 ? String(alignment.text || '') : '';
    const sourceExpansionCount = countPattern(alignedSource, EXPANSION_PATTERN);
    const excess = Math.max(0, outputExpansionCount - sourceExpansionCount);
    if (!excess) continue;
    const sourceTokens = extractContentTokens(alignedSource);
    const outputTokens = extractContentTokens(outputSentence);
    const novelTokens = [...outputTokens].filter(token => !sourceTokens.has(token));
    const novelScopeTopics = novelTokens.filter(token => SCOPE_TOPIC_TOKENS.has(token));
    const lowAlignmentWithNewCluster = Number(alignment?.score || 0) < 0.24
      && novelTokens.length >= 4
      && novelScopeTopics.length >= 1;
    const alignedNewCluster = novelTokens.length >= 4 && novelScopeTopics.length >= 2;
    if (lowAlignmentWithNewCluster || alignedNewCluster) detected += excess;
  }
  return Math.min(expansionDelta, detected);
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
  compareMacroDiscourse,
  buildMacroDiscoursePlan,
  discoursePromptBlock,
  remediationPromptGuidance,
  unresolvedRemediationSentenceOrdinals,
  remediationTargetTerms,
  remediationCategoryCount,
  introducedReflectionOutputOrdinals,
  introducedStrongModifierOutputOrdinals,
  restoreIntroducedEvaluationSentences,
  restoreIntroducedIntensitySentences
};
