'use strict';

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
          || finding.spanVerified !== true || finding.grounding !== 'unique_exact_span'
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

module.exports = { retainIncompleteFinalAudit, completedFinalFindings };
