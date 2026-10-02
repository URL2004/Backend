'use strict';

const { normalizeSignalEvidence, supportedScoreCeiling, assessCauseCoverage } = require('./detectSignalPolicy');
const { groundSignals } = require('./detectGrounding');
const VERSION = 'detect-score-diagnostics-v1';
const REASONS = new Set(['none', 'low_confidence', 'insufficient_sample', 'cause_mismatch', 'evidence_score_tension', 'low_score_evidence_conflict', 'short_evidence_consistency', 'long_mixed_input', 'primary_failed', 'no_distinct_model']);
const CONTRACT_REASONS = new Set(['not_finite_number', 'outside_range', 'non_integer']);
const SELECTION_REASONS = new Set(['review_consistent', 'score_contract', 'evidence_location_mismatch', 'unsupported_high_score', 'low_score_recurring_evidence', 'short_review_support_insufficient']);
const score = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(100, Math.round(value))) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(12, value) : 0;
const providerScore = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const STAGE_VERSION = 'detect-score-stages-v2';
const FAILURE_CODES = new Set(['DETECT_SCORE_CONTRACT', 'DETECT_INCOMPLETE', 'OPENAI_SCHEMA_VALIDATION',
  'OPENAI_SCHEMA_PARSE', 'OPENAI_REFUSAL', 'OPENAI_TIMEOUT', 'OPENAI_TRUNCATED_OUTPUT', 'OPENAI_INCOMPLETE_OUTPUT',
  'OPENAI_EMPTY_OUTPUT', 'OPENAI_NETWORK_ERROR', 'AbortError', 'TimeoutError', 'ABORT_ERR']);

function sanitizeProviderAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2).filter(item => item && typeof item === 'object').map(item => ({
    httpAttempt: Number.isSafeInteger(item.httpAttempt) && item.httpAttempt >= 0 ? Math.min(100, item.httpAttempt) : null,
    providerScore: providerScore(item.providerScore),
    modelScore: require('./detectScoreContract').scoreContract(item.modelScore).valid ? item.modelScore : null,
    scoreContractReason: CONTRACT_REASONS.has(item.scoreContractReason) ? item.scoreContractReason : null
  }));
}

function summarizeFailure(error, phase) {
  const providerAttempts = sanitizeProviderAttempts(error?.detectScoreAttempts);
  const last = providerAttempts.at(-1) || error?.detectAttempt || {};
  const code = error?.code || error?.name;
  return { phase: phase === 'primary' ? 'primary' : 'recheck',
    providerScore: providerScore(last.providerScore), modelScore: last.modelScore ?? null,
    scoreContractReason: last.scoreContractReason || error?.scoreContractReason || null,
    confidence: 'unknown', failed: true, failureCode: FAILURE_CODES.has(code) ? code : 'other',
    evidenceAvailable: false, ...(providerAttempts.length ? { providerAttempts } : {}) };
}

function recheckReason(out, source, cfg) {
  if (!cfg?.models?.detectEscalation || cfg.models.detectEscalation === cfg.models.detect) return 'no_distinct_model';
  if (require('./detectEvidenceReview').candidateConsistency(out, source).reason === 'low_score_recurring_evidence') return 'low_score_evidence_conflict';
  if (out?.confidence === 'low' && !require('./detectConfidence').insufficientSample(source)) return 'low_confidence';
  if (assessCauseCoverage(Number(out?.probability), out?.signalEvidence, { source: 'llm' }).status === 'partial') return 'cause_mismatch';
  if (require('./detectEvidenceReview').needsEvidenceReview(out, source)) return 'evidence_score_tension';
  if (require('./detectEvidenceReview').needsShortConsistencyReview(out, source)) return 'short_evidence_consistency';
  if (out?.confidence === 'low') return 'insufficient_sample';
  if (String(source || '').length >= 6000 && out?.confidence !== 'high') return 'long_mixed_input';
  return 'none';
}

function summarizeAttempt(json, source, phase, transport = {}) {
  const signals = Array.isArray(json?.signals) ? json.signals.slice(0, 12) : [];
  const before = normalizeSignalEvidence(signals);
  const after = normalizeSignalEvidence(groundSignals(signals, source));
  return {
    phase: phase === 'primary' ? 'primary' : 'recheck',
    ...(sanitizeProviderAttempts(transport.detectScoreAttempts).length ? {
      providerAttempts: sanitizeProviderAttempts(transport.detectScoreAttempts) } : {}),
    providerScore: providerScore(json?.probability),
    modelScore: require('./detectScoreContract').scoreContract(json?.probability).valid ? json.probability : null,
    scoreContractReason: require('./detectScoreContract').scoreContract(json?.probability).reason,
    confidence: ['low', 'medium', 'high'].includes(json?.confidence) ? json.confidence : 'unknown',
    signalsBefore: before.length,
    signalsAfter: after.length,
    qualifyingBefore: assessCauseCoverage(50, before).qualifyingIndependentSignals,
    qualifyingAfter: assessCauseCoverage(50, after).qualifyingIndependentSignals,
    ceilingBefore: supportedScoreCeiling(before),
    ceilingAfter: supportedScoreCeiling(after),
    unlocated: after.filter(item => !item.locations?.length).length
  };
}

// Closed numeric/enumerated projection: never persist model prose, text, IDs or errors.
function sanitizeDiagnostics(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.attempts)) return null;
  const attempts = value.attempts.slice(0, 2).filter(item => item && ['primary', 'recheck'].includes(item.phase)).map(item => ({
    phase: item.phase, modelScore: score(item.modelScore),
    ...(item.failed === true ? { failed: true, failureCode: FAILURE_CODES.has(item.failureCode) ? item.failureCode : 'other' } : {}),
    ...(item.evidenceAvailable === false ? { evidenceAvailable: false } : {}),
    ...(sanitizeProviderAttempts(item.providerAttempts).length ? { providerAttempts: sanitizeProviderAttempts(item.providerAttempts) } : {}),
    ...(Object.hasOwn(item, 'providerScore') ? { providerScore: providerScore(item.providerScore) } : {}),
    ...(Object.hasOwn(item, 'scoreContractReason') ? { scoreContractReason: CONTRACT_REASONS.has(item.scoreContractReason) ? item.scoreContractReason : null } : {}),
    confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'unknown',
    signalsBefore: item.evidenceAvailable === false ? null : count(item.signalsBefore),
    signalsAfter: item.evidenceAvailable === false ? null : count(item.signalsAfter),
    qualifyingBefore: item.evidenceAvailable === false ? null : count(item.qualifyingBefore),
    qualifyingAfter: item.evidenceAvailable === false ? null : count(item.qualifyingAfter),
    ceilingBefore: score(item.ceilingBefore), ceilingAfter: score(item.ceilingAfter),
    unlocated: item.evidenceAvailable === false ? null : count(item.unlocated)
  }));
  if (!attempts.length) return null;
  return {
    version: VERSION, attempts,
    recheckReason: REASONS.has(value.recheckReason) ? value.recheckReason : 'none',
    recheckFailed: value.recheckFailed === true,
    selectedModelScore: score(value.selectedModelScore),
    evidenceAlignedScore: score(value.evidenceAlignedScore),
    ...(SELECTION_REASONS.has(value.reviewSelectionReason) ? { reviewSelectionReason: value.reviewSelectionReason } : {}),
    ...(value.finalCandidateConsistency && ['consistent', 'conflict', 'invalid'].includes(value.finalCandidateConsistency.status)
      ? { finalCandidateConsistency: { status: value.finalCandidateConsistency.status,
        reason: SELECTION_REASONS.has(value.finalCandidateConsistency.reason) ? value.finalCandidateConsistency.reason : 'consistent' } } : {}),
    ...(value.stageVersion === STAGE_VERSION ? {
      stageVersion: STAGE_VERSION,
      selectedPhase: ['primary', 'recheck'].includes(value.selectedPhase) ? value.selectedPhase : null,
      statisticalScore: score(value.statisticalScore), engineFinalScore: score(value.engineFinalScore),
      ...(Object.hasOwn(value, 'displayedScore') ? { displayedScore: score(value.displayedScore) } : {})
    } : {})
  };
}

function withDisplayedScore(value, displayedScore) {
  const clean = sanitizeDiagnostics(value);
  return clean?.stageVersion === STAGE_VERSION ? sanitizeDiagnostics({ ...clean, displayedScore }) : clean;
}

module.exports = { VERSION, STAGE_VERSION, summarizeAttempt, summarizeFailure, sanitizeProviderAttempts,
  recheckReason, sanitizeDiagnostics, withDisplayedScore };
