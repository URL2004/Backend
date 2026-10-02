'use strict';

// Diagnostic state of the CURRENT candidate, not whether a retry happened.
// Callers supply verifySemanticValidation(..., { requireDigest: true });
// `not_needed` is a scheduling reason and must never stand in for a verdict.
function finalSemanticState(report, validation, { confirmationPending = false } = {}) {
  if (report?.ran !== true || report.skipped === true || validation?.status === 'skipped') return 'not_run';
  if (confirmationPending) return 'confirmation_pending';
  if (validation?.status === 'stale') return 'stale';
  if (report.verificationCompleted === false) return 'incomplete';
  if (validation?.status === 'pass' && report.pass === true && report.uncertain !== true
    && report.repairRejected !== true) return 'verified_pass';
  if (validation?.status === 'fail') return 'verified_fail';
  if (validation?.status === 'uncertain') return 'uncertain';
  return 'unconfirmed';
}

// One final audit can establish missing provenance after an earlier audit ran.
// Admission still belongs to the caller's existing signal and absolute job /
// final deadlines. A current failed or uncertain verdict is not retried merely
// to seek a different answer; a prepared repair or new obligation is required.
function needsFinalSemanticAudit({ report, priorStatus, preparedRestore = false, needsObligationReview = false } = {}) {
  if (report?.ran !== true || report.skipped === true) return false;
  return preparedRestore === true || needsObligationReview === true
    || priorStatus === 'stale' || priorStatus === 'unknown';
}

// A later interrupted audit supersedes the old verdict for the final text.
// Keep its completed sections and usage, but never certify unfinished ones.
function retainIncompleteFinalAudit(prior, current) {
  if (current?.verificationCompleted !== false) return current;
  return {
    ...current, ran: true, pass: false, uncertain: true,
    repairCount: Number(prior?.repairCount || 0),
    repairRoundBudget: Number(prior?.repairRoundBudget || 0),
    decisionReason: 'final_semantic_revalidation_incomplete'
  };
}

// Completed, confirmed findings still constrain fallback selection even when
// a different section timed out. Only exact current pairs can contradict an
// older pass; partial model responses, unlocated claims and source issues do not.
function completedFinalFindings(report, source, candidate) {
  const result = [], seen = new Set();
  for (const section of report?.reports || []) {
    if (section.verificationCompleted !== true || section.pass !== false
        || section.uncertain || section.skipped) continue;
    for (const finding of section.violations || []) {
      const a = finding.sourceSpan, b = finding.candidateSpan;
      if (finding.origin !== 'introduced' || finding.repairable !== true
          || !require('./semanticObligations').hasGroundedSpan(finding)
          || typeof a !== 'string' || !a || typeof b !== 'string' || !b
          || !source.includes(a) || !candidate.includes(b)
          || source.indexOf(a) !== source.lastIndexOf(a)
          || candidate.indexOf(b) !== candidate.lastIndexOf(b)) continue;
      const key = a + '\u0000' + b;
      if (!seen.has(key)) { seen.add(key); result.push(finding); }
    }
  }
  return result;
}

module.exports = { finalSemanticState, needsFinalSemanticAudit, retainIncompleteFinalAudit, completedFinalFindings };
