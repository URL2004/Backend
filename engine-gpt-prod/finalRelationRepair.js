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
  let selected = selectCurrentRepairEvidence(source, output, report, status, priorReports);
  if (!['stale', 'fail', 'uncertain'].includes(status) || report?.skipped) return selected;
  // These reports are from this request, not a persistent/cross-version cache.
  // A later incomplete/empty verdict cannot dismiss an earlier exact pair.
  // Explicit dismissal must itself be complete and grounded on THIS pair.
  const dismissed = new Set(), seenReports = new Set();
  const collectDismissals = value => {
    if (!value || seenReports.has(value)) return;
    seenReports.add(value);
    if (!value.skipped && value.verificationCompleted !== false) {
      for (const review of value.obligationReviews || []) {
        if (review.status === 'not_error' && typeof review.sourceSpan === 'string'
            && typeof review.candidateSpan === 'string' && review.detail?.trim().length >= 8
            && source.includes(review.sourceSpan) && output.includes(review.candidateSpan)
            && source.indexOf(review.sourceSpan) === source.lastIndexOf(review.sourceSpan)
            && output.indexOf(review.candidateSpan) === output.lastIndexOf(review.candidateSpan))
          dismissed.add(`${review.id}\u0000${review.candidateSpan}`);
      }
    }
    for (const child of value.reports || []) collectDismissals(child);
  };
  for (const previous of priorReports.slice(-8)) collectDismissals(previous);
  collectDismissals(report);
  const obligationId = require('./semanticObligations').obligationId;
  if (selected?.nominationOnly) {
    const retained = selected.violations.filter(v => !dismissed.has(`${obligationId(v)}\u0000${v.candidateSpan}`));
    if (retained.length !== selected.violations.length)
      selected = retained.length ? { ...selected, violations: retained } : null;
  }
  const findings = [...(selected?.violations || [])], keys = new Set(findings.map(v =>
    `${v.type}\u0000${v.sourceSpan}\u0000${v.candidateSpan}`)), visited = new Set();
  const visit = value => {
    if (!value || visited.has(value) || value.skipped) return;
    visited.add(value);
    if (!value.uncertain && value.verificationCompleted !== false) {
      for (const v of [...(value.violations || []), ...(value.initialViolations || [])]) {
        const a = v.sourceSpan, b = v.candidateSpan;
        if (v.origin !== 'introduced' || !require('./semanticObligations').hasGroundedSpan(v)
            || typeof a !== 'string' || typeof b !== 'string' || a.length < 20 || b.length < 20
            || a === b || !source.includes(a) || !output.includes(b)
            || source.indexOf(a) !== source.lastIndexOf(a) || output.indexOf(b) !== output.lastIndexOf(b)
            || dismissed.has(`${obligationId(v)}\u0000${b}`)) continue;
        const key = `${v.type}\u0000${a}\u0000${b}`;
        if (!keys.has(key) && findings.length < 8) { keys.add(key); findings.push(v); }
      }
    }
    for (const child of [...(value.reports || []), ...(value.restorationNominationReports || [])]) visit(child);
  };
  for (const previous of priorReports.slice(-8)) visit(previous);
  if (findings.length === (selected?.violations || []).length) return selected;
  return { pass: false, uncertain: selected?.uncertain === true, verificationCompleted: true,
    violations: findings, nominationOnly: true, priorEvidenceRetained: true,
    partialDocumentEvidence: report?.verificationCompleted === false };
}

function selectCurrentRepairEvidence(source, output, report, status, priorReports = []) {
  // An incomplete DOCUMENT cannot certify anything, but its completed child
  // verdicts are not incomplete. Nominate only their exact unchanged windows
  // before the existing whole-document recheck; never reuse their old offsets
  // or promote the unfinished parent's aggregate findings into authority.
  if (['stale', 'fail', 'uncertain'].includes(status) && report?.pass === false
      && report.verificationCompleted === false && !report.skipped) {
    const findings = [], seen = new Set(), visited = new Set();
    const visit = value => {
      if (!value || visited.has(value) || value.skipped) return;
      visited.add(value);
      if (value.verificationCompleted === true && value.pass === false && !value.uncertain) {
        for (const v of confirmedRepairFindings(value)) {
          const a = v.sourceSpan, b = v.candidateSpan;
          if (typeof a !== 'string' || typeof b !== 'string' || a.length < 20 || b.length < 20
              || a === b || !source.includes(a) || !output.includes(b)
              || source.indexOf(a) !== source.lastIndexOf(a) || output.indexOf(b) !== output.lastIndexOf(b)) continue;
          const key = a + '\u0000' + b;
          if (!seen.has(key) && findings.length < 8) { seen.add(key); findings.push(v); }
        }
      }
      for (const child of value.reports || []) visit(child);
    };
    for (const child of report.reports || []) visit(child);
    return findings.length ? { pass: false, uncertain: false, verificationCompleted: true,
      violations: findings, nominationOnly: true, partialDocumentEvidence: true } : null;
  }
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
