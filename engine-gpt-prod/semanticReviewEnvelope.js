'use strict';

// Reasoning and the verdict JSON share max_output_tokens. Explicit reviews
// add grounded quotations as well as reasoning; reserve the envelope BEFORE
// the request instead of truncating a small primary and paying for a fallback.
// A confirming review previously had no room for explicit review items: a
// measured failure used 9,023 reasoning tokens out of 10,000 and cut off JSON.
// Reserve bounded per-item headroom before calling, not a paid truncation retry.
// This does not alter the caller deadline, reasoning effort or review coverage.
function semanticReviewEnvelope({ confirming = false, operatorCount = 0, obligationCount = 0 } = {}) {
  const count = [operatorCount, obligationCount].reduce((n, value) =>
    n + (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0), 0);
  if (confirming) return Math.min(16000, 10000 + count * 500);
  return Math.min(10000, 6000 + Math.max(0, count - 4) * 500);
}

module.exports = { semanticReviewEnvelope };
