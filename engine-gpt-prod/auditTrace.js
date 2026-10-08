'use strict';
const { textDigest, verifySemanticValidation } = require('./semanticProvenance');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
const code = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value) ? value : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

function sourceNormalization(submitted, normalized, integrity) {
  const source = String(submitted || ''), target = String(normalized || '');
  let start = 0, sourceEnd = source.length, targetEnd = target.length;
  while (start < sourceEnd && start < targetEnd && source[start] === target[start]) start++;
  while (sourceEnd > start && targetEnd > start && source[sourceEnd - 1] === target[targetEnd - 1]) {
    sourceEnd--; targetEnd--;
  }
  return {
    version: 'source-normalization-v1', submittedDigest: textDigest(source),
    normalizedDigest: textDigest(target), integrityDigest: textDigest(integrity),
    changed: source !== target,
    // This is the envelope of all edits, not an invented one-to-one diff.
    // Exact UTF-16 offsets address the submitted and normalized strings.
    changeRange: { kind: 'changed_envelope', unit: 'utf16', sourceStart: start,
      sourceEnd, normalizedStart: start, normalizedEnd: targetEnd }
  };
}

function finalValidationReceipt(report, source, candidate) {
  const validation = report?.validation || {};
  const verified = verifySemanticValidation(report, { source, candidate, requireDigest: true });
  return sanitizeFinalValidation({
    version: 'final-validation-summary-v1', status: verified.status,
    materialization: verified.materialization || 'unknown',
    sourceDigest: textDigest(source), finalCandidateDigest: textDigest(candidate),
    validatedSourceDigest: validation.sourceDigest,
    validatedCandidateDigest: validation.candidateDigest,
    sourceRelationDigest: validation.sourceRelationDigest,
    candidateRelationDigest: validation.candidateRelationDigest,
    parentSourceDigest: validation.parentSourceDigest,
    parentCandidateDigest: validation.parentCandidateDigest,
    phase: validation.phase
  });
}

function sanitizeFinalValidation(value) {
  if (value?.version !== 'final-validation-summary-v1'
      || !digest(value.sourceDigest) || !digest(value.finalCandidateDigest)) return undefined;
  const result = { version: value.version };
  for (const field of ['sourceDigest', 'finalCandidateDigest', 'validatedSourceDigest',
    'validatedCandidateDigest', 'sourceRelationDigest', 'candidateRelationDigest',
    'parentSourceDigest', 'parentCandidateDigest']) result[field] = digest(value[field]);
  result.status = ['pass', 'fail', 'stale', 'unknown', 'skipped', 'uncertain'].includes(value.status) ? value.status : 'unknown';
  result.materialization = ['exact', 'whitespace_layout'].includes(value.materialization) ? value.materialization : 'unknown';
  if (result.status === 'pass' && (!result.validatedSourceDigest || !result.validatedCandidateDigest
      || result.materialization === 'unknown')) result.status = 'unknown';
  result.phase = code(value.phase);
  return compact(result);
}

function compactAuditTrace(meta = {}) {
  const result = {};
  if (meta.inputStatus?.version === 'source-input-integrity-v1') {
    const value = meta.inputStatus;
    result.inputStatus = {
      version: value.version,
      completeness: ['review_required', 'no_issue_detected'].includes(value.completeness) ? value.completeness : 'unknown',
      structure: ['review_required', 'normalized', 'unchanged'].includes(value.structure) ? value.structure : 'unknown',
      semantic: ['pass', 'fail', 'stale', 'uncertain', 'skipped'].includes(value.semantic) ? value.semantic : 'unknown',
      style: ['normal', 'limited', 'effective', 'improved', 'not_applicable'].includes(value.style) ? value.style : 'unknown',
      issueCodes: [...new Set((Array.isArray(value.issueCodes) ? value.issueCodes : []).filter(code))].slice(0, 30),
      entityRepairCount: count(value.entityRepairCount) ?? 0
    };
  }
  const encoding = meta.encodingNormalization;
  if (encoding?.version === 'source-input-integrity-v1' && digest(encoding.sourceDigest) && digest(encoding.normalizedDigest)) {
    const edits = Array.isArray(encoding.changes) ? encoding.changes : [];
    result.encodingNormalization = { version: encoding.version, unit: 'utf16',
      coordinateBase: 'trimmed_line_normalized_input', sourceDigest: encoding.sourceDigest,
      normalizedDigest: encoding.normalizedDigest, changed: encoding.changed === true,
      changeCount: Math.max(count(encoding.changeCount) ?? 0, edits.length),
      truncated: encoding.truncated === true || edits.length > 40,
      changes: edits.slice(0, 40).filter(edit => ['sourceStart', 'sourceEnd', 'normalizedStart', 'normalizedEnd'].every(k => count(edit?.[k]) !== undefined)
        && edit.sourceEnd > edit.sourceStart && edit.normalizedEnd > edit.normalizedStart).map(edit => ({
          sourceStart: edit.sourceStart, sourceEnd: edit.sourceEnd,
          normalizedStart: edit.normalizedStart, normalizedEnd: edit.normalizedEnd })) };
  }
  // Persist optional fields only: an older job without a ledger is unknown.
  for (const field of ['candidateLedgerVersion', 'candidateLedgerSelectedStage', 'candidateLedgerSelectionReason']) {
    if (code(meta[field])) result[field] = code(meta[field]);
  }
  for (const field of ['candidateLedgerEnabled', 'candidateLedgerRollbackApplied']) {
    if (typeof meta[field] === 'boolean') result[field] = meta[field];
  }
  for (const field of ['candidateLedgerCheckpointCount', 'candidateLedgerEligibleCount']) {
    if (count(meta[field]) !== undefined) result[field] = count(meta[field]);
  }
  if (digest(meta.candidateLedgerSelectedDigest)) result.candidateLedgerSelectedDigest = meta.candidateLedgerSelectedDigest;
  if (Array.isArray(meta.candidateLedgerRejectedFinalCodes)) {
    result.candidateLedgerRejectedFinalCodes = [...new Set(meta.candidateLedgerRejectedFinalCodes.filter(code))].slice(0, 20);
  }
  const receipt = sanitizeFinalValidation(meta.finalValidationReceipt);
  if (receipt) result.finalValidationReceipt = receipt;
  const normalization = meta.sourceNormalization;
  if (normalization?.version === 'source-normalization-v1'
      && digest(normalization.submittedDigest) && digest(normalization.normalizedDigest) && digest(normalization.integrityDigest)) {
    result.sourceNormalization = {
      version: normalization.version, submittedDigest: normalization.submittedDigest,
      normalizedDigest: normalization.normalizedDigest, integrityDigest: normalization.integrityDigest,
      changed: normalization.changed === true
    };
    const range = normalization.changeRange;
    if (range?.kind === 'changed_envelope' && range.unit === 'utf16'
        && ['sourceStart', 'sourceEnd', 'normalizedStart', 'normalizedEnd'].every(k => count(range[k]) !== undefined)
        && range.sourceEnd >= range.sourceStart && range.normalizedEnd >= range.normalizedStart) {
      result.sourceNormalization.changeRange = { kind: range.kind, unit: range.unit,
        sourceStart: range.sourceStart, sourceEnd: range.sourceEnd,
        normalizedStart: range.normalizedStart, normalizedEnd: range.normalizedEnd };
    }
  }
  return result;
}

module.exports = { sourceNormalization, finalValidationReceipt, compactAuditTrace };
