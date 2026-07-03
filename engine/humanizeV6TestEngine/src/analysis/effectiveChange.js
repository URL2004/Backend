const {
  normalizeText,
  splitParagraphs,
  splitSentences,
  charCountNoSpace
} = require('./textStats');

function charShingles(text, n = 3) {
  const s = normalizeComparable(text);
  if (!s) return new Set();
  if (s.length <= n) return new Set([s]);
  const set = new Set();
  for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
  return set;
}

function normalizeComparable(text) {
  return normalizeText(text)
    .replace(/\s+/g, '')
    .replace(/["'“”‘’`]/g, '')
    .replace(/[,.!?;:，。！？；：]/g, '')
    .toLowerCase();
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 1;
}

function shingleSimilarity(a, b, n = 3) {
  return jaccard(charShingles(a, n), charShingles(b, n));
}

function pairByIndex(a, b) {
  const n = Math.min(a.length, b.length);
  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push([a[i], b[i]]);
  return { pairs, extraA: a.length - n, extraB: b.length - n };
}

function changedRatioBySimilarity(beforeItems, afterItems, threshold) {
  if (!beforeItems.length && !afterItems.length) return 0;
  const { pairs, extraA, extraB } = pairByIndex(beforeItems, afterItems);
  let changed = Math.max(0, extraA) + Math.max(0, extraB);
  for (const [a, b] of pairs) {
    const sim = shingleSimilarity(a, b, 3);
    if (sim < threshold) changed++;
  }
  return changed / Math.max(1, Math.max(beforeItems.length, afterItems.length));
}

function exactSentenceCarryover(before, after) {
  const B = splitSentences(before).map(normalizeComparable).filter(x => x.length >= 12);
  const A = new Set(splitSentences(after).map(normalizeComparable).filter(x => x.length >= 12));
  if (!B.length) return 0;
  let carried = 0;
  for (const s of B) if (A.has(s)) carried++;
  return carried / B.length;
}

function analyzeEffectiveChange(before, after, policy = {}) {
  const cfg = policy.effectiveChange || {};
  const sentenceThreshold = cfg.sentenceSimilarityThreshold ?? 0.88;
  const paragraphThreshold = cfg.paragraphSimilarityThreshold ?? 0.86;

  const beforeSentences = splitSentences(before);
  const afterSentences = splitSentences(after);
  const beforeParagraphs = splitParagraphs(before);
  const afterParagraphs = splitParagraphs(after);

  const charSimilarity = shingleSimilarity(before, after, 3);
  const charChange = Math.max(0, Math.min(1, 1 - charSimilarity));
  const sentenceChangedRatio = changedRatioBySimilarity(beforeSentences, afterSentences, sentenceThreshold);
  const paragraphChangedRatio = changedRatioBySimilarity(beforeParagraphs, afterParagraphs, paragraphThreshold);
  const exactCarryoverRatio = exactSentenceCarryover(before, after);

  const beforeLen = charCountNoSpace(before);
  const afterLen = charCountNoSpace(after);
  const lengthRatio = beforeLen ? afterLen / beforeLen : 1;

  return {
    charSimilarity: round(charSimilarity),
    charChange: round(charChange),
    sentenceChangedRatio: round(sentenceChangedRatio),
    paragraphChangedRatio: round(paragraphChangedRatio),
    exactSentenceCarryoverRatio: round(exactCarryoverRatio),
    lengthRatio: round(lengthRatio),
    beforeSentenceCount: beforeSentences.length,
    afterSentenceCount: afterSentences.length,
    beforeParagraphCount: beforeParagraphs.length,
    afterParagraphCount: afterParagraphs.length
  };
}

function thresholdsForRisk(sourceRisk, policy = {}) {
  const cfg = policy.effectiveChange || {};
  const grade = sourceRisk && sourceRisk.grade;
  let key = 'lowMedium';
  if (grade === 'high') key = 'high';
  else if (grade === 'medium') key = 'medium';
  else if (grade === 'low') key = 'low';

  return {
    key,
    minCharChange: (cfg.minCharShingleChange || {})[key] ?? 0.10,
    minSentenceChangedRatio: (cfg.minChangedSentenceRatio || {})[key] ?? 0.25,
    minParagraphChangedRatio: (cfg.minChangedParagraphRatio || {})[key] ?? 0.25,
    maxCharChange: cfg.maxCharShingleChange ?? 0.52,
    maxSentenceChangedRatio: cfg.maxChangedSentenceRatio ?? 0.82
  };
}

function round(x) {
  return Math.round((Number(x) || 0) * 1000) / 1000;
}

module.exports = {
  analyzeEffectiveChange,
  thresholdsForRisk,
  shingleSimilarity
};
