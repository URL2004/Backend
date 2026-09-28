'use strict';
const obligations = require('./semanticObligations');
const { verifySemanticValidation, textDigest } = require('./semanticProvenance');
const unique = (text, span) => typeof span === 'string' && span.length >= 8
  && text.indexOf(span) >= 0 && text.indexOf(span) === text.lastIndexOf(span);

// Retain VERIFIED local progress, never turn a document failure into a pass.
// Remaining errors must be exactly unchanged, previously grounded pairs. A
// new/uncertain error, an unreviewed changed finding or stale verdict vetoes it.
function canRetainPartialSemanticRepair(source, before, candidate, previous, next) {
  if (candidate === before || !next?.ran || next.pass !== false || next.uncertain
      || next.skipped || next.verificationCompleted === false
      || next.validation?.sourceDigest !== textDigest(source) || next.validation?.candidateDigest !== textDigest(candidate)
      || verifySemanticValidation(next,{source,candidate,requireDigest:true}).status !== 'fail') return false;
  const old = (previous?.violations || []).filter(v => v.origin === 'introduced' && obligations.hasGroundedSpan(v));
  if (!old.length || !(next.violations || []).length) return false;
  const changed = old.filter(v => !candidate.includes(v.candidateSpan));
  if (!changed.length || changed.some(v => !unique(before,v.candidateSpan))) return false;
  const required = obligations.collectObligations(source,[{violations:changed}]);
  if (!required.length || !obligations.allExplicitlyReviewed(required,next)) return false;
  return next.violations.every(v => v.origin === 'introduced' && obligations.hasGroundedSpan(v)
    && unique(before,v.candidateSpan) && unique(candidate,v.candidateSpan) && unique(source,v.sourceSpan)
    && old.some(o => o.type === v.type && o.relation === v.relation
      && o.sourceSpan === v.sourceSpan && o.candidateSpan === v.candidateSpan));
}
module.exports={canRetainPartialSemanticRepair};
