'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { sentenceSimilarity, contentTokens } = require('./sentenceAlignment');
const bare = value => String(value || '').replace(/\s/gu, '');
// Endings differ between a claim and its restatement; compare two-syllable stems.
const stems = value => new Set(contentTokens(value).map(t => t.slice(0, 2)));
const coverage = (a, b) => [...a].filter(t => b.has(t)).length / Math.max(1, a.size);

// F05: a repair that restores a claim can add a sentence which only restates
// what the sentences beside it already say. This inspects a proposed repair,
// never delivered prose, and never deletes: the caller declines the proposal
// and the earlier text, with its specific sentences, stays as it was.
// A sentence counts only when it is new (not a reworded earlier one), every
// neighbour it leans on was already there, and it does not bring back a source
// sentence the earlier text lacked. The source's own repetition, reordering and
// rewording therefore pass. Restatements in different words are out of reach.
function addedRestatements(source, before, after) {
  const earlier = splitSentenceSpans(String(before || '')), rows = splitSentenceSpans(String(after || ''));
  if (!earlier.length || rows.length <= earlier.length || rows.length > 400) return [];
  const text = String(after), known = new Set(earlier.map(s => bare(s.text)));
  const kept = new Set(rows.map(s => bare(s.text)));
  const replaced = earlier.filter(s => !kept.has(bare(s.text)));
  const originals = splitSentenceSpans(String(source || '')).map(s => ({ text: s.text, tokens: stems(s.text) }));
  const sameParagraph = (left, right) => !/\n\s*\n/u.test(text.slice(left.end, right.start));
  const findings = [];
  for (let i = 0; i < rows.length && findings.length < 4; i++) {
    const row = rows[i], own = stems(row.text);
    if (known.has(bare(row.text)) || own.size < 4 || /\d/u.test(row.text)) continue;
    if (replaced.some(s => sentenceSimilarity(s.text, row.text) >= 0.5)) continue;
    const beside = [];
    for (const s of [rows[i - 1], rows[i - 2], rows[i - 3]]) {
      if (!s || !known.has(bare(s.text)) || !sameParagraph(s, row)) break;
      beside.push(s);
    }
    const following = rows[i + 1];
    if (following && known.has(bare(following.text)) && sameParagraph(row, following)) beside.push(following);
    if (!beside.length || coverage(own, new Set(beside.flatMap(s => [...stems(s.text)]))) < 0.75) continue;
    const restores = originals.some(o => coverage(own, o.tokens) >= 0.75 && coverage(o.tokens, own) >= 0.6
      && !earlier.some(s => sentenceSimilarity(o.text, s.text) >= 0.75));
    if (!restores) findings.push({ code: 'restatement_added', chars: bare(row.text).length });
  }
  return findings;
}

module.exports = { addedRestatements };
