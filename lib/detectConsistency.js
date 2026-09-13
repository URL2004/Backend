'use strict';

const { alignScoreToCauseEvidence, normalizeSignalEvidence } = require('./detectSignalPolicy');
const { insufficientSample } = require('./detectConfidence');

const VERSION = 'detect-consistency-v1';
const PROMPT_VERSION = 'detect-prompt-v7-consistency-candidate';
const MAX_MODEL_CALLS = 3; // Logical calls; transport retries retain the shared request deadline.
const MAX_AGREEMENT_GAP = 6;
const MIN_REVIEW_BUDGET_MS = 10000;
const REASONS = new Set(['none', 'band_boundary', 'subjective_signal_mix', 'low_confidence', 'cause_mismatch', 'long_mixed_input']);
const STATUSES = new Set(['not_requested', 'agreement', 'reviewed_agreement', 'reviewed_disagreement', 'review_failed', 'budget_exhausted']);
const SUBJECTIVE = new Set(['generic_abstraction', 'insufficient_grounding', 'formulaic_transition', 'overstructured_progression', 'lexical_template']);

// Research candidate. A score policy must pass labelled, genre-stratified
// holdout/FPR and repeated-call evaluation before this flag is enabled live.
function enabled(value = process.env.DETECT_CONSISTENCY_ENABLED) {
  return String(value || '').trim() === '1';
}

function criteriaEnabled(value = process.env.DETECT_EVIDENCE_CRITERIA_ENABLED) {
  return String(value || '').trim() === '1';
}

function qualifying(result) {
  return normalizeSignalEvidence(result?.signalEvidence, { allowLegacy: false })
    .filter(item => item.category !== 'other_observed_style'
      && item.strength !== 'weak' && item.scope !== 'isolated');
}

function alignedScore(result) {
  return alignScoreToCauseEvidence(result).probability;
}

function band(score) {
  return score <= 20 ? 0 : score < 50 ? 1 : score < 75 ? 2 : 3;
}

function reviewReason(result, source, existingReason = 'none') {
  if (REASONS.has(existingReason) && existingReason !== 'none') return existingReason;
  if (insufficientSample(source)) return 'none';
  const score = alignedScore(result);
  const signals = qualifying(result);
  if (!signals.length) return 'none';
  if ([20.5, 49.5, 74.5].some(edge => Math.abs(score - edge) <= 3.5)) return 'band_boundary';
  // Evidence sufficiency (confidence=high) is not score certainty. The observed
  // repeat failures had several abstract/template causes and high confidence.
  if (score >= 21 && score <= 74 && signals.filter(item => SUBJECTIVE.has(item.category)).length >= 2) {
    return 'subjective_signal_mix';
  }
  return 'none';
}

function evidenceKey(result) {
  return qualifying(result).map(item => `${item.category}:${item.strength}:${item.scope}`).sort().join('|');
}

function agrees(a, b) {
  return Math.abs(alignedScore(a) - alignedScore(b)) <= MAX_AGREEMENT_GAP
    && band(alignedScore(a)) === band(alignedScore(b)) && evidenceKey(a) === evidenceKey(b);
}

function selectMedianResult(results) {
  // Select an actual score+evidence pair; never synthesize an average score
  // with unrelated causes, take the minimum, or retry until a score is low.
  const median = [...results.map(alignedScore)].sort((a, b) => a - b)[Math.floor(results.length / 2)];
  const candidates = results.map((result, index) => ({ index, score: alignedScore(result),
    partners: results.filter((other, j) => j !== index && agrees(result, other)).length }))
    .filter(item => item.score === median).sort((a, b) => b.partners - a.partners || a.index - b.index);
  return candidates[0].index;
}

function sanitize(value) {
  if (!value || value.version !== VERSION) return null;
  const bounded = (n, max) => Number.isInteger(n) && n >= 0 ? Math.min(n, max) : 0;
  return { version: VERSION,
    reason: REASONS.has(value.reason) ? value.reason : 'none',
    status: STATUSES.has(value.status) ? value.status : 'not_requested',
    attemptedCalls: bounded(value.attemptedCalls, MAX_MODEL_CALLS),
    successfulCalls: bounded(value.successfulCalls, MAX_MODEL_CALLS),
    failedCalls: bounded(value.failedCalls, MAX_MODEL_CALLS - 1),
    // A timeout can be billed by the provider without returning usage. Known
    // failed-response usage is summed by the engine, but is not a final invoice.
    usageMayBeIncomplete: bounded(value.failedCalls, MAX_MODEL_CALLS - 1) > 0,
    selectedIndex: bounded(value.selectedIndex, MAX_MODEL_CALLS - 1),
    scoreRange: Number.isFinite(value.scoreRange) ? Math.max(0, Math.min(100, value.scoreRange)) : 0
  };
}

async function review({ primary, source, existingReason, invoke, signal, deadlineMs, now = Date.now }) {
  const reason = reviewReason(primary, source, existingReason);
  const results = [primary];
  let attemptedCalls = 1, failedCalls = 0, selectedIndex = 0, status = 'not_requested';
  const finish = () => ({ selected: results[selectedIndex], diagnostics: sanitize({ version: VERSION, reason, status,
    attemptedCalls, failedCalls, successfulCalls: results.length, selectedIndex,
    scoreRange: Math.max(...results.map(alignedScore)) - Math.min(...results.map(alignedScore)) }) });
  const abort = () => { if (signal?.aborted) throw signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }); };
  abort();
  if (reason === 'none') return finish();
  for (const phase of ['recheck', 'tiebreak']) {
    abort();
    if (!Number.isFinite(deadlineMs) || deadlineMs - now() < MIN_REVIEW_BUDGET_MS) {
      status = 'budget_exhausted'; return finish();
    }
    attemptedCalls++;
    try {
      // Independent reads: never send previous scores or proposed verdicts.
      results.push(await invoke(phase));
    } catch (error) {
      abort();
      failedCalls++;
      status = 'review_failed';
      return finish(); // Preserve the valid primary; no whole-chain retry.
    }
    abort();
    if (results.length === 2 && agrees(results[0], results[1])) {
      status = 'agreement'; return finish();
    }
  }
  selectedIndex = selectMedianResult(results);
  status = results.some((other, index) => index !== selectedIndex && agrees(results[selectedIndex], other))
    ? 'reviewed_agreement' : 'reviewed_disagreement';
  return finish();
}

module.exports = { VERSION, PROMPT_VERSION, MAX_MODEL_CALLS, MAX_AGREEMENT_GAP, MIN_REVIEW_BUDGET_MS,
  enabled, criteriaEnabled, reviewReason, agrees, selectMedianResult, sanitize, review };
