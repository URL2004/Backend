'use strict';
const { verifySemanticValidation } = require('./semanticProvenance');
const { hasGroundedSpan } = require('./semanticObligations');

// Word frequency nominates a review; it cannot prove that a judgement was
// invented. A current, grounded semantic finding supplies that authority.
function polishPaddingDecision(source, candidate, padding, report) {
  if (!padding?.increased) return { block: false, review: false, reason: 'not_needed' };
  const verified = verifySemanticValidation(report, { source, candidate, requireDigest: true });
  if (verified.status === 'pass' && report.verificationCompleted === true)
    return { block: false, review: false, reason: 'semantic_pass' };
  const confirmed = ['fail','uncertain'].includes(verified.status) && report.verificationCompleted === true
    && (report.violations || []).some(v => ['new_evaluation','intensity_amplification','added_claim','scope_expansion'].includes(v.type)
      && v.origin === 'introduced' && hasGroundedSpan(v)
      && typeof v.sourceSpan === 'string' && source.includes(v.sourceSpan)
      && typeof v.candidateSpan === 'string' && candidate.includes(v.candidateSpan)
      && require('./finalQualityV2').comparePolishEvaluativePadding(v.sourceSpan,v.candidateSpan).increased);
  return { block: Boolean(confirmed), review: !confirmed,
    reason: confirmed ? 'confirmed_evaluation_added' : 'lexical_signal_requires_review' };
}
module.exports = { polishPaddingDecision };
