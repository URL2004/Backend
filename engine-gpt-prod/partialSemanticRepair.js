'use strict';
const obligations = require('./semanticObligations');
const { verifySemanticValidation, textDigest } = require('./semanticProvenance');
const unique = (text, span) => typeof span === 'string' && span.length >= 8
  && text.indexOf(span) >= 0 && text.indexOf(span) === text.lastIndexOf(span);

// Retain VERIFIED local progress, never turn a document failure into a pass.
// A later complete judge can first discover an error that already existed in
// unchanged text. That is not evidence that the repair introduced it. Retain
// such progress only with re-grounded pairs, unchanged local ownership and
// explicit accounting for every prior obligation. The verdict stays failed.
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
  const known = v => old.some(o => o.type === v.type && o.relation === v.relation
    && o.sourceSpan === v.sourceSpan && o.candidateSpan === v.candidateSpan);
  if (!next.violations.every(v => v.origin === 'introduced' && obligations.hasGroundedSpan(v)
    && unique(before,v.candidateSpan) && unique(candidate,v.candidateSpan) && unique(source,v.sourceSpan)
    && (known(v) || unchangedFindingContext(before,candidate,v.candidateSpan)))) return false;
  if (next.violations.every(known)) return true;
  // Recompute grounding on BOTH texts; persisted flags/offsets cannot turn a
  // missing problem span or a changed quotation into old error evidence.
  const ground = require('./judge').groundViolation;
  if (!next.violations.every(v => [before,candidate].every(text =>
    obligations.hasGroundedSpan(ground(v,source,text))))) return false;
  const prior = obligations.collectObligations(source,[previous]);
  const reviews = [...(next.obligationReviews || []), ...(next.reports || []).flatMap(r => r.obligationReviews || [])];
  return prior.every(({id,finding}) => next.violations.some(v => v.type === finding.type
    && v.relation === finding.relation && v.sourceSpan === finding.sourceSpan && v.candidateSpan === finding.candidateSpan)
    || (() => {
      const answers = reviews.filter(r => r.id === id), answer = answers[0];
      return answers.length === 1 && ['resolved','not_error'].includes(answer.status)
        && answer.sourceSpan === finding.sourceSpan && unique(source,answer.sourceSpan)
        && unique(candidate,answer.candidateSpan) && answer.detail?.trim().length >= 8
        && (answer.status !== 'resolved' || answer.candidateSpan !== finding.candidateSpan);
    })());
}

function unchangedFindingContext(before,candidate,span) {
  // Do not infer ownership from an unchanged substring after a changed lead,
  // moved paragraph, heading/list/table boundary or enclosing quotation.
  const blocks = text => text.split(/\r?\n[ \t]*\r?\n/u).map(s => s.trim()).filter(Boolean);
  const left = blocks(before), right = blocks(candidate);
  const i = left.findIndex(s => s.includes(span)), j = right.findIndex(s => s.includes(span));
  if (i < 0 || i !== j || left.length !== right.length
      || [-1,0,1].some(offset => left[i+offset] !== right[j+offset])) return false;
  const layout = require('./layoutStructure');
  const owners = text => layout.buildLineRecords(text).filter(r => r.start <= text.indexOf(span)
    && layout.isStructuralRole(r.role)).map(r => [r.role,r.raw]);
  const protectedOwners = text => {
    const start = text.indexOf(span), end = start + span.length;
    return require('../engine/textSyntax').syntaxSpans(text).filter(p => p.start < end && p.end > start)
      .map(p => [p.spanType,text.slice(p.start,p.end)]);
  };
  return JSON.stringify(owners(before)) === JSON.stringify(owners(candidate))
    && JSON.stringify(protectedOwners(before)) === JSON.stringify(protectedOwners(candidate));
}
module.exports={canRetainPartialSemanticRepair};
