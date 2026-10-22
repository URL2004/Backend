'use strict';

function wordBoundaryKey(text) {
  return String(text || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/。/gu, '.').replace(/、/gu, ',')
    .replace(/\s+/gu, (space, offset, whole) =>
      /[\p{L}\p{N}]/u.test(whole[offset - 1] || '')
        && /[\p{L}\p{N}]/u.test(whole[offset + space.length] || '') ? ' ' : '');
}

// A copied excerpt is a different proof from a fuzzy edit. Every submitted
// character must occur in one contiguous range of the signed output, including
// Korean word boundaries. The caller must verify ownership and the full HMAC.
// No source-document score cap may be inherited by this smaller sample.
function exactExcerptMatch(text, output) {
  const target = wordBoundaryKey(text), candidate = wordBoundaryKey(output);
  const bareLength = target.replace(/\s/gu, '').length;
  if (bareLength < 500 || target.length >= candidate.length) return null;
  const offset = candidate.indexOf(target);
  if (offset < 0 || candidate.indexOf(target, offset + 1) !== -1) return null;
  const { splitSentenceSpans } = require('../engine/koreanText');
  const sentences = splitSentenceSpans(String(output));
  let from = -1, to = -1, cursor = 0;
  for (let index = 0; index < sentences.length; index++) {
    const span = sentences[index];
    // Walk each span once. Normalizing every prefix for every sentence makes a
    // long exact excerpt quadratic on the request thread.
    const key = wordBoundaryKey(span.text);
    if (!key) continue;
    const start = candidate.indexOf(key, cursor);
    if (start < 0 || /\S/u.test(candidate.slice(cursor, start))) return null;
    const end = start + key.length;
    cursor = end;
    if (from < 0) {
      if (start === offset) from = index;
      else if (start > offset) return null;
    }
    if (from >= 0) {
      if (end === offset + target.length) { to = index; break; }
      if (end > offset + target.length) return null;
    }
  }
  if (from < 0 || to < from || to - from + 1 < 3) return null;
  const range = { start: sentences[from].start, end: sentences[to].end };
  if (wordBoundaryKey(String(output).slice(range.start, range.end)) !== target) return null;
  return { ...range, sentenceCount: to - from + 1,
    lengthRatio: bareLength / candidate.replace(/\s/gu, '').length };
}

module.exports = { wordBoundaryKey, exactExcerptMatch };
