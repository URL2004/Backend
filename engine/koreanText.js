'use strict';

// JavaScript의 \b는 ASCII 단어 경계만 이해한다. 한국어 뒤 경계 검사는 모두 이 유틸을 쓴다.
const KOREAN_CHAR = '가-힣ㄱ-ㅎㅏ-ㅣ';
const WORD_CHAR = `${KOREAN_CHAR}A-Za-z0-9_`;

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
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
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
      const isBoundary = preserveLines
        || lineBreakCount >= 2
        || looksCompleteWithoutPunctuation(text.slice(start, end));
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
    if (ch === '.' && isProtectedPeriod(text, i, start)) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < text.length && /[.!?…。！？]/u.test(text[end])) end += 1;
    while (end < text.length && /["'”’」』】)\]]/u.test(text[end])) end += 1;
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

function isProtectedPeriod(text, index, sentenceStart) {
  const prev = text[index - 1] || '';
  const next = text[index + 1] || '';
  if (/\d/u.test(prev) && /\d/u.test(next)) return true; // 3.14
  const left = text.slice(Math.max(sentenceStart, index - 12), index + 1);
  if (/(?:e\.g|i\.e|etc|vs|Dr|Mr|Ms|Prof|No|Fig|Vol|Inc|Ltd)\.$/i.test(left)) return true;
  if (/(?:[A-Za-z]\.){1,5}$/u.test(left) && /[A-Za-z]/u.test(next)) return true;
  if (/(?:[A-Za-z]\.){2,6}$/u.test(left)) return true;
  const lineLeft = text.slice(Math.max(sentenceStart, text.lastIndexOf('\n', index - 1) + 1), index);
  if (/^\s*(?:\d{1,3}|[A-Za-z]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)$/u.test(lineLeft) && /\s/u.test(next)) return true;
  if (/^\s*\d+(?:\.\d+){1,4}$/u.test(lineLeft) && /\s/u.test(next)) return true;
  if (/^\s*제\s*\d{1,3}\s*(?:장|절|항)$/u.test(lineLeft) && /\s/u.test(next)) return true;
  return false;
}

function looksCompleteWithoutPunctuation(value) {
  return koreanEnd('(?:다|요|죠|까|음|함|임|됨|있음|없음)', 'u').test(String(value || '').trim());
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
  ngramSet,
  ngramJaccard,
  levenshteinDistance,
  computeEditMetrics,
  mean,
  standardDeviation
};
