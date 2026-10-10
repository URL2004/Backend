'use strict';

const { canonicalPriceKey } = require('./usageCost');

// Offline replay of 2026-10-09 usage: moving Luna's primary boundary loses
// more within-document chunk reads than it gains across documents. Do not
// change the routing key, model, or prompt to improve the apparent hit rate.
function humanizeCacheableSystem(prompt, { model, phase } = {}) {
  if (canonicalPriceKey(model) === 'gpt-6-luna' && phase !== 'escalation') return undefined;
  return prompt.cacheableSystem || false;
}

function prefixBeforeLine(system, start) {
  const boundary = system.indexOf(`\n${start}`);
  // Include the existing newline exactly once. Fail closed if assembly changes.
  return boundary >= 0 ? system.slice(0, boundary + 1) : false;
}

function repairCacheableSystem(system, { family, phase, model } = {}) {
  switch (family) {
    case 'general_surface':
      if (phase === 'humanization_role_recovery' && canonicalPriceKey(model) === 'gpt-6-luna') return undefined;
      // The paragraph contract is the first strength/approved-structure value.
      return prefixBeforeLine(system, '모델 편집 단계에서는');
    case 'ending_style': {
      // Everything through this line is invariant; the next optional line
      // depends on student_record_teacher. Preserve the newline at the cut.
      const start = system.indexOf('\n어미 외의 핵심 어휘');
      const end = start >= 0 ? system.indexOf('\n', start + 1) : -1;
      return end >= 0 ? system.slice(0, end + 1) : false;
    }
    case 'polish':
    case 'korean_refinement':
    case 'conservative_sentence':
    case 'collapsed_spacing':
      // Their universal prefixes are only 189 / 69 / 403 / 503 characters,
      // well below 1,024 tokens in the offline calibration. false explicitly
      // disables a write boundary; it must NOT fall back to the full system.
      return false;
    // Fingerprint replay favors existing reads; resume coverage is already
    // entirely static. Unmeasured families retain their existing policy.
    default:
      return undefined;
  }
}

module.exports = { humanizeCacheableSystem, repairCacheableSystem };
