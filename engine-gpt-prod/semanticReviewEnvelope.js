'use strict';

// Reasoning and the verdict JSON share max_output_tokens. Explicit reviews
// add grounded quotations as well as reasoning; reserve the envelope BEFORE
// the request instead of truncating a small primary and paying for a fallback.
// Keep the existing confirming ceiling and short/ordinary primary envelope.
function semanticReviewEnvelope({ confirming = false, operatorCount = 0, obligationCount = 0 } = {}) {
  if (confirming) return 10000;
  const count = [operatorCount, obligationCount].reduce((n, value) =>
    n + (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0), 0);
  return Math.min(10000, 6000 + Math.max(0, count - 4) * 500);
}

module.exports = { semanticReviewEnvelope };
