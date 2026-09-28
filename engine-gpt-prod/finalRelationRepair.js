'use strict';

const restoration = require('./confirmedRelationRestore');
const { buildRelationPatchTargets } = require('./relationPatch');

function confirmedRepairFindings(report) {
  if(!report || report.pass!==false || report.skipped || report.verificationCompleted===false)return [];
  if(report.uncertain && !(report.violations||[]).some(v=>v.origin==='unconfirmed'
    || v.repairable===false || v.relationGrounded===false))return [];
  return (report.violations||[]).filter(v=>v.origin==='introduced'
    && require('./semanticObligations').hasGroundedSpan(v));
}

// A literal repair of one finding must not suppress another grounded finding.
// Re-ground remaining windows on the repaired text; never reuse old offsets or
// infer that a changed/absent window has passed. The entire proposal still
// requires the caller's fresh semantic verdict before it can be accepted.
async function prepareFinalRelationRepair(source, output, report, {
  priorReports = [], assessLiteral, assessPatch, structurePreserved, repair,
  deadlineMs, verifyReserveMs = 90000, signal, allowPatch = true, now = Date.now
}) {
  let proposal = { text: output, applied: false, restoredCount: 0, warnings: [],
    patchAttempted: false, patchedCount: 0, skipReason: 'no_grounded_target' };
  if (report?.pass !== false || report.skipped || report.verificationCompleted === false || signal?.aborted)
    return { ...proposal, skipReason: 'verdict_unavailable' };
  const literal = restoration.restoreConfirmedRelations(source, output, report, { priorReports });
  if (literal.applied) {
    const safety = restoration.assessConfirmedRestorationSafety(assessLiteral(literal.text));
    if (!safety.eligible) proposal.skipReason = 'safety_ineligible';
    else if (!structurePreserved(literal.text)) proposal.skipReason = 'structure_not_preserved';
    else proposal = { ...proposal, ...literal, warnings: safety.warnings, skipReason: '' };
  }
  // Explicit uncertainty in another member must not veto a confirmed current
  // target. Unexplained global uncertainty is still not repair authority.
  const findings = confirmedRepairFindings(report).filter(v =>
    typeof v.sourceSpan === 'string' && source.includes(v.sourceSpan)
      && source.indexOf(v.sourceSpan) === source.lastIndexOf(v.sourceSpan));
  const targets = buildRelationPatchTargets(proposal.text, findings);
  if (!targets.length) return proposal;
  if (!allowPatch) return { ...proposal, patchReason: 'patch_round_used' };
  if (signal?.aborted || !Number.isFinite(deadlineMs)
      || deadlineMs - now() < verifyReserveMs + 20000)
    return { ...proposal, patchReason: 'deadline_insufficient' };
  proposal.patchAttempted = true;
  const base = proposal.text;
  try {
    const patch = await repair(base, targets.flatMap(t => t.findings),
      Math.min(deadlineMs - verifyReserveMs, now() + 30000));
    const candidate = String(patch.outputText || '');
    if (patch.repaired && candidate !== base && assessPatch(base, candidate).pass === true
        && structurePreserved(candidate)) {
      proposal = { ...proposal, text: candidate, applied: true,
        patchedCount: targets.length, skipReason: '', patchReason: 'proposed' };
    } else proposal.patchReason = 'patch_rejected';
  } catch (error) {
    // A failed second repair must not discard an independently safe literal
    // proposal; uncertainty is preserved by the mandatory whole re-audit.
    proposal.patchReason = String(error.code || error.name || 'patch_failed').slice(0, 80);
  }
  return proposal;
}

// Only a stale verdict is eligible for this fallback. A later empty verdict
// must not erase a prior confirmed pair that STILL occurs unchanged, but a
// current exact pass is never reopened. These findings nominate a proposal;
// they are not a replacement verdict and cannot grant a pass.
function selectFinalRepairEvidence(source, output, report, status, priorReports = []) {
  if (status==='uncertain')return confirmedRepairFindings(report).length?report:null;
  if (!['stale', 'fail'].includes(status)) return null;
  if (report?.pass === false && !report.skipped && report.verificationCompleted !== false) return report;
  if (status !== 'stale' || report?.pass !== true) return null;
  const findings = [], seen = new Set();
  const visit = value => {
    if (!value || value.uncertain || value.skipped || value.verificationCompleted === false) return;
    for (const v of [...(value.violations || []), ...(value.initialViolations || [])]) {
      if (v.origin !== 'introduced' || v.relationGrounded !== true || v.repairable !== true
          || !require('./semanticObligations').hasGroundedSpan(v)) continue;
      const a = v.sourceSpan, b = v.candidateSpan;
      if (typeof a !== 'string' || typeof b !== 'string' || a.length < 20 || b.length < 20
          || a === b || !source.includes(a) || !output.includes(b)
          || source.indexOf(a) !== source.lastIndexOf(a) || output.indexOf(b) !== output.lastIndexOf(b)) continue;
      const key = a + '\u0000' + b;
      if (!seen.has(key) && findings.length < 8) { seen.add(key); findings.push(v); }
    }
    for (const child of [...(value.reports || []), ...(value.restorationNominationReports || [])]) visit(child);
  };
  for (const previous of priorReports.slice(-8)) visit(previous);
  if (!findings.length) return null;
  return { pass: false, uncertain: false, verificationCompleted: true, violations: findings,
    nominationOnly: true };
}

module.exports = { prepareFinalRelationRepair, selectFinalRepairEvidence, confirmedRepairFindings };
