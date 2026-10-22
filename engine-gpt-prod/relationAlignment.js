'use strict';

// This constrains heuristic review QUESTIONS, never certifies meaning. Unique
// identical heading sequences provide section ownership even when the same
// vocabulary recurs in the introduction, body and conclusion.
function sentenceOwners(source, candidate, sourceSpans, candidateSpans) {
  const lines = require('./layoutStructure').buildLineRecords;
  const headings = text => lines(text).filter(r => ['heading', 'title', 'legal_clause'].includes(r.role))
    .map(r => ({ start: r.start, key: String(r.text || '').replace(/\s+/gu, ' ').trim() }));
  const left = headings(source), right = headings(candidate);
  if (left.length < 2 || left.length !== right.length || new Set(left.map(r => r.key)).size !== left.length
      || left.some((r, i) => r.key !== right[i].key)) return null;
  const assign = (spans, labels) => spans.map(span => {
    let owner = -1;
    for (let i = 0; i < labels.length && labels[i].start <= span.start; i++) owner = i;
    // A sentence spanning a heading boundary has no unambiguous owner.
    return owner + 1 < labels.length && span.end > labels[owner + 1].start ? null : owner;
  });
  return { source: assign(sourceSpans, left), candidate: assign(candidateSpans, right) };
}
module.exports = { sentenceOwners };
