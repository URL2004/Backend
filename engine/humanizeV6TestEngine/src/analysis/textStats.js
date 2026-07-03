'use strict';

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t\u00A0]+/g, ' ')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function splitParagraphs(text) {
  const t = normalizeText(text);
  if (!t) return [];
  return t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
}

function splitLines(text) {
  return normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
}

function isHeading(line) {
  const x = String(line || '').trim();
  if (!x) return false;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*\.?\s*[^\n]{1,30}$/.test(x)) return true;
  if (/^\d+(?:\.\d+)*\.?\s+[^\n]{1,60}$/.test(x) && !/[.!?。]$/.test(x)) return true;
  if (/^(서론|본론|결론|요약|개요|참고문헌|작업 후 확인|공용부 오염 상태|주차장과 분리배출장 정리)$/.test(x)) return true;
  if (x.length <= 40 && !/[.!?。]$/.test(x) && /(상태|특징|비교|문제|사례|시사점|정리|확인|분석|결론|서론|본론)$/.test(x)) return true;
  return false;
}

function splitSentences(text) {
  const t = normalizeText(text).replace(/\n+/g, ' ');
  if (!t) return [];
  const out = [];
  let buf = '';
  for (const ch of t) {
    buf += ch;
    if (/[.!?。！？]/.test(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // Korean academic text often has no dots in headings; filter very short fragments.
  return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 2);
}

function words(text) {
  const t = normalizeText(text);
  return t.match(/[A-Za-z0-9가-힣]+/g) || [];
}

function koreanTokens(text) {
  return words(text).filter(w => /[가-힣]/.test(w));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => Math.pow(x - m, 2))));
}

function cv(arr) {
  const m = mean(arr);
  return m ? stdev(arr) / m : 0;
}

function entropy(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0;
  for (const v of values) {
    if (!v) continue;
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function shingleSet(text, n = 5) {
  const compact = normalizeText(text).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i <= compact.length - n; i++) set.add(compact.slice(i, i + n));
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function sentenceEnding(sentence) {
  const s = sentence.trim().replace(/[.!?。！？]+$/g, '');
  const m = s.match(/(다|니다|요|함|음|됨|이다|한다|했다|있다|없다|된다|한다)$/);
  return m ? m[1] : '';
}

function countOccurrences(text, patterns) {
  const t = String(text || '');
  let total = 0;
  for (const p of patterns) {
    if (p instanceof RegExp) total += (t.match(p) || []).length;
    else total += (t.match(new RegExp(escapeRegExp(p), 'g')) || []).length;
  }
  return total;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ngramRepetition(tokens, n = 3) {
  if (tokens.length < n) return 0;
  const counts = new Map();
  for (let i = 0; i <= tokens.length - n; i++) {
    const k = tokens.slice(i, i + n).join(' ');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let repeated = 0;
  let total = 0;
  for (const c of counts.values()) {
    total += c;
    if (c > 1) repeated += c - 1;
  }
  return total ? repeated / total : 0;
}

function mattr(text, window = 50) {
  const toks = words(text).map(w => w.toLowerCase());
  if (!toks.length) return 0;
  if (toks.length <= window) return new Set(toks).size / toks.length;
  let sum = 0;
  let count = 0;
  for (let i = 0; i <= toks.length - window; i++) {
    const slice = toks.slice(i, i + window);
    sum += new Set(slice).size / window;
    count++;
  }
  return count ? sum / count : 0;
}

module.exports = {
  normalizeText,
  splitParagraphs,
  splitLines,
  isHeading,
  splitSentences,
  words,
  koreanTokens,
  mean,
  stdev,
  cv,
  entropy,
  shingleSet,
  jaccard,
  sentenceEnding,
  countOccurrences,
  escapeRegExp,
  ngramRepetition,
  mattr
};
