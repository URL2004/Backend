'use strict';

const { splitSentences } = require('../engine/koreanText');

const MAX_PARAGRAPH_BARE = 1100;
const MAX_PARAGRAPH_SENTENCES = 12;
const STRUCTURAL_ROLES = new Set(['title', 'heading', 'label', 'label_inline', 'list', 'table', 'quote', 'code', 'legal_clause', 'signature']);
const PROFILE_READABILITY_LIMITS = Object.freeze({
  resume_application: Object.freeze({ maxBare: 420, maxSentences: 5 }),
  student_record: Object.freeze({ maxBare: 480, maxSentences: 6 }),
  student_record_teacher: Object.freeze({ maxBare: 480, maxSentences: 6 }),
  student_self_assessment: Object.freeze({ maxBare: 500, maxSentences: 6 }),
  academic_paper: Object.freeze({ maxBare: 700, maxSentences: 8 }),
  report_assignment: Object.freeze({ maxBare: 650, maxSentences: 7 }),
  long_explainer: Object.freeze({ maxBare: 650, maxSentences: 7 }),
  clinical_record: Object.freeze({ maxBare: 700, maxSentences: 8 }),
  legal_contract: Object.freeze({ maxBare: 700, maxSentences: 8 }),
  general_essay: Object.freeze({ maxBare: 540, maxSentences: 7 }),
  personal_essay: Object.freeze({ maxBare: 540, maxSentences: 7 }),
  blog_review: Object.freeze({ maxBare: 560, maxSentences: 7 }),
  review_blog: Object.freeze({ maxBare: 560, maxSentences: 7 }),
  marketing_ad: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  marketing: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  social_caption: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  social: Object.freeze({ maxBare: 520, maxSentences: 7 }),
  mail_notice: Object.freeze({ maxBare: 560, maxSentences: 7 }),
  general: Object.freeze({ maxBare: 600, maxSentences: 7 }),
  unknown: Object.freeze({ maxBare: 600, maxSentences: 7 })
});

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/gu, '\n');
}

function visibleTrim(value) {
  return String(value || '').replace(/^[\u200B\uFEFF]+|[\u200B\uFEFF]+$/gu, '').trim();
}

function splitExplicitParagraphs(value) {
  return normalizeNewlines(value)
    .split(/\n[ \t]*\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

function buildLineRecords(value) {
  const source = String(value || '');
  const records = [];
  let start = 0;
  let index = 0;
  for (const match of source.matchAll(/\r?\n/gu)) {
    const raw = source.slice(start, match.index);
    records.push({
      index,
      start,
      end: match.index,
      raw,
      text: visibleTrim(raw),
      blank: !visibleTrim(raw),
      role: 'blank'
    });
    start = match.index + match[0].length;
    index += 1;
  }
  const raw = source.slice(start);
  records.push({
    index,
    start,
    end: source.length,
    raw,
    text: visibleTrim(raw),
    blank: !visibleTrim(raw),
    role: 'blank'
  });
  const nonEmpty = records.filter(record => !record.blank);
  const codeIndices = detectCodeLineIndices(records);
  const tableIndices = detectContextTableLineIndices(records, codeIndices);
  const signatureIndices = detectSignatureLineIndices(records, codeIndices);
  const firstContentIndex = nonEmpty[0]?.index ?? -1;
  for (const record of nonEmpty) {
    if (codeIndices.has(record.index)) {
      record.role = 'code';
      continue;
    }
    const position = nonEmpty.findIndex(item => item.index === record.index);
    const previous = position > 0 ? nonEmpty[position - 1] : null;
    const next = position + 1 < nonEmpty.length ? nonEmpty[position + 1] : null;
    const previousRaw = records[record.index - 1] || null;
    record.role = classifyLine(record.text, {
      firstContent: record.index === firstContentIndex,
      previous,
      next,
      blankBefore: record.index === 0 || previousRaw?.blank === true,
      tableLike: tableIndices.has(record.index),
      signatureLike: signatureIndices.has(record.index)
    });
  }
  return records;
}

function classifyLine(value, context = {}) {
  const text = visibleTrim(value);
  if (!text) return 'blank';
  if (legalClauseParts(text)) return 'legal_clause';
  if (context.signatureLike) return 'signature';
  if (isKnownHeadingLine(text)) return 'heading';
  if (context.tableLike || isExplicitTableLine(text)) return 'table';
  if (isListLine(text)) return 'list';
  if (isQuoteLine(text)) return 'quote';
  const label = labelParts(text);
  if (label) return label.rest ? 'label_inline' : 'label';
  if (isGenericTitle(text, context)) return 'title';
  return 'prose';
}

function isKnownHeadingLine(value) {
  const text = visibleTrim(value);
  if (!text || text.length > 140) return false;
  if (/^#{1,6}\s+\S/u.test(text)) return true;
  if (/^[\[【<][^\]】>\n]{1,80}[\]】>]$/u.test(text)) return true;
  if (/^[-–—]\s*(?:서론|본론|결론|초록|요약|목\s*차|참고\s*문헌|참고\s*자료|부록)$/u.test(text)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.)．]?\s*\S.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}[.)]\s*[가-힣A-Za-z]\S*.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}\.(?:19|20)\d{2}년\S*.{0,100}$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)(?:\s+\S.{0,100})?$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?조(?:의\s?\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?$/u.test(text)) return true;
  if (/^(?:서론|본론|결론|초록|요약|연구\s*방법|연구\s*결과|연구\s*가설|분석\s*결과|결과\s*분석|논의|시사점|한계점|제언|부록|목\s*차|참고\s*문헌|결과\s*분석\s*및\s*함의)$/u.test(text)) return true;
  return /^(?:Abstract|Introduction|Methods?|Methodology|Results?|Discussion|Conclusion|References|Appendix)$/iu.test(text);
}

function isGenericTitle(text, context = {}) {
  if (!context.firstContent || !context.next) return false;
  if (text.length < 2 || text.length > 100) return false;
  if (/[.!?。！？]\s*["”’')\]]*$/u.test(text)) return false;
  if (/^(?:https?:|www\.|[A-Za-z]:\\)/iu.test(text)) return false;
  const nextLength = context.next.text.length;
  return context.blankBefore
    && (text.length <= 45 || nextLength >= Math.max(70, Math.ceil(text.length * 1.45)));
}

function labelParts(value) {
  const text = visibleTrim(value);
  const match = text.match(/^(?:[*#]+\s*)?([가-힣A-Za-z][가-힣A-Za-z0-9·/&() _-]{0,48})\s*[:：]\s*(.*)$/u);
  if (!match) return null;
  const label = match[1].trim();
  if (/^(?:https?|ftp|file)$/iu.test(label) || /[.!?。！？]/u.test(label)) return null;
  return { label, rest: match[2].trim() };
}

function isListLine(value) {
  return /^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])\s+\S/u.test(visibleTrim(value));
}

function isExplicitTableLine(value) {
  const text = visibleTrim(value);
  if (/^\|.+\|$/u.test(text)) return true;
  if (/^(?:표|그림)\s*[0-9A-Za-z가-힣.-]+/u.test(text)) return true;
  return false;
}

function detectSignatureLineIndices(records, excluded = new Set()) {
  const nonEmpty = (records || []).filter(record => !record.blank && !excluded.has(record.index));
  if (nonEmpty.length < 3) return new Set();
  const tail = nonEmpty.slice(-7);
  const dateAt = tail.findIndex(record => /^(?:(?:19|20)\d{2}[.년]\s*\d{1,2}[.월]\s*\d{1,2}(?:[.일])?|\d{1,2}월\s*\d{1,2}일)$/u.test(record.text));
  if (dateAt < 0) return new Set();
  const afterDate = tail.slice(dateAt);
  const hasInstitution = afterDate.some(record => /(?:대학교|대학|학과|전공|위원회|학생회|협회|기관|재단|회사|병원)/u.test(record.text));
  const hasRole = afterDate.some(record => /(?:위원장|회장|대표|담당자|사무국|총장|학장|원장|드림|올림)\s*[.!]?$/u.test(record.text));
  if (!hasInstitution || !hasRole) return new Set();
  return new Set(afterDate.map(record => record.index));
}

function tableColumnCount(value) {
  const text = String(value || '');
  if (/\t/u.test(text)) return text.split(/\t+/u).filter(cell => visibleTrim(cell)).length;
  if (/\S\s{2,}\S/u.test(text)) return text.split(/\s{2,}/u).filter(cell => visibleTrim(cell)).length;
  return 0;
}

function detectContextTableLineIndices(records, excluded = new Set()) {
  const out = new Set();
  for (const record of records || []) {
    if (!record.blank && !excluded.has(record.index) && isExplicitTableLine(record.text)) out.add(record.index);
  }
  let group = [];
  const flush = () => {
    if (group.length >= 2) {
      const counts = group.map(item => tableColumnCount(item.raw));
      const dominant = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
      for (const item of group) {
        if (tableColumnCount(item.raw) >= 2 && Math.abs(tableColumnCount(item.raw) - dominant) <= 1) out.add(item.index);
      }
    }
    group = [];
  };
  for (const record of records || []) {
    if (record.blank || excluded.has(record.index) || tableColumnCount(record.raw) < 2) {
      flush();
      continue;
    }
    group.push(record);
  }
  flush();
  return out;
}

function detectCodeLineIndices(records) {
  const out = new Set();
  let fence = null;
  for (const record of records || []) {
    const match = String(record.raw || '').match(/^\s*(`{3,}|~{3,})/u);
    if (!fence) {
      if (!match) continue;
      fence = { char: match[1][0], length: match[1].length };
      out.add(record.index);
      continue;
    }
    out.add(record.index);
    if (match && match[1][0] === fence.char && match[1].length >= fence.length) fence = null;
  }
  return out;
}

function legalClauseParts(value) {
  const text = visibleTrim(value);
  const match = text.match(/^(제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?)(?:\s+([\s\S]+))?$/u);
  if (!match) return null;
  return { prefix: match[1], body: String(match[2] || '').trim() };
}

function isQuoteLine(value) {
  const text = visibleTrim(value);
  if (/^>\s*\S/u.test(text)) return true;
  // 따옴표로 시작한다는 이유만으로 뒤에 본문이 이어지는 긴 산문 전체를
  // 인용 블록으로 잠그지 않는다. 독립 인용 행만 구조로 취급하고, 문장
  // 첫머리의 속담·좌우명은 일반 산문으로 두어 바깥 띄어쓰기를 교정한다.
  return /^(?:“[^”\n]{1,500}”|‘[^’\n]{1,500}’|"[^"\n]{1,500}"|'[^'\n]{1,500}'|「[^」\n]{1,500}」|『[^』\n]{1,500}』|《[^》\n]{1,500}》|〈[^〉\n]{1,500}〉)$/u.test(text);
}

function isSentenceComplete(value) {
  const text = visibleTrim(value);
  if (!text) return false;
  if (/[.!?。！？…]\s*["”’')\]]*$/u.test(text)) return true;
  return text.length >= 40 && /(?:다|요|니다|했다|된다|였다|있다|없다|않다|함|됨|임|음)$/u.test(text);
}

function startsNewUnit(value) {
  return /^(?:[가-힣A-Za-z0-9“"'‘([]|[-*+•▪◦·]\s|[①②③④⑤⑥⑦⑧⑨⑩])/u.test(visibleTrim(value));
}

function isStructuralRole(role) {
  return STRUCTURAL_ROLES.has(String(role || ''));
}

function isHardProseBoundary(left, right) {
  if (!left || !right || left.blank || right.blank) return false;
  if (left.role !== 'prose' || right.role !== 'prose') return false;
  return left.text.length >= 70
    && right.text.length >= 40
    && isSentenceComplete(left.text)
    && startsNewUnit(right.text);
}

function shouldPreserveLineBoundary(left, right, policy = 'structural') {
  if (!left || !right || left.blank || right.blank) return false;
  if (policy === true || policy === 'all') return true;
  if (!policy || policy === 'none') return false;
  return isStructuralRole(left.role) || isStructuralRole(right.role) || isHardProseBoundary(left, right);
}

function analyzeLineStructure(value) {
  const records = buildLineRecords(value);
  const nonEmpty = records.filter(record => !record.blank);
  const roleCounts = {};
  for (const record of nonEmpty) roleCounts[record.role] = (roleCounts[record.role] || 0) + 1;
  let preservedBoundaryCount = 0;
  for (let index = 0; index < records.length - 1; index += 1) {
    if (shouldPreserveLineBoundary(records[index], records[index + 1], 'structural')) preservedBoundaryCount += 1;
  }
  const explicitParagraphCount = splitExplicitParagraphs(value).length;
  const paragraphs = splitReadableParagraphs(value, { records });
  const readability = measureParagraphReadability(paragraphs);
  return {
    lineCount: records.length,
    nonEmptyLineCount: nonEmpty.length,
    roleCounts,
    titleLineCount: roleCounts.title || 0,
    headingLineCount: roleCounts.heading || 0,
    labelLineCount: (roleCounts.label || 0) + (roleCounts.label_inline || 0),
    listLineCount: roleCounts.list || 0,
    tableLineCount: roleCounts.table || 0,
    quoteLineCount: roleCounts.quote || 0,
    signatureLineCount: roleCounts.signature || 0,
    structuralLineCount: nonEmpty.filter(record => isStructuralRole(record.role)).length,
    preservedBoundaryCount,
    explicitParagraphCount,
    readableParagraphCount: paragraphs.length,
    semanticBoundaryCount: Math.max(0, paragraphs.length - 1),
    readability
  };
}

function splitReadableParagraphs(value, options = {}) {
  const records = options.records || buildLineRecords(value);
  const paragraphs = [];
  let current = [];
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.blank) {
      flush();
      continue;
    }
    current.push(record.raw.trim());
    const next = records[index + 1];
    if (!next || next.blank) {
      flush();
      continue;
    }
    const splitForStandaloneStructure = ['title', 'heading'].includes(record.role)
      || ['title', 'heading'].includes(next.role);
    if (splitForStandaloneStructure || isHardProseBoundary(record, next)) flush();
  }
  flush();
  return paragraphs;
}

function profileNameFromOptions(options = {}) {
  const profile = options?.documentProfile;
  if (profile && typeof profile === 'object') {
    return String(profile.profile || profile.contentGenre || options.profileName || 'unknown');
  }
  return String(options?.profileName || profile || 'unknown');
}

function resolveParagraphReadabilityLimits(options = {}) {
  const profileName = profileNameFromOptions(options);
  const mode = String(options?.mode || '');
  if (mode === 'polish' || profileName === 'creative') {
    return {
      profileName,
      maxBare: MAX_PARAGRAPH_BARE,
      maxSentences: MAX_PARAGRAPH_SENTENCES
    };
  }
  const limits = PROFILE_READABILITY_LIMITS[profileName]
    || PROFILE_READABILITY_LIMITS.unknown;
  return { profileName, ...limits };
}

function paragraphSplitNeed(paragraph, options = {}) {
  if (isStructureDominatedParagraph(paragraph)) return 1;
  const limits = resolveParagraphReadabilityLimits(options);
  const compact = bare(paragraph).length;
  const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
  return Math.max(
    1,
    Math.ceil(compact / limits.maxBare),
    Math.ceil(sentenceCount / limits.maxSentences)
  );
}

function measureParagraphReadability(paragraphsOrText, options = {}) {
  const paragraphs = Array.isArray(paragraphsOrText)
    ? paragraphsOrText
    : splitReadableParagraphs(paragraphsOrText);
  const limits = resolveParagraphReadabilityLimits(options);
  const details = paragraphs.map((paragraph, index) => {
    const compact = bare(paragraph).length;
    const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
    const structureDominated = isStructureDominatedParagraph(paragraph);
    const splitNeed = structureDominated ? 1 : paragraphSplitNeed(paragraph, options);
    return { index, compact, sentenceCount, structureDominated, splitNeed, overlong: splitNeed > 1 };
  });
  return {
    paragraphCount: paragraphs.length,
    targetCount: details.reduce((sum, item) => sum + item.splitNeed, 0),
    minimumCount: minimumReadableParagraphCount(details, options),
    overlongCount: details.filter(item => item.overlong).length,
    maxBare: details.length ? Math.max(...details.map(item => item.compact)) : 0,
    maxSentences: details.length ? Math.max(...details.map(item => item.sentenceCount)) : 0,
    maxBareLimit: limits.maxBare,
    maxSentenceLimit: limits.maxSentences,
    details
  };
}

function minimumReadableParagraphCount(detailsOrParagraphs, options = {}) {
  const limits = resolveParagraphReadabilityLimits(options);
  const details = Array.isArray(detailsOrParagraphs)
    && detailsOrParagraphs.every(item => item && typeof item === 'object' && Number.isFinite(item.compact))
    ? detailsOrParagraphs
    : measureParagraphReadabilityDetails(detailsOrParagraphs, options);
  const structuralCount = details.filter(item => item.structureDominated).length;
  const prose = details.filter(item => !item.structureDominated);
  if (!prose.length) return structuralCount;
  const totalBare = prose.reduce((sum, item) => sum + item.compact, 0);
  const totalSentences = prose.reduce((sum, item) => sum + item.sentenceCount, 0);
  return structuralCount + Math.max(
    1,
    Math.ceil(totalBare / limits.maxBare),
    Math.ceil(totalSentences / limits.maxSentences)
  );
}

function measureParagraphReadabilityDetails(paragraphsOrText, options = {}) {
  const paragraphs = Array.isArray(paragraphsOrText)
    ? paragraphsOrText
    : splitReadableParagraphs(paragraphsOrText);
  return paragraphs.map((paragraph, index) => {
    const compact = bare(paragraph).length;
    const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
    const structureDominated = isStructureDominatedParagraph(paragraph);
    return { index, compact, sentenceCount, structureDominated };
  });
}

function isStructureDominatedParagraph(value) {
  const records = buildLineRecords(value).filter(record => !record.blank);
  if (!records.length) return false;
  // 표나 목록 한 줄이 섞였다는 이유로 그 뒤의 긴 산문까지 구조 블록으로
  // 면제하지 않는다. 문단의 모든 비어 있지 않은 행이 구조 행일 때만
  // 재배치 금지 대상으로 본다.
  return records.every(isPureStructuralRecord);
}

function isPureStructuralRecord(record) {
  const role = String(record?.role || '');
  if (!isStructuralRole(role)) return false;
  if (['table', 'quote', 'code', 'legal_clause', 'signature', 'label'].includes(role)) return true;
  // "라벨: 긴 본문"이나 "1. 제목 + 여러 설명 문장"은 접두부만
  // 구조이고 나머지는 일반 산문이다. 행 전체를 구조로 면제하지 않는다.
  if (role === 'label_inline') return false;
  if (['title', 'heading', 'list'].includes(role)) {
    const sentenceCount = splitSentences(String(record?.text || '')).filter(Boolean).length;
    return sentenceCount <= 1;
  }
  return false;
}

function bare(value) {
  return String(value || '').replace(/\s+/gu, '');
}

module.exports = {
  MAX_PARAGRAPH_BARE,
  MAX_PARAGRAPH_SENTENCES,
  normalizeNewlines,
  visibleTrim,
  splitExplicitParagraphs,
  splitReadableParagraphs,
  buildLineRecords,
  classifyLine,
  analyzeLineStructure,
  measureParagraphReadability,
  minimumReadableParagraphCount,
  paragraphSplitNeed,
  resolveParagraphReadabilityLimits,
  shouldPreserveLineBoundary,
  isStructuralRole,
  isKnownHeadingLine,
  legalClauseParts,
  labelParts,
  isSentenceComplete,
  isHardProseBoundary,
  isStructureDominatedParagraph
};
