'use strict';

const { splitSentences } = require('../engine/koreanText');

const VERSION = 1;
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
  professional_register_downgrade: {
    weight: 3,
    repairable: true,
    deterministicSafe: false,
    message: '장르에 필요한 전문 어휘가 지나치게 일상적인 말로 낮아졌어요.'
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
  pushSentenceIssue(issues, text, 'frequency_quantifier_conflict', sentence => /(?:그때마다|매번)[^.!?。！？\n]{0,90}(?:자주|종종|가끔)/u.test(sentence));
  pushSentenceIssue(issues, text, 'awkward_focus_attachment', sentence => /어떻게[^.!?。！？\n]{0,70}(?:지도|지를)\s*중심에\s*두고/u.test(sentence));
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
  if (!PROFESSIONAL_PROFILES.has(profile)) return null;
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
  if (!count) return null;
  return makeIssue('professional_register_downgrade', count, [], { concepts: concepts.slice(0, 6) });
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
  buildSourceReviewWarnings,
  detectTextIssues,
  detectProfessionalDowngrade,
  isImprovedAudit
};
