'use strict';
const { splitSentenceSpans, splitSentences, ngramSet } = require('../engine/koreanText');
const { isStructureDominatedParagraph } = require('./layoutStructure');

// Restore only unique, adjacent sentence anchors on the two sides of an
// explicit source paragraph boundary. Never cut by length, move words, or
// reconstruct an uncertain alignment. Works even with a locked preamble.
function restoreSourceParagraphTransitions(source, output) {
  const text = String(output || '');
  const paragraphs = String(source || '').split(/\r?\n[ \t]*\r?\n+/u).map(s => s.trim()).filter(Boolean);
  const spans = splitSentenceSpans(text);
  if (paragraphs.length < 2 || paragraphs.length > 40 || spans.length > 180 || text.length > 30000) return { text, repairedCount: 0 };
  const cache = new Map();
  const grams = value => {
    if (!cache.has(value)) cache.set(value, ngramSet(value, 2));
    return cache.get(value);
  };
  const similarity = (left, right) => {
    const a = grams(left), b = grams(right);
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared++;
    return shared / Math.max(1, a.size + b.size - shared);
  };
  const replacements = new Map();
  for (let p = 1; p < paragraphs.length; p++) {
    const left = paragraphs[p - 1], right = paragraphs[p];
    if (isStructureDominatedParagraph(left) || isStructureDominatedParagraph(right)) continue;
    const last = splitSentences(left).at(-1), first = splitSentences(right)[0];
    if (!last || !first || Math.min(last.length, first.length) < 25) continue;
    const candidates = [];
    for (let i = 1; i < spans.length; i++) {
      const l = similarity(last, spans[i - 1].text), r = similarity(first, spans[i].text);
      if (l < .6 || r < .45) continue;
      if (similarity(first.slice(0, 45), spans[i].text.slice(0, 45)) < .35) continue;
      candidates.push({ i, score: (l + r) / 2 });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length || (candidates[1] && candidates[0].score - candidates[1].score < .12)) continue;
    const i = candidates[0].i, start = spans[i - 1].end, end = spans[i].start;
    const separator = text.slice(start, end);
    if (!/^[ \t\r\n]*$/u.test(separator) || /\n[ \t]*\r?\n/u.test(separator)) continue;
    replacements.set(start, end);
  }
  let repaired = text;
  for (const [start, end] of [...replacements].sort((a, b) => b[0] - a[0])) {
    repaired = `${repaired.slice(0, start)}\n\n${repaired.slice(end)}`;
  }
  return { text: repaired, repairedCount: replacements.size };
}
module.exports = { restoreSourceParagraphTransitions };
