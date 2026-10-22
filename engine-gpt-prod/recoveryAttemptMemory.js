'use strict';

const { textDigest } = require('./semanticProvenance');
// Exact, request-local optional attempts only. No model response, failed
// semantic verdict or approximate match can ever stand in for a final audit.
function createAttemptMemory() {
  const settled = new Map();
  return {
    key(entry, tier, context) {
      if (!context) return '';
      return textDigest(JSON.stringify([context, entry.index, entry.sectionPath, entry.source,
        entry.output, entry.plan, entry.report, tier]));
    },
    get(key) { return key ? settled.get(key) || null : null; },
    remember(key, outcome) {
      if (!key || outcome.applied || outcome.failureCode || outcome.budgetSkipped) return;
      // Technical failures can recover on a later attempt. Only a completed
      // proposal which made no safe progress closes this exact objective.
      if (settled.size >= 64 && !settled.has(key)) settled.delete(settled.keys().next().value);
      settled.set(key, { rejectionCode: outcome.rejectionCode || 'not_better',
        safetyRejected: outcome.safetyRejected === true, marginalGain: Number(outcome.marginalGain) || 0 });
    }
  };
}
module.exports = { createAttemptMemory };
