'use strict';

const { splitSentences } = require('../engine/koreanText');

const MAX_PARAGRAPH_BARE = 1100;
const MAX_PARAGRAPH_SENTENCES = 12;
const STRUCTURAL_ROLES = new Set(['title', 'heading', 'label', 'label_inline', 'list', 'table', 'quote']);

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
  const firstContentIndex = nonEmpty[0]?.index ?? -1;
  for (const record of nonEmpty) {
    const position = nonEmpty.findIndex(item => item.index === record.index);
    const previous = position > 0 ? nonEmpty[position - 1] : null;
    const next = position + 1 < nonEmpty.length ? nonEmpty[position + 1] : null;
    const previousRaw = records[record.index - 1] || null;
    record.role = classifyLine(record.text, {
      firstContent: record.index === firstContentIndex,
      previous,
      next,
      blankBefore: record.index === 0 || previousRaw?.blank === true
    });
  }
  return records;
}

function classifyLine(value, context = {}) {
  const text = visibleTrim(value);
  if (!text) return 'blank';
  if (isKnownHeadingLine(text)) return 'heading';
  if (isTableLikeLine(text)) return 'table';
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
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.)．]?\s*\S.{0,100}$/u.test(text)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/u.test(text)) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)(?:\s+\S.{0,100})?$/u.test(text)) return true;
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

function isTableLikeLine(value) {
  const text = visibleTrim(value);
  if (/^\|.+\|$/u.test(text) || /\t/u.test(text)) return true;
  if (/^(?:표|그림)\s*[0-9A-Za-z가-힣.-]+/u.test(text)) return true;
  if (/\S\s{2,}\S\s{2,}\S/u.test(text) && text.length <= 260) return true;
  return false;
}

function isQuoteLine(value) {
  return /^(?:>|[“"'‘])\s*\S/u.test(visibleTrim(value));
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

function paragraphSplitNeed(paragraph) {
  if (isStructureDominatedParagraph(paragraph)) return 1;
  const compact = bare(paragraph).length;
  const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
  return Math.max(
    1,
    Math.ceil(compact / MAX_PARAGRAPH_BARE),
    Math.ceil(sentenceCount / MAX_PARAGRAPH_SENTENCES)
  );
}

function measureParagraphReadability(paragraphsOrText) {
  const paragraphs = Array.isArray(paragraphsOrText)
    ? paragraphsOrText
    : splitReadableParagraphs(paragraphsOrText);
  const details = paragraphs.map((paragraph, index) => {
    const compact = bare(paragraph).length;
    const sentenceCount = splitSentences(String(paragraph || '')).filter(Boolean).length;
    const structureDominated = isStructureDominatedParagraph(paragraph);
    const splitNeed = structureDominated ? 1 : paragraphSplitNeed(paragraph);
    return { index, compact, sentenceCount, structureDominated, splitNeed, overlong: splitNeed > 1 };
  });
  return {
    paragraphCount: paragraphs.length,
    targetCount: details.reduce((sum, item) => sum + item.splitNeed, 0),
    minimumCount: minimumReadableParagraphCount(details),
    overlongCount: details.filter(item => item.overlong).length,
    maxBare: details.length ? Math.max(...details.map(item => item.compact)) : 0,
    maxSentences: details.length ? Math.max(...details.map(item => item.sentenceCount)) : 0,
    details
  };
}

function minimumReadableParagraphCount(detailsOrParagraphs) {
  const details = Array.isArray(detailsOrParagraphs)
    && detailsOrParagraphs.every(item => item && typeof item === 'object' && Number.isFinite(item.compact))
    ? detailsOrParagraphs
    : measureParagraphReadabilityDetails(detailsOrParagraphs);
  const structuralCount = details.filter(item => item.structureDominated).length;
  const prose = details.filter(item => !item.structureDominated);
  if (!prose.length) return structuralCount;
  const totalBare = prose.reduce((sum, item) => sum + item.compact, 0);
  const totalSentences = prose.reduce((sum, item) => sum + item.sentenceCount, 0);
  return structuralCount + Math.max(
    1,
    Math.ceil(totalBare / MAX_PARAGRAPH_BARE),
    Math.ceil(totalSentences / MAX_PARAGRAPH_SENTENCES)
  );
}

function measureParagraphReadabilityDetails(paragraphsOrText) {
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
  if (records.some(record => record.role === 'table')) return true;
  if (records.length < 2) return false;
  const structural = records.filter(record => isStructuralRole(record.role)).length;
  return structural / records.length >= 0.5;
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
  shouldPreserveLineBoundary,
  isStructuralRole,
  isKnownHeadingLine,
  labelParts,
  isSentenceComplete,
  isHardProseBoundary,
  isStructureDominatedParagraph
};
