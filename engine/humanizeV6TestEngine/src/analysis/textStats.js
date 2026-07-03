function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

function splitParagraphs(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/\n\s*\n/g)
    .map(p => p.trim())
    .filter(Boolean);
}

function splitLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

function splitSentences(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const rough = normalized
    .replace(/([.!?。！？]|다\.|요\.|니다\.)\s+/g, '$1\n')
    .split(/\n+/g)
    .map(s => s.trim())
    .filter(Boolean);
  const out = [];
  for (const s of rough) {
    if (s.length > 160) {
      const parts = s.split(/(?<=,|;|，|；)\s+/g).map(x => x.trim()).filter(Boolean);
      if (parts.length > 1) out.push(...parts);
      else out.push(s);
    } else {
      out.push(s);
    }
  }
  return out;
}

function tokenize(text) {
  return String(text || '')
    .match(/[가-힣]{1,}|[A-Za-z]+(?:[-_][A-Za-z0-9]+)*|\d+(?:[.,]\d+)?|[一-龥]+/g) || [];
}

function charCountNoSpace(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + Math.pow(x - m, 2), 0) / arr.length;
  return Math.sqrt(v);
}

function coeffVar(arr) {
  const m = mean(arr);
  if (!m) return 0;
  return std(arr) / m;
}

function entropy(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0;
  for (const v of values) {
    if (v <= 0) continue;
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function sentenceLengthEntropy(sentences) {
  const bins = [0, 0, 0, 0, 0];
  for (const s of sentences) {
    const len = charCountNoSpace(s);
    if (len <= 25) bins[0]++;
    else if (len <= 45) bins[1]++;
    else if (len <= 70) bins[2]++;
    else if (len <= 100) bins[3]++;
    else bins[4]++;
  }
  return entropy(bins) / Math.log2(bins.length);
}

function countMatches(text, patterns) {
  let n = 0;
  for (const p of patterns) {
    const re = typeof p === 'string'
      ? new RegExp(escapeRegExp(p), 'g')
      : new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
    const m = String(text || '').match(re);
    if (m) n += m.length;
  }
  return n;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ngramRepeatRatio(tokens, n = 3) {
  if (tokens.length < n * 2) return 0;
  const map = new Map();
  for (let i = 0; i <= tokens.length - n; i++) {
    const key = tokens.slice(i, i + n).join('|');
    map.set(key, (map.get(key) || 0) + 1);
  }
  let repeated = 0;
  for (const count of map.values()) {
    if (count > 1) repeated += count - 1;
  }
  return repeated / Math.max(1, tokens.length - n + 1);
}

function movingAverageTtr(tokens, window = 40) {
  if (!tokens.length) return 0;
  if (tokens.length <= window) return new Set(tokens.map(x => x.toLowerCase())).size / tokens.length;
  let total = 0;
  let count = 0;
  for (let i = 0; i <= tokens.length - window; i += Math.max(1, Math.floor(window / 2))) {
    const slice = tokens.slice(i, i + window).map(x => x.toLowerCase());
    total += new Set(slice).size / slice.length;
    count++;
  }
  return count ? total / count : 0;
}

function headingLines(text) {
  return splitLines(text)
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter(({ line }) => {
      if (!line) return false;
      if (/^(#{1,6}\s+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|\d+\.\s*|[가-힣A-Za-z]\)\s*)/.test(line)) return true;
      if (line.length <= 42 && !/[.!?。！？]$/.test(line) && /[가-힣A-Za-z]/.test(line)) return true;
      return false;
    });
}

function listLikeLines(text) {
  return splitLines(text).filter(line => /^\s*([-*•]|\d+[.)]|[가-힣A-Za-z]\))\s+/.test(line));
}

function getBasicStats(text) {
  const normalized = normalizeText(text);
  const paragraphs = splitParagraphs(normalized);
  const sentences = splitSentences(normalized);
  const tokens = tokenize(normalized);
  const sentenceLengths = sentences.map(charCountNoSpace);
  const paragraphLengths = paragraphs.map(charCountNoSpace);
  return {
    charCount: String(text || '').length,
    charCountNoSpace: charCountNoSpace(text),
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    tokenCount: tokens.length,
    headings: headingLines(text),
    listLineCount: listLikeLines(text).length,
    avgSentenceLength: mean(sentenceLengths),
    sentenceLengthCv: coeffVar(sentenceLengths),
    sentenceLengthEntropy: sentenceLengthEntropy(sentences),
    paragraphLengthCv: coeffVar(paragraphLengths),
    mattr: movingAverageTtr(tokens),
    repetition3: ngramRepeatRatio(tokens, 3),
    repetition4: ngramRepeatRatio(tokens, 4),
    paragraphs,
    sentences,
    tokens
  };
}

module.exports = {
  normalizeText,
  splitParagraphs,
  splitLines,
  splitSentences,
  tokenize,
  charCountNoSpace,
  mean,
  std,
  coeffVar,
  entropy,
  sentenceLengthEntropy,
  countMatches,
  ngramRepeatRatio,
  movingAverageTtr,
  headingLines,
  listLikeLines,
  getBasicStats,
  escapeRegExp
};
