'use strict';

// Request-scoped placeholders (literalSpans.createMarkerContext) must never be
// delivered. The primary freeze registers only the locked blocks it found in
// the model output; the depth-audit pair re-freezes with the same numbering and
// can therefore carry a token the primary restore list does not know.
const INTERNAL_MARKER_RE = /ZXQ(?:LOCK|MATH|CODE)\d{4}QXZ|\[\[\[V2_(?:BOUNDARY|LINE|SENTENCE)_\d{4}\]\]\]/gu;

const occurrences = (text, token) => String(text || '').split(token).length - 1;

// Token -> exact source value for every locked chunk, in the same order
// freezeLockedBlocks numbers them. A token is known even when its block was a
// freeze miss, so restoring it is exact rather than a guess.
function buildLockedRestoreBlocks(chunks, markerContext) {
  const blocks = [];
  if (!markerContext || typeof markerContext.token !== 'function') return blocks;
  let lockedIndex = 0;
  for (const chunk of chunks || []) {
    if (!chunk?.locked || !String(chunk.text || '').trim()) continue;
    blocks.push({ token: markerContext.token('ZXQLOCK', lockedIndex), value: String(chunk.text) });
    lockedIndex += 1;
  }
  return blocks;
}

// A marker-shaped string the user wrote is content: the marker context skips
// every token present in the source, so the same string can only come from
// the source. Only occurrences beyond the source's own count are leaks.
function residualInternalMarkers(source, outputText) {
  const output = String(outputText || '');
  const leaked = [];
  for (const token of new Set(output.match(INTERNAL_MARKER_RE) || [])) {
    const excess = occurrences(output, token) - occurrences(source, token);
    if (excess > 0) leaked.push({ family: token.replace(/\d{4}/u, '####'), count: excess });
  }
  return leaked;
}

module.exports = { INTERNAL_MARKER_RE, buildLockedRestoreBlocks, residualInternalMarkers };
