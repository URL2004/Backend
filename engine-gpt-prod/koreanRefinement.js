'use strict';

const { splitSentences, levenshteinDistance } = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');

const VERSION = 2;
const PROFESSIONAL_PROFILES = new Set([
  'resume_application',
  'academic_paper',
  'report_assignment',
  'student_record_teacher'
]);

const ISSUE_DEFINITIONS = Object.freeze({
  missing_sentence_space: {
    weight: 3,
    repairable: true,
    deterministicSafe: true,
    message: '문장부호 뒤 띄어쓰기가 빠진 곳이 있어요.'
  },
  numeric_parenthesis_join: {
    weight: 3,
    repairable: true,
    deterministicSafe: true,
    message: '수량 표기 뒤의 단어가 붙어 있어요.'
  },
  deep_understanding_collocation: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '“깊게 이해”보다 “깊이 이해”가 자연스러운 문맥이 있어요.'
  },
  practice_class_spacing: {
    weight: 2,
    repairable: true,
    deterministicSafe: true,
    message: '“실습 수업”의 띄어쓰기를 확인해 주세요.'
  },
  frequency_quantifier_conflict: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“그때마다”와 “자주”처럼 빈도 표현이 서로 충돌해요.'
  },
  awkward_focus_attachment: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '“어떻게 …지도 중심에 두고”의 초점 연결이 어색해요.'
  },
  quote_attribution_particle_mismatch: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '직접 인용 뒤의 조사와 입장·주장 표현이 자연스럽게 연결되지 않아요.'
  },
  double_topic_chain: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '한 절에 “나는 …은/는”처럼 주제가 겹쳐 주어와 서술어 관계가 어색해요.'
  },
  malformed_question_ending: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '의문·간접의문 어미가 잘못 결합된 것으로 보이는 표현이 있어요.'
  },
  value_participation_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '가치·취지에 “함께하다”가 직접 연결돼 연어가 어색해요.'
  },
  scope_expansion_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '소비·수요·이용 범위를 “넓어지다”로 표현해 결합이 어색해요.'
  },
  professional_register_downgrade: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '장르에 필요한 전문 어휘가 지나치게 일상적인 말로 낮아졌어요.'
  },
  data_document_collocation: {
    weight: 4,
    repairable: true,
    deterministicSafe: false,
    message: '데이터가 보고서·논문을 작성하는 것처럼 연결된 문장의 주어·목적어 관계가 어색해요.'
  },
  feedback_exchange_collocation: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '피드백 자체를 반복했다기보다 주고받은 과정이 드러나도록 연결해야 해요.'
  },
  self_evaluation_repetition: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '자기평가형 결론과 “노력했습니다”가 반복돼 실제 행동이나 근거가 약해 보여요.'
  },
  overloaded_research_action_chain: {
    weight: 2,
    repairable: true,
    deterministicSafe: false,
    message: '한 문장에 연구 행동이 너무 많이 연결돼 주어·서술어 관계와 호흡이 무거워요.'
  },
  repeated_vague_demonstrative: {
    weight: 1,
    repairable: false,
    deterministicSafe: false,
    message: '가리키는 대상이 불분명한 지시 표현이 반복돼요.'
  },
  list_marker_spacing: {
    weight: 2,
    repairable: false,
    deterministicSafe: false,
    message: '목록 기호 뒤 띄어쓰기를 확인해 주세요.'
  }
});

const PARTICLE_AFTER_PAREN = /^(?:은|는|이|가|을|를|의|에|에서|에게|으로|로|와|과|도|만|부터|까지|처럼|보다|라고|라는|라며|하고)(?=$|[가-힣])/u;
const REFERENCE_HEADING_RE = /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|출처|References|Bibliography|Works\s+Cited)$/iu;
const APPENDIX_HEADING_RE = /^(?:부록|Appendix)(?:\s+[A-Za-z0-9가-힣.-]+)?$/iu;
const NEW_UNIT_START_RE = /^(?:그리고|그러나|하지만|또한|따라서|한편|반면|이러한|이번|다음|첫째|둘째|셋째|마지막으로)(?=$|\s)/u;
const HADA_NOUNS = [
  '구성', '재구성', '분석', '탐구', '조사', '연구', '설명', '정리', '확인', '검토',
  '수행', '제시', '진행', '활용', '비교', '평가', '측정', '고려', '이해', '해석', '관찰',
  '파악', '적용', '제안', '계획', '실천', '선택', '작성', '참여', '기록', '발표', '발견',
  '추론', '복원', '판단'
];
const DURING_NOUNS = [
  '수업', '회의', '작업', '사용', '진행', '탐구', '학습', '근무', '운전', '공사', '시험', '준비', '치료', '상담', '통화', '출장', '여행'
];

/**
 * 의미 심사 후에도 안전하게 실행할 수 있는 형식 보정이다.
 * 문자의 순서나 내용은 바꾸지 않고 공백만 추가·삭제한다.
 * 논문명·인용·참고문헌·표·코드와 창작문 행갈이는 보호한다.
 */
function applySafeFormattingRepairs({ source = '', outputText = '', documentProfile = null } = {}) {
  const before = String(outputText || '');
  const context = formattingContext(documentProfile);
  if (!before || context.creative) {
    return emptyFormattingResult(before, context.creative ? 'creative_line_structure' : 'empty');
  }

  const boundary = repairBrokenProseBoundaries(before, context);
  const spacing = repairContextualSpacing(boundary.text, source, context);
  const changeCounts = mergeChangeCounts(boundary.changeCounts, spacing.changeCounts);
  const changeCodes = Object.keys(changeCounts).filter(code => changeCounts[code] > 0);
  return {
    version: 1,
    text: spacing.text,
    applied: spacing.text !== before,
    changeCount: Object.values(changeCounts).reduce((sum, count) => sum + count, 0),
    changeCodes,
    changeCounts,
    brokenLineBreakRepairCount: Number(changeCounts.broken_prose_linebreak || 0),
    brokenParagraphBreakRepairCount: Number(changeCounts.broken_prose_paragraph_break || 0),
    excessiveBlankLineRepairCount: Number(changeCounts.excess_blank_lines || 0),
    contextualSpacingRepairCount: changeCodes
      .filter(code => !['broken_prose_linebreak', 'broken_prose_paragraph_break', 'excess_blank_lines'].includes(code))
      .reduce((sum, code) => sum + Number(changeCounts[code] || 0), 0),
    skipped: false,
    reason: '',
    profile: context.profile
  };
}

function repairBrokenProseBoundaries(value, context) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const guards = buildLineGuards(lines);
  const counts = {};
  let output = '';
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next >= lines.length) {
      output += current;
      if (index < lines.length - 1) output += '\n'.repeat(lines.length - index - 1);
      break;
    }

    const boundarySize = next - index;
    const join = !guards[index]?.protected
      && !guards[next]?.protected
      && isBrokenProseBoundary(current, lines[next]);
    if (join) {
      output += `${current.trimEnd()} `;
      lines[next] = lines[next].trimStart();
      addCount(counts, boundarySize >= 2 ? 'broken_prose_paragraph_break' : 'broken_prose_linebreak');
    } else {
      output += current;
      const capped = Math.min(boundarySize, 2);
      output += '\n'.repeat(capped);
      if (boundarySize > 2 && !guards[index]?.code && !guards[next]?.code) {
        addCount(counts, 'excess_blank_lines', boundarySize - capped);
      }
    }
    index = next;
  }
  return { text: output, changeCounts: counts };
}

function isBrokenProseBoundary(leftValue, rightValue) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!left || !right) return false;
  if (isStandaloneStructureLine(left) || isStandaloneStructureLine(right)) return false;
  if (/[.!?。！？…,:;：；]\s*[”’》』〉》"')\]]*$/u.test(left)) return false;
  if (!/^[A-Za-z가-힣("'“‘]/u.test(right) || NEW_UNIT_START_RE.test(right)) return false;
  const token = (left.replace(/[”’》』〉》"')\]]+$/u, '').match(/[가-힣]+$/u) || [''])[0];
  if (!token) return false;
  if (token.length >= 2 && /(?:을|를)$/u.test(token)) return true;
  if (token.length >= 3 && /(?:은|는|이|가)$/u.test(token)) return true;
  if (/(?:하는|되는|된|할|했던|위한|대한|관한|필요한|가능한)$/u.test(token)) return true;
  return /^(?:수|및|그리고|그러나|하지만|또한|때문에|위해|통해)$/u.test(token);
}

function repairContextualSpacing(value, source, context) {
  const lines = String(value || '').split('\n');
  const guards = buildLineGuards(lines);
  const sourceTitle = firstDocumentTitle(source);
  const counts = {};
  const repaired = lines.map((line, index) => {
    const guard = guards[index] || {};
    if (guard.code || guard.reference || guard.table) return line;
    const protectWholeTitle = guard.title && sourceTitle && normalizeForTitle(line) === normalizeForTitle(sourceTitle);
    if (protectWholeTitle) return line;
    return replaceOutsideProtectedRanges(line, segment => {
      let out = segment;
      out = replaceTracked(out, /([.!?。！？])(?=[가-힣])/gu, (_match, mark) => `${mark} `, 'missing_sentence_space', counts);
      out = replaceTracked(out, /(\d+(?:[.,]\d+)?(?:가지|개|명|건|번|년|월|일|%|％|점|배|시간|분)[)）])([가-힣]{1,20})/gu, (match, left, right) => {
        return PARTICLE_AFTER_PAREN.test(right) ? match : `${left} ${right}`;
      }, 'numeric_parenthesis_join', counts);
      out = replaceTracked(
        out,
        /보여(?=(?:주(?=$|[가-힣])|(?:준|줄|줬|줘|줍|줌)(?=$|[^A-Za-z0-9_])))/gu,
        () => '보여 ',
        'show_auxiliary_spacing',
        counts
      );
      out = replaceTracked(out, /(^|[^가-힣A-Za-z0-9_])한걸음(?=(?:에서|으로|부터|까지|은|는|이|가|을|를|의|에|로|와|과|도|만)?(?:$|[^가-힣A-Za-z0-9_]))/gu, (_match, prefix) => `${prefix}한 걸음`, 'one_step_spacing', counts);
      out = replaceTracked(out, /실습[ \t]*수업/gu, () => '실습 수업', 'practice_class_spacing', counts);
      out = replaceTracked(out, /지속[ \t]*이용[ \t]*의도/gu, () => '지속 이용 의도', 'continued_use_intent_spacing', counts);
      out = replaceTracked(out, /(^|[^가-힣A-Za-z0-9_])가치소비(?=(?:에서|으로|부터|까지|은|는|이|가|을|를|의|에|로|와|과|도|만)?(?:$|[^가-힣A-Za-z0-9_]))/gu, (_match, prefix) => `${prefix}가치 소비`, 'value_consumption_spacing', counts);
      const during = new RegExp(`(^|[^가-힣A-Za-z0-9_])(${DURING_NOUNS.join('|')})중(?=(?:은|는|이|가|을|를|에|에서|에도|에는|의|으로|로|부터|까지|인|이었|이다|$|[^가-힣]))`, 'gu');
      out = replaceTracked(out, during, (_match, prefix, noun) => `${prefix}${noun} 중`, 'dependent_noun_jung_spacing', counts);
      const hada = new RegExp(`(^|[^가-힣A-Za-z0-9_])(${HADA_NOUNS.join('|')})[ \\t]+하(?=(?:였|고|며|는|여|도록|기|자|다|려고|려|면|게|지))`, 'gu');
      out = replaceTracked(out, hada, (_match, prefix, noun) => `${prefix}${noun}하`, 'noun_hada_spacing', counts);
      return out;
    });
  });
  return { text: repaired.join('\n'), changeCounts: counts };
}

function buildLineGuards(lines) {
  const guards = [];
  const plainTableLines = detectPlainTextTableLines(lines);
  let code = false;
  let reference = false;
  const firstContent = lines.findIndex(line => String(line || '').trim());
  const nextContentAfter = index => {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (String(lines[cursor] || '').trim()) return { text: String(lines[cursor]).trim() };
    }
    return null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index] || '').trim();
    const fence = /^(?:```|~~~)/u.test(text);
    if (fence) code = !code;
    if (APPENDIX_HEADING_RE.test(text)) reference = false;
    if (REFERENCE_HEADING_RE.test(text)) reference = true;
    const role = text ? layoutStructure.classifyLine(text, {
      firstContent: index === firstContent,
      next: nextContentAfter(index),
      blankBefore: index === 0 || !String(lines[index - 1] || '').trim()
    }) : 'blank';
    const nextContent = nextContentAfter(index)?.text || '';
    const brokenTitleFragment = role === 'title' && isBrokenProseBoundary(text, nextContent);
    guards.push({
      code,
      reference,
      role,
      title: role === 'title',
      table: role === 'table' || plainTableLines.has(index),
      protected: code || reference || plainTableLines.has(index)
        || ((!brokenTitleFragment) && ['title', 'heading', 'label', 'label_inline', 'list', 'table', 'quote'].includes(role))
    });
  }
  return guards;
}

/**
 * 워드·PDF에서 복사한 표는 파이프나 탭 없이 `표 N. 제목` 다음에 셀마다
 * 한 줄씩 놓이는 경우가 많다. 개별 셀을 산문으로 오인해 합치지 않도록,
 * 표 캡션 다음의 선택적 빈 줄과 표 본문을 첫 문단 경계까지 보호한다.
 */
function detectPlainTextTableLines(lines) {
  const protectedLines = new Set();
  let inTable = false;
  let seenBody = false;
  let pendingBlank = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index] || '').trim();
    if (!inTable && /^표\s*[0-9A-Za-z가-힣.-]+(?:\s|$)/u.test(text)) {
      inTable = true;
      seenBody = false;
      pendingBlank = [];
      protectedLines.add(index);
      continue;
    }
    if (!inTable) continue;
    if (!text) {
      if (seenBody) {
        inTable = false;
        seenBody = false;
        pendingBlank = [];
        continue;
      }
      pendingBlank.push(index);
      if (pendingBlank.length >= 2) {
        inTable = false;
        seenBody = false;
        pendingBlank = [];
      }
      continue;
    }
    for (const blankIndex of pendingBlank) protectedLines.add(blankIndex);
    pendingBlank = [];
    protectedLines.add(index);
    seenBody = true;
  }
  return protectedLines;
}

function isStandaloneStructureLine(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  const role = layoutStructure.classifyLine(text);
  if (['heading', 'label', 'label_inline', 'list', 'table', 'quote'].includes(role)) return true;
  return /^(?:\(?\d{1,3}\)?[.)]\s+|[IVXLCDM]+ ?[.)]\s+|[①-⑳]\s*)/iu.test(text);
}

function replaceOutsideProtectedRanges(line, transform) {
  const ranges = inlineProtectedRanges(line);
  if (!ranges.length) return transform(line);
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) output += transform(line.slice(cursor, range.start));
    output += line.slice(range.start, range.end);
    cursor = range.end;
  }
  if (cursor < line.length) output += transform(line.slice(cursor));
  return output;
}

function inlineProtectedRanges(line) {
  const patterns = [
    /https?:\/\/[^\s<>()]+/giu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    /`[^`\n]+`/gu,
    /\[[^\]\n]+\]\([^\n)]+\)/gu,
    /[「『〈《“‘][^」』〉》”’\n]{1,240}[」』〉》”’]/gu,
    /"[^"\n]{1,240}"/gu,
    /'[^'\n]{1,240}'/gu
  ];
  const ranges = [];
  for (const pattern of patterns) {
    for (const match of String(line || '').matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function firstDocumentTitle(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const firstIndex = lines.findIndex(line => String(line || '').trim());
  if (firstIndex < 0) return '';
  const text = lines[firstIndex].trim();
  const next = lines.slice(firstIndex + 1).map(line => String(line || '').trim()).find(Boolean);
  const role = layoutStructure.classifyLine(text, {
    firstContent: true,
    next: next ? { text: next } : null,
    blankBefore: true
  });
  return role === 'title' ? text : '';
}

function formattingContext(documentProfile) {
  const profile = profileName(documentProfile);
  const flags = new Set(documentProfile?.formatProfile?.flags || []);
  return {
    profile,
    creative: profile === 'creative' || flags.has('creative_lines') || flags.has('line_sensitive')
  };
}

function replaceTracked(text, pattern, replacement, code, counts) {
  return String(text || '').replace(pattern, (...args) => {
    const before = args[0];
    const after = replacement(...args);
    if (after !== before) addCount(counts, code);
    return after;
  });
}

function addCount(counts, code, amount = 1) {
  counts[code] = (counts[code] || 0) + Number(amount || 0);
}

function mergeChangeCounts(...items) {
  const merged = {};
  for (const item of items) {
    for (const [code, count] of Object.entries(item || {})) addCount(merged, code, count);
  }
  return merged;
}

function normalizeForTitle(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function emptyFormattingResult(text, reason) {
  return {
    version: 1,
    text: String(text || ''),
    applied: false,
    changeCount: 0,
    changeCodes: [],
    changeCounts: {},
    brokenLineBreakRepairCount: 0,
    brokenParagraphBreakRepairCount: 0,
    excessiveBlankLineRepairCount: 0,
    contextualSpacingRepairCount: 0,
    skipped: true,
    reason,
    profile: ''
  };
}

function analyzeKoreanRefinement({ source = '', outputText = '', documentProfile = null, mode = '' } = {}) {
  const profile = profileName(documentProfile);
  const sourceIssues = detectTextIssues(source, { profile, includeSourceNotation: true });
  const outputIssues = detectTextIssues(outputText, { profile, includeSourceNotation: false });
  const professional = detectProfessionalDowngrade(source, outputText, profile);
  if (professional) outputIssues.push(professional);
  const rows = mergeIssueComparison(sourceIssues, outputIssues);
  const repairableIssues = rows.filter(item => item.afterCount > 0 && item.repairable);
  const residualWarnings = rows
    .filter(item => item.afterCount > 0)
    .map(item => qualityWarning(item));
  return {
    version: VERSION,
    profile,
    mode: String(mode || ''),
    pass: repairableIssues.length === 0,
    issueCount: rows.reduce((sum, item) => sum + item.afterCount, 0),
    repairableIssueCount: repairableIssues.reduce((sum, item) => sum + item.afterCount, 0),
    introducedIssueCount: rows.reduce((sum, item) => sum + item.introducedCount, 0),
    weightedRisk: rows.reduce((sum, item) => sum + item.afterCount * item.weight, 0),
    issueCodes: rows.filter(item => item.afterCount > 0).map(item => item.code),
    repairableCodes: repairableIssues.map(item => item.code),
    issues: rows,
    repairableIssues,
    residualWarnings,
    sourceReviewWarnings: buildSourceReviewWarnings(sourceIssues)
  };
}

function detectTextIssues(value, { profile = 'unknown', includeSourceNotation = false } = {}) {
  const text = String(value || '').replace(/\r\n?/gu, '\n');
  const issues = [];
  pushPatternIssue(issues, text, 'missing_sentence_space', /[.!?。！？](?=[가-힣])/gu);
  pushNumericParenthesisIssue(issues, text);
  pushPatternIssue(issues, text, 'deep_understanding_collocation', /깊게\s+이해(?:하|했|되|할|하려|하고|하며|해서|해)/gu);
  pushPatternIssue(issues, text, 'practice_class_spacing', /실습수업/gu);
  pushSentenceIssue(issues, text, 'frequency_quantifier_conflict', sentence => /(?:그때마다|매번)[^.!?。！？\n]{0,90}(?:자주|종종|가끔)/u.test(sentence));
  pushSentenceIssue(issues, text, 'awkward_focus_attachment', sentence => /어떻게[^.!?。！？\n]{0,70}(?:지도|지를)\s*중심에\s*두고/u.test(sentence));
  pushSentenceIssue(issues, text, 'quote_attribution_particle_mismatch', hasQuoteAttributionParticleMismatch);
  pushSentenceIssue(issues, text, 'double_topic_chain', hasDoubleTopicChain);
  pushPatternIssue(issues, text, 'malformed_question_ending', /저는지/gu);
  pushSentenceIssue(issues, text, 'value_participation_collocation', hasValueParticipationCollocation);
  pushSentenceIssue(issues, text, 'scope_expansion_collocation', hasScopeExpansionCollocation);
  pushSentenceIssue(issues, text, 'data_document_collocation', hasDataDocumentCollocation);
  pushSentenceIssue(issues, text, 'feedback_exchange_collocation', sentence => /피드백(?:을|를)?\s*(?:여러\s*차례\s*)?반복(?:하|했|해|하며|해서|하고)/u.test(sentence));
  pushSelfEvaluationRepetition(issues, text);
  if (/(?:연구|실험|공정|시편|분석\s*장비)/u.test(text)) {
    pushSentenceIssue(issues, text, 'overloaded_research_action_chain', isOverloadedResearchActionChain);
  }
  pushRepeatedVagueDemonstrative(issues, text);
  if (includeSourceNotation) {
    pushPatternIssue(issues, text, 'list_marker_spacing', /^(?:[-*•▪◦]|\d+[.)])(?=\S)/gmu);
  }
  return mergeSameCode(issues).map(item => ({ ...item, profile }));
}

function applySafeDeterministicRepairs({ source = '', outputText = '', documentProfile = null } = {}) {
  const before = String(outputText || '');
  let text = before;
  const changes = [];
  text = replaceAndCount(text, /([.!?。！？])(?=[가-힣])/gu, '$1 ', 'missing_sentence_space', changes);
  text = replaceAndCount(text, /실습수업/gu, '실습 수업', 'practice_class_spacing', changes);
  text = text.replace(/(\d+(?:[.,]\d+)?(?:가지|개|명|건|번|년|월|일|%|％|점|배|시간|분)[)）])([가-힣]{1,20})/gu, (match, left, right) => {
    if (PARTICLE_AFTER_PAREN.test(right)) return match;
    changes.push('numeric_parenthesis_join');
    return `${left} ${right}`;
  });
  const sourceHasDeepCollocation = /깊게\s+이해(?:하|했|되|할|하려|하고|하며|해서|해)/u.test(String(source || ''));
  if (!sourceHasDeepCollocation) {
    text = replaceAndCount(
      text,
      /깊게(?=\s+이해(?:하|했|되|할|하려|하고|하며|해서|해))/gu,
      '깊이',
      'deep_understanding_collocation',
      changes
    );
  }
  return {
    version: VERSION,
    text,
    applied: text !== before,
    changeCount: changes.length,
    changeCodes: [...new Set(changes)],
    profile: profileName(documentProfile)
  };
}

function isImprovedAudit(before, after) {
  if (!before || !after) return false;
  if (after.weightedRisk < before.weightedRisk) return true;
  if (after.repairableIssueCount < before.repairableIssueCount && after.introducedIssueCount <= before.introducedIssueCount) return true;
  return false;
}

function buildSourceReviewWarnings(sourceOrIssues, documentProfile = null) {
  const issues = Array.isArray(sourceOrIssues)
    ? sourceOrIssues
    : detectTextIssues(sourceOrIssues, { profile: profileName(documentProfile), includeSourceNotation: true });
  return issues.map(item => ({
    code: item.code,
    severity: 'notice',
    message: sourceReviewMessage(item.code),
    count: item.count,
    sentenceOrdinals: item.sentenceOrdinals || []
  }));
}

function detectProfessionalDowngrade(source, outputText, profile) {
  const before = String(source || '');
  const after = String(outputText || '');
  const mappings = [
    { formal: /(?:설계|구성)/gu, casual: /(?:흐름|순서|구성안)[^.!?\n]{0,18}(?:짰|짜고|짜며)/gu },
    { formal: /(?:역량|능력)/gu, casual: /(?:전달|정리|달성|해낼)\s*(?:하는|할)?\s*힘(?:을|이|도)?/gu },
    { formal: /피드백/gu, casual: /(?:AI|인공지능|도구)(?:가|에서)?\s*(?:준|준다는|준다고)/gu },
    { formal: /교류/gu, casual: /(?:학생|사람|동료)들과?\s*(?:어울|놀)/gu },
    { formal: /근무/gu, casual: /(?:다시\s*)?일한\s+[^.!?\n]{0,16}(?:아르바이트|매장|회사)/gu },
    { formal: /(?:분석|조사|검토)/gu, casual: /(?:기사|뉴스|자료|데이터)를?\s*(?:함께\s*)?(?:봤|보며|봐서)/gu }
  ];
  let count = 0;
  const concepts = [];
  const sentenceOrdinals = [];
  const alignedLosses = detectAlignedProfessionalLosses(before, after);
  for (const loss of alignedLosses) {
    count += 1;
    concepts.push(loss.concept);
    sentenceOrdinals.push(loss.sourceOrdinal);
  }
  if (PROFESSIONAL_PROFILES.has(profile)) {
    for (const mapping of mappings) {
      const sourceFormal = countMatches(before, mapping.formal);
      const outputFormal = countMatches(after, mapping.formal);
      const sourceCasual = countMatches(before, mapping.casual);
      const outputCasual = countMatches(after, mapping.casual);
      if (sourceFormal > 0 && outputFormal === 0 && outputCasual > sourceCasual) {
        count += outputCasual - sourceCasual;
        concepts.push(mapping.formal.source);
      }
    }
  }
  if (!count) return null;
  return makeIssue('professional_register_downgrade', count, sentenceOrdinals, {
    concepts: [...new Set(concepts)].slice(0, 12),
    alignedLosses: alignedLosses.slice(0, 12)
  });
}

const PROFESSIONAL_CONCEPT_RULES = Object.freeze([
  {
    concept: 'improvement_requirement',
    source: /(?:개선|보완)(?:이|가)?\s*(?:필요(?:하|한|했|했던)|해야\s*할)/u,
    acceptable: /(?:개선|보완)(?:이|가)?\s*(?:필요(?:하|한|했|했던)|해야\s*할)|(?:개선|보완)할\s*(?:부분|사항|지점)/u,
    preferred: ['개선이 필요한 부분', '보완할 사항']
  },
  {
    concept: 'assigned_task_performance',
    source: /(?:주어진|담당한|요구된)[^.!?。！？\n]{0,24}(?:작업|업무|과제)(?:만)?(?:을|를)?\s*(?:수행|이행|완수)/u,
    acceptable: /(?:주어진|담당한|요구된)[^.!?。！？\n]{0,24}(?:작업|업무|과제)(?:만)?(?:을|를)?\s*(?:수행|이행|완수|처리)/u,
    preferred: ['주어진 작업을 수행', '담당 업무를 이행']
  },
  {
    concept: 'standards_familiarity',
    source: /(?:검사|평가|업무|안전|품질)[^.!?。！？\n]{0,12}기준(?:을|를)?\s*(?:숙지|준수|파악|정확히\s*이해)/u,
    acceptable: /(?:검사|평가|업무|안전|품질)[^.!?。！？\n]{0,12}기준(?:을|를)?\s*(?:숙지|준수|파악|정확히\s*이해)/u,
    preferred: ['검사 기준을 숙지', '품질 기준을 정확히 이해']
  },
  {
    concept: 'objective_stance',
    source: /객관적(?:으로|인\s*(?:관점|시선|태도|분석))/u,
    acceptable: /객관적(?:으로|인\s*(?:관점|시선|태도|분석))/u,
    preferred: ['객관적으로', '객관적인 관점에서']
  },
  {
    concept: 'process_optimization',
    source: /(?:공정\s*조건(?:을|를)?\s*최적화|공정\s*최적화|최적\s*조건(?:을|를)?\s*도출)/u,
    acceptable: /(?:공정[^.!?]{0,24}최적화|최적\s*(?:공정|조건)[^.!?]{0,20}(?:도출|찾|선정))/u,
    preferred: ['공정 조건을 최적화', '최적 조건을 도출']
  },
  {
    concept: 'structure_performance_correlation',
    source: /(?:구조[^.!?]{0,24}성능[^.!?]{0,16}(?:상관관계|상관성)|(?:상관관계|상관성)[^.!?]{0,24}구조[^.!?]{0,24}성능)/u,
    acceptable: /(?:구조[^.!?]{0,24}성능[^.!?]{0,16}(?:상관관계|상관성)|(?:상관관계|상관성)[^.!?]{0,24}구조[^.!?]{0,24}성능)/u,
    preferred: ['구조와 성능 간 상관관계', '구조·성능의 상관성']
  },
  {
    concept: 'cause_analysis',
    source: /원인(?:을|를)?\s*(?:분석|규명|파악)/u,
    acceptable: /원인(?:을|를)?\s*(?:분석|규명|파악)/u,
    preferred: ['원인을 분석', '원인을 규명']
  },
  {
    concept: 'reproducibility_verification',
    source: /재현성(?:을|를)?\s*(?:검증|평가|확보)/u,
    acceptable: /재현성(?:을|를)?\s*(?:검증|평가|확보)/u,
    preferred: ['재현성을 검증', '재현성을 확보']
  },
  {
    concept: 'quantitative_analysis',
    source: /(?:수치화|정량화|정량\s*분석)/u,
    acceptable: /(?:수치화|정량화|정량\s*분석)/u,
    preferred: ['수치화', '정량화']
  },
  {
    concept: 'data_interpretation',
    source: /데이터\s*해석/u,
    acceptable: /(?:데이터|측정\s*결과|분석\s*결과)[^.!?]{0,18}해석|해석[^.!?]{0,18}(?:데이터|측정\s*결과|분석\s*결과)/u,
    preferred: ['데이터 해석', '측정 결과를 해석']
  }
]);

function detectAlignedProfessionalLosses(source, outputText) {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(outputText || '')).map(value => String(value || '').trim()).filter(Boolean);
  if (!sourceSentences.length || !outputSentences.length) return [];
  const losses = [];
  sourceSentences.forEach((sentence, sourceIndex) => {
    for (const rule of PROFESSIONAL_CONCEPT_RULES) {
      if (!patternMatchesLocal(rule.source, sentence)) continue;
      const aligned = alignedOutputCandidates(sentence, sourceIndex, sourceSentences.length, outputSentences);
      const bestScore = Number(aligned[0]?.score || 0);
      const retained = aligned.some((item, index) => patternMatchesLocal(rule.acceptable, item.sentence)
        && (index === 0 || (item.score >= 0.35 && item.score >= bestScore - 0.04)));
      if (retained) continue;
      const best = aligned[0] || { index: -1, sentence: '', score: 0 };
      losses.push({
        concept: rule.concept,
        sourceOrdinal: sourceIndex + 1,
        outputOrdinal: best.index >= 0 ? best.index + 1 : 0,
        preferred: rule.preferred,
        sourceSentence: sentence.slice(0, 220),
        outputSentence: best.sentence.slice(0, 220)
      });
    }
  });
  return losses;
}

function alignedOutputCandidates(sourceSentence, sourceIndex, sourceCount, outputSentences) {
  const center = sourceCount <= 1
    ? 0
    : Math.round(sourceIndex * Math.max(0, outputSentences.length - 1) / Math.max(1, sourceCount - 1));
  const candidates = [];
  for (let delta = -2; delta <= 2; delta += 1) {
    const index = center + delta;
    if (index < 0 || index >= outputSentences.length) continue;
    const sentence = outputSentences[index];
    candidates.push({ index, sentence, score: sentenceSimilarity(sourceSentence, sentence) });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function sentenceSimilarity(left, right) {
  const leftTokens = new Set(contentTokensLocal(left));
  const rightTokens = new Set(contentTokensLocal(right));
  const overlap = [...leftTokens].filter(token => rightTokens.has(token)).length / Math.max(1, leftTokens.size);
  const a = normalizeSentenceLocal(left);
  const b = normalizeSentenceLocal(right);
  const edit = 1 - (levenshteinDistance(a, b) / Math.max(1, a.length, b.length));
  return Math.max(overlap, edit * 0.75);
}

function contentTokensLocal(value) {
  return [...new Set((String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}|\d+(?:\.\d+)?/gu) || [])
    .map(token => token.toLowerCase().replace(/(?:하였습니다|했습니다|하였다|했다|에서는|으로는|으로|에서|하고|하며|하여|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u, ''))
    .filter(token => token.length >= 2))];
}

function normalizeSentenceLocal(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/gu, '');
}

function patternMatchesLocal(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
}

function hasDataDocumentCollocation(sentence) {
  const value = String(sentence || '');
  if (/(?:보고서|논문)(?:의\s*)?(?:원고|본문|초안)(?:을|를)?[^.!?。！？\n]{0,18}작성/u.test(value)) return false;
  return /(?:데이터|측정값|실험값|분석\s*결과)(?:은|는|을|를)?[^.!?。！？\n]{0,75}(?:보고서|논문)에\s*(?:직접\s*)?작성/u.test(value);
}

function hasQuoteAttributionParticleMismatch(sentence) {
  return /[”"](?:은|는)\s+(?:입장|견해|의견|결론)(?:을|를)?\s+(?:주장|강조)(?:하|했|해|합|했습|했다)/u
    .test(String(sentence || ''));
}

function hasDoubleTopicChain(sentence) {
  const value = String(sentence || '');
  if (/(?:하면서|하며|통해|후|계기로|과정에서)[^.!?。！？\n]{0,20}(?:나는|저는|우리는|저희는)\s+[^.!?。！？\n]{1,28}(?:은|는)\s/u.test(value)) return true;
  return /^(?:나는|저는|우리는|저희는)\s+(?:이|그|해당|이번|예술|연구|활동|작품|문제)[^.!?。！？\n]{0,18}(?:은|는)\s/u.test(value);
}

function hasValueParticipationCollocation(sentence) {
  return /(?:가치|취지|뜻)에\s*(?:함께\s*하|함께하)/u.test(String(sentence || ''));
}

function hasScopeExpansionCollocation(sentence) {
  return /(?:소비|수요|이용|사용)(?:가|는|이)\s*(?:더\s*)?(?:넓어지|넓어질|넓어진)/u.test(String(sentence || ''));
}

function pushSelfEvaluationRepetition(issues, text) {
  const sentences = splitSentences(String(text || ''));
  const ordinals = [];
  const pattern = /(?:(?:역량|능력|사고력|전문성|정확도)(?:을|를|도)?[^.!?。！？\n]{0,28}(?:길렀|키웠|갖추었|향상시켰|높였|발전시켰)|(?:기\s*위해|고자)\s*노력했)/u;
  sentences.forEach((sentence, index) => {
    if (pattern.test(String(sentence || ''))) ordinals.push(index + 1);
  });
  if (ordinals.length >= 3) {
    issues.push(makeIssue('self_evaluation_repetition', ordinals.length - 2, ordinals, {
      totalSelfEvaluationSentenceCount: ordinals.length
    }));
  }
}

function isOverloadedResearchActionChain(sentence) {
  const value = String(sentence || '');
  if (normalizeSentenceLocal(value).length < 65) return false;
  const actions = [
    /원인(?:을|를)?\s*(?:분석|규명|파악|짚)/u,
    /(?:실험|공정)\s*조건(?:을|를)?\s*(?:조정|변경|바꾸)/u,
    /반복\s*실험/u,
    /재현성(?:을|를)?\s*(?:검증|확인|평가|확보)/u,
    /(?:비교·분석|비교하고\s*분석|비교\s*분석)/u,
    /(?:실험|연구|분석)[^.!?]{0,16}(?:수행|진행)/u
  ];
  return actions.filter(pattern => patternMatchesLocal(pattern, value)).length >= 4;
}

function pushPatternIssue(issues, text, code, pattern) {
  const matches = [...String(text || '').matchAll(cloneGlobal(pattern))];
  if (!matches.length) return;
  issues.push(makeIssue(code, matches.length, matches.map(match => sentenceOrdinalAt(text, match.index))));
}

function pushNumericParenthesisIssue(issues, text) {
  const pattern = /(\d+(?:[.,]\d+)?(?:가지|개|명|건|번|년|월|일|%|％|점|배|시간|분)[)）])([가-힣]{1,20})/gu;
  const matches = [];
  for (const match of String(text || '').matchAll(pattern)) {
    if (PARTICLE_AFTER_PAREN.test(match[2])) continue;
    matches.push(match);
  }
  if (matches.length) {
    issues.push(makeIssue('numeric_parenthesis_join', matches.length, matches.map(match => sentenceOrdinalAt(text, match.index))));
  }
}

function pushSentenceIssue(issues, text, code, predicate) {
  const sentences = splitSentences(text);
  const ordinals = [];
  sentences.forEach((sentence, index) => {
    if (predicate(String(sentence || ''))) ordinals.push(index + 1);
  });
  if (ordinals.length) issues.push(makeIssue(code, ordinals.length, ordinals));
}

function pushRepeatedVagueDemonstrative(issues, text) {
  const paragraphs = String(text || '').split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean);
  const ordinals = [];
  paragraphs.forEach((paragraph, index) => {
    if (/^(?:이러한|이런|그러한)\s*(?:변화|과정|경험|결과|점|부분)(?:은|는|이|가)/u.test(paragraph)) ordinals.push(index + 1);
  });
  if (ordinals.length >= 2) issues.push(makeIssue('repeated_vague_demonstrative', ordinals.length, ordinals));
}

function mergeIssueComparison(sourceIssues, outputIssues) {
  const before = new Map(sourceIssues.map(item => [item.code, item]));
  const after = new Map(outputIssues.map(item => [item.code, item]));
  const codes = [...new Set([...before.keys(), ...after.keys()])];
  return codes.map(code => {
    const definition = ISSUE_DEFINITIONS[code] || {};
    const sourceItem = before.get(code);
    const outputItem = after.get(code);
    const beforeCount = sourceItem?.count || 0;
    const afterCount = outputItem?.count || 0;
    return {
      code,
      beforeCount,
      afterCount,
      introducedCount: Math.max(0, afterCount - beforeCount),
      resolvedCount: Math.max(0, beforeCount - afterCount),
      weight: definition.weight || 1,
      repairable: definition.repairable === true,
      deterministicSafe: definition.deterministicSafe === true,
      message: definition.message || '한국어 표현을 확인해 주세요.',
      sentenceOrdinals: outputItem?.sentenceOrdinals || [],
      details: outputItem?.details || null
    };
  });
}

function mergeSameCode(items) {
  const merged = new Map();
  for (const item of items || []) {
    if (!merged.has(item.code)) {
      merged.set(item.code, { ...item, sentenceOrdinals: [...(item.sentenceOrdinals || [])] });
      continue;
    }
    const current = merged.get(item.code);
    current.count += item.count || 0;
    current.sentenceOrdinals = [...new Set([...current.sentenceOrdinals, ...(item.sentenceOrdinals || [])])];
  }
  return [...merged.values()];
}

function makeIssue(code, count, sentenceOrdinals = [], details = null) {
  const definition = ISSUE_DEFINITIONS[code] || {};
  return {
    code,
    count: Number(count) || 0,
    sentenceOrdinals: [...new Set((sentenceOrdinals || []).filter(Number.isFinite))],
    repairable: definition.repairable === true,
    deterministicSafe: definition.deterministicSafe === true,
    weight: definition.weight || 1,
    message: definition.message || '한국어 표현을 확인해 주세요.',
    details
  };
}

function qualityWarning(item) {
  return {
    code: `korean_${item.code}`,
    severity: 'warning',
    message: item.message,
    count: item.afterCount,
    introducedCount: item.introducedCount,
    sentenceOrdinals: item.sentenceOrdinals || []
  };
}

function sourceReviewMessage(code) {
  const definition = ISSUE_DEFINITIONS[code];
  const base = definition?.message || '원문의 한국어 표현을 확인해 주세요.';
  return `원문 확인: ${base}`;
}

function replaceAndCount(text, pattern, replacement, code, changes) {
  return String(text || '').replace(pattern, (...args) => {
    changes.push(code);
    if (typeof replacement === 'function') return replacement(...args);
    return replacement.replace(/\$(\d+)/gu, (_match, index) => args[Number(index) - 1] || '');
  });
}

function sentenceOrdinalAt(text, offset) {
  const before = String(text || '').slice(0, Math.max(0, Number(offset) || 0));
  return Math.max(1, splitSentences(before).length || 1);
}

function countMatches(value, pattern) {
  return (String(value || '').match(cloneGlobal(pattern)) || []).length;
}

function cloneGlobal(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function profileName(documentProfile) {
  return String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
}

module.exports = {
  VERSION,
  ISSUE_DEFINITIONS,
  analyzeKoreanRefinement,
  applySafeDeterministicRepairs,
  applySafeFormattingRepairs,
  buildSourceReviewWarnings,
  detectTextIssues,
  detectProfessionalDowngrade,
  isImprovedAudit
};
