'use strict';

// JavaScript의 \b는 ASCII 단어 경계만 이해한다. 한국어 뒤 경계 검사는 모두 이 유틸을 쓴다.
const KOREAN_CHAR = '가-힣ㄱ-ㅎㅏ-ㅣ';
const WORD_CHAR = `${KOREAN_CHAR}A-Za-z0-9_`;
const { syntaxSpans } = require('./textSyntax');

function koreanEnd(source, flags = 'u') {
  const normalizedFlags = flags.includes('u') ? flags : `${flags}u`;
  return new RegExp(`(?:${source})(?=$|[^${WORD_CHAR}])`, normalizedFlags);
}

function koreanStart(source, flags = 'u') {
  const normalizedFlags = flags.includes('u') ? flags : `${flags}u`;
  return new RegExp(`(?<=^|[^${WORD_CHAR}])(?:${source})`, normalizedFlags);
}

function normalizeCompact(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/gu, '')
    .toLowerCase();
}

function normalizeSpace(value) {
  return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

// 소수점, 목차 번호, 영문 약어를 문장 끝으로 잘못 자르지 않는 결정론적 Node 분리기.
function splitSentences(value, { preserveLines = false } = {}) {
  return splitSentenceSpans(value, { preserveLines }).map(item => item.text);
}

function splitSentenceSpans(value, { preserveLines = false } = {}) {
  const text = String(value || '');
  if (!text.trim()) return [];
  const out = [];
  const syntax = syntaxSpans(text);
  const punctuation = buildPunctuationContext(text, syntax);
  const codeSpans = syntax.filter(span => span.spanType === 'code');
  const implicitEnds = new Set(missingTerminalBoundaries(text, syntax, punctuation));
  let codeCursor = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    while (codeCursor < codeSpans.length && codeSpans[codeCursor].end <= i) codeCursor += 1;
    if (codeSpans[codeCursor]?.start === i) {
      i = codeSpans[codeCursor].end;
      continue;
    }
    const ch = text[i];
    if (implicitEnds.has(i)) {
      pushSpan(out, text, start, i);
      while (i < text.length && /[ \t]/u.test(text[i])) i += 1;
      start = i;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const end = i;
      let lineBreakCount = 0;
      // CRLF는 줄바꿈 한 번이다. 이전 구현은 두 문자라는 이유로 빈 줄로
      // 계산해 Windows 입력만 모든 행을 문장 경계로 잘못 잘랐다.
      while (i < text.length && /[\r\n]/u.test(text[i])) {
        if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
        else i += 1;
        lineBreakCount += 1;
      }
      const embedded = punctuation.embedded(end);
      const isBoundary = !embedded && (preserveLines
        || lineBreakCount >= 2
        || looksCompleteWithoutPunctuation(text.slice(start, end)));
      if (isBoundary) {
        pushSpan(out, text, start, end);
        start = i;
      }
      continue;
    }
    if (!isSentencePunctuation(text, i)) {
      i += 1;
      continue;
    }
    if (punctuation.embedded(i)) { i += 1; continue; }
    if (ch === '.' && (isProtectedPeriod(text, i, start) || isInitialPeriod(text, i, start, punctuation))) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < text.length && /[.!?…。！？]/u.test(text[end])) end += 1;
    while (end < text.length && /["'”’」』》〉】)）\]]/u.test(text[end])) end += 1;
    if (end >= text.length || /\s/u.test(text[end])) {
      pushSpan(out, text, start, end);
      while (end < text.length && /[ \t]/u.test(text[end])) end += 1;
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }
  pushSpan(out, text, start, text.length);
  return out;
}

function isSentencePunctuation(text, index) {
  return /[.!?…。！？]/u.test(text[index] || '');
}

// Only explicit formal finite endings, never ambiguous nouns ending in 요/다.
// Return original offsets; segmentation does not insert punctuation or rewrite text.
function missingTerminalBoundaries(value, syntax = syntaxSpans(String(value || '')), punctuation = null) {
  const text = String(value || '');
  const ends = [];
  const contains = punctuation?.any || spanMembership(syntax, false);
  for (const match of text.matchAll(/[가-힣]+(?:습니다|입니다)([ \t]+)(?=[가-힣A-Za-z0-9])/gu)) {
    const end = match.index + match[0].length - match[1].length;
    if (contains(end)) continue;
    const next = text.slice(end).trimStart();
    if (/^(?:라고|라는|라며|라니|란|하고|하며|하는|하면|의|를|을|는|은)(?=\s|$)/u.test(next)) continue;
    ends.push(end);
  }
  return ends;
}

// Sorted spans + prefix maximum endpoints preserve nested/crossing coverage.
// Each punctuation/newline used to scan all quotes again. No document text is
// cached outside this split; lookups are O(log spans), not O(spans).
function spanMembership(spans, strictStart = true) {
  const ends = []; let maxEnd = -1;
  for (const span of spans) { maxEnd = Math.max(maxEnd, span.end); ends.push(maxEnd); }
  return index => {
    let low = 0, high = spans.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (strictStart ? spans[mid].start < index : spans[mid].start <= index) low = mid + 1;
      else high = mid;
    }
    return low > 0 && ends[low - 1] > index;
  };
}

function buildPunctuationContext(text, syntax) {
  const parenthetical = syntax.filter(span => span.spanType === 'parenthetical');
  const embedded = syntax.filter(span => span.spanType === 'parenthetical'
    || (span.spanType === 'quote' && (/^[가-힣]/u.test(text.slice(span.end))
      || /^[ \t\r\n]*(?:라고|라는|라며|란|이라고|이라는|이라며)(?=\s|[가-힣])/u.test(text.slice(span.end)))));
  return { embedded: spanMembership(embedded), parenthetical: spanMembership(parenthetical),
    code: spanMembership(syntax.filter(span => span.spanType === 'code'), false), any: spanMembership(syntax, false) };
}

function isInitialPeriod(text, index, start, punctuation) {
  if (!/(?:^|[^A-Za-z])[A-Z]$/u.test(text.slice(Math.max(start, index - 2), index))) return false;
  return punctuation.parenthetical(index)
    || /^\s*[A-Z]\./u.test(text.slice(index + 1, index + 6))
    || /(?:^|[^A-Za-z])[A-Z]\.\s+[A-Z]$/u.test(text.slice(Math.max(start, index - 12), index));
}

// Used for quoted detection eligibility as well as sentence segmentation. A
// quoted name such as "A. B." is emphasis/reference, not a complete quotation.
function hasSentenceTerminator(value) {
  const text = String(value || ''), syntax = syntaxSpans(text);
  const punctuation = buildPunctuationContext(text, syntax);
  for (let i = 0; i < text.length; i++) {
    if (!isSentencePunctuation(text, i)) continue;
    if (punctuation.code(i)) continue;
    if (punctuation.embedded(i)) continue;
    if (text[i] === '.' && (isProtectedPeriod(text, i, 0) || isInitialPeriod(text, i, 0, punctuation))) continue;
    if (i === text.length - 1 || /[\s"'”’」』》〉】)）\]]/u.test(text[i + 1])) return true;
  }
  return false;
}

function isProtectedPeriod(text, index, sentenceStart) {
  const prev = text[index - 1] || '';
  const next = text[index + 1] || '';
  if (/\d/u.test(prev) && /\d/u.test(next)) return true; // 3.14
  const dateStart = Math.max(0, index - 20);
  const dateWindow = text.slice(dateStart, index + 21);
  for (const match of dateWindow.matchAll(/(?<![\d.])\d{4}\.[ \t]*(?:0?[1-9]|1[0-2])\.[ \t]*(?:0?[1-9]|[12]\d|3[01])\./gu)) {
    if (dateStart + match.index <= index && index < dateStart + match.index + match[0].length) return true;
  }
  const left = text.slice(Math.max(sentenceStart, index - 12), index + 1);
  // Author-year citations: the period belongs to the Latin abbreviation,
  // not to a sentence or paragraph boundary. Keep a year requirement so an
  // ordinary English sentence ending in `et al.` may still terminate.
  if (/(?:^|\s)et\s+al\.$/iu.test(left)
      && /^\s*\(?\d{4}[a-z]?(?:\)|(?=$|[\s.,;:]|[은는이가의]))/iu.test(text.slice(index + 1))) return true;
  if (/(?:e\.g|i\.e|etc|vs|Dr|Mr|Ms|Prof|No|Fig|Vol|Inc|Ltd)\.$/i.test(left)) return true;
  if (/(?:[A-Za-z]\.){1,5}$/u.test(left) && /[A-Za-z]/u.test(next)) return true;
  if (/(?:[A-Za-z]\.){2,6}$/u.test(left)) return true;
  const lineLeft = text.slice(Math.max(sentenceStart, text.lastIndexOf('\n', index - 1) + 1), index);
  // Inline enumerations are not sentence stops: `방안은 1. 기준 제시 2. 확인`.
  // Require an adjacent ascending item, not merely a digit before a period;
  // otherwise ordinary prose ending in a number would lose its boundary.
  const inlineNumber = lineLeft.match(/(?:^|[ \t:：])(\d{1,2})$/u);
  if (inlineNumber && /[ \t]/u.test(next)) {
    const number = Number(inlineNumber[1]);
    const after = text.slice(index + 1, index + 420);
    const previous = lineLeft.slice(0, inlineNumber.index).match(/(?:^|[ \t])(\d{1,2})\.[ \t]+[^.!?\r\n]{1,350}$/u);
    if ((previous && Number(previous[1]) + 1 === number)
        || new RegExp(`^[ \\t]+[^.!?\\r\\n]{1,350}[ \\t]${number + 1}\\.[ \\t]+\\S`, 'u').test(after)) return true;
  }
  if (/^\s*(?:\d{1,3}|[A-Za-z]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)$/u.test(lineLeft) && /\s/u.test(next)) return true;
  if (/^\s*\d+(?:\.\d+){1,4}$/u.test(lineLeft) && /\s/u.test(next)) return true;
  if (/^\s*제\s*\d{1,3}\s*(?:장|절|항)$/u.test(lineLeft) && /\s/u.test(next)) return true;
  return false;
}

function looksCompleteWithoutPunctuation(value) {
  const text = String(value || '').trim();
  if (/^(?:#{1,6}\s|제\s*\d+\s*[장절항][.\s])/u.test(text)) return true;
  if (/(?:주요|수요|필요|개요)$/u.test(text)) return false;
  return /(?:다|요|죠|까|음|함|임|됨|있음|없음)$/u.test(text);
}

function pushSpan(out, source, start, end) {
  let cleanStart = start;
  let cleanEnd = end;
  while (cleanStart < cleanEnd && /\s/u.test(source[cleanStart])) cleanStart += 1;
  while (cleanEnd > cleanStart && /\s/u.test(source[cleanEnd - 1])) cleanEnd -= 1;
  if (cleanEnd > cleanStart) out.push({ start: cleanStart, end: cleanEnd, text: source.slice(cleanStart, cleanEnd) });
}

function ngramSet(value, n = 5) {
  const compact = normalizeCompact(value);
  const out = new Set();
  if (compact.length < n) {
    if (compact) out.add(compact);
    return out;
  }
  for (let i = 0; i <= compact.length - n; i += 1) out.add(compact.slice(i, i + n));
  return out;
}

function ngramJaccard(a, b, n = 5) {
  const aa = ngramSet(a, n);
  const bb = ngramSet(b, n);
  if (!aa.size && !bb.size) return 1;
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection += 1;
  return intersection / (aa.size + bb.size - intersection);
}

// Myers bit-vector Levenshtein. 문서 길이에서도 O(n) 행렬 메모리 없이 정확한 문자 편집 거리를 계산한다.
function levenshteinDistance(a, b) {
  let pattern = String(a || '');
  let text = String(b || '');
  if (pattern === text) return 0;
  if (!pattern.length) return text.length;
  if (!text.length) return pattern.length;
  if (pattern.length > text.length) [pattern, text] = [text, pattern];

  const m = pattern.length;
  const peq = new Map();
  for (let i = 0; i < m; i += 1) {
    const ch = pattern[i];
    peq.set(ch, (peq.get(ch) || 0n) | (1n << BigInt(i)));
  }
  const mask = (1n << BigInt(m)) - 1n;
  const last = 1n << BigInt(m - 1);
  let pv = mask;
  let mv = 0n;
  let score = m;
  for (const ch of text) {
    const eq = peq.get(ch) || 0n;
    const xv = eq | mv;
    const xh = ((((eq & pv) + pv) ^ pv) | eq) & mask;
    let ph = (mv | ~(xh | pv)) & mask;
    let mh = pv & xh;
    if (ph & last) score += 1;
    else if (mh & last) score -= 1;
    ph = ((ph << 1n) | 1n) & mask;
    mh = (mh << 1n) & mask;
    pv = (mh | ~(xv | ph)) & mask;
    mv = ph & xv;
  }
  return score;
}

function computeEditMetrics(source, output) {
  const from = String(source || '').normalize('NFC');
  const to = String(output || '').normalize('NFC');
  const base = Math.max(from.length, to.length, 1);
  const distance = levenshteinDistance(from, to);
  const sourceSentences = splitSentences(from);
  const outputSentences = splitSentences(to);
  const sourceKeys = new Set(sourceSentences.map(normalizeCompact).filter(Boolean));
  const unchanged = outputSentences.filter(s => sourceKeys.has(normalizeCompact(s))).length;
  return {
    sourceChars: from.length,
    outputChars: to.length,
    distance,
    charEditRatio: distance / base,
    lengthRatio: from.length ? to.length / from.length : (to.length ? Infinity : 1),
    sourceSentenceCount: sourceSentences.length,
    outputSentenceCount: outputSentences.length,
    changedSentenceRatio: outputSentences.length ? 1 - (unchanged / outputSentences.length) : 0,
    fiveGramSimilarity: ngramJaccard(from, to, 5)
  };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map(value => (value - avg) ** 2)));
}

module.exports = {
  KOREAN_CHAR,
  WORD_CHAR,
  koreanEnd,
  koreanStart,
  normalizeCompact,
  normalizeSpace,
  splitSentences,
  splitSentenceSpans,
  hasSentenceTerminator,
  missingTerminalBoundaries,
  ngramSet,
  ngramJaccard,
  levenshteinDistance,
  computeEditMetrics,
  mean,
  standardDeviation
};
