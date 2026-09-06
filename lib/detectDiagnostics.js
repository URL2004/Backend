'use strict';

const { normalizeSignalEvidence, supportedScoreCeiling, assessCauseCoverage } = require('./detectSignalPolicy');
const { groundSignals } = require('./detectGrounding');
const VERSION = 'detect-score-diagnostics-v1';
const REASONS = new Set(['none', 'low_confidence', 'cause_mismatch', 'long_mixed_input', 'primary_failed', 'no_distinct_model']);
const score = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(100, Math.round(value))) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(12, value) : 0;
const providerScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const STAGE_VERSION = 'detect-score-stages-v2';

function recheckReason(out, source, cfg) {
  if (!cfg?.models?.detectEscalation || cfg.models.detectEscalation === cfg.models.detect) return 'no_distinct_model';
  if (out?.confidence === 'low') return 'low_confidence';
  if (assessCauseCoverage(Number(out?.probability), out?.signalEvidence, { source: 'llm' }).status === 'partial') return 'cause_mismatch';
  if (String(source || '').length >= 6000 && out?.confidence !== 'high') return 'long_mixed_input';
  return 'none';
}

function summarizeAttempt(json, source, phase) {
  const signals = Array.isArray(json?.signals) ? json.signals.slice(0, 12) : [];
  const before = normalizeSignalEvidence(signals);
  const after = normalizeSignalEvidence(groundSignals(signals, source));
  return {
    phase: phase === 'primary' ? 'primary' : 'recheck',
    providerScore: providerScore(json?.probability),
    modelScore: score(json?.probability),
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
    ...(Object.hasOwn(item, 'providerScore') ? { providerScore: providerScore(item.providerScore) } : {}),
    confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'unknown',
    signalsBefore: count(item.signalsBefore), signalsAfter: count(item.signalsAfter),
    qualifyingBefore: count(item.qualifyingBefore), qualifyingAfter: count(item.qualifyingAfter),
    ceilingBefore: score(item.ceilingBefore), ceilingAfter: score(item.ceilingAfter), unlocated: count(item.unlocated)
  }));
  if (!attempts.length) return null;
  return {
    version: VERSION, attempts,
    recheckReason: REASONS.has(value.recheckReason) ? value.recheckReason : 'none',
    recheckFailed: value.recheckFailed === true,
    selectedModelScore: score(value.selectedModelScore),
    evidenceAlignedScore: score(value.evidenceAlignedScore),
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

module.exports = { VERSION, STAGE_VERSION, summarizeAttempt, recheckReason, sanitizeDiagnostics, withDisplayedScore };
