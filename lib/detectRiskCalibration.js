'use strict';

// Research-only operating-point calibration. A rank statistic controls the
// human-reference tail under exchangeability; it is not an authorship posterior.
const { sha } = require('./detectBenchmark');
const { upperFpr } = require('./detectValidation');
const { assertNoTrainingLeakage } = require('./detectDatasetRegistry');
const VERSION = 'detect-risk-calibration-v1';
const hash = model => sha(JSON.stringify(model));

function selectRank(n, targetFpr, failureProbability) {
  if (!Number.isInteger(n) || n < 1 || !(targetFpr > 0 && targetFpr < 1)
    || !(failureProbability > 0 && failureProbability < 1)) throw Error('risk_invalid_parameters');
  // k exceedances correspond to the (n-k)th ascending order statistic. The
  // score must be STRICTLY greater than that statistic (including ties).
  let allowed = -1;
  for (let k = 0; k < n; k++) {
    if (upperFpr(k, n, failureProbability) > targetFpr) break;
    allowed = k;
  }
  return allowed < 0 ? null : { ascendingRank: n - allowed, allowedExceedances: allowed,
    bound: upperFpr(allowed, n, failureProbability) };
}

function fitCalibration(rows, model, { targetFpr = .025, failureProbability = .05 } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw Error('risk_empty_calibration');
  const classifier = require('./detectStyleClassifier');
  if (!classifier.validateModel(model)) throw Error('risk_invalid_model');
  assertNoTrainingLeakage(model, rows);
  const ids = new Set(), families = new Map();
  for (const row of rows) {
    if (!row?.id || ids.has(row.id) || !row.group || !row.normalizedSha256
      || !Array.isArray(row.lineageKeys) || !row.lineageKeys.length) throw Error('risk_invalid_provenance');
    ids.add(row.id);
    if (row.split !== 'development' || row.authorship !== 'human_reference'
      || !['source_backed', 'verified_process'].includes(row.labelQuality)
      || row.permissions?.evaluate !== true || row.permissions?.derive !== true) throw Error('risk_ineligible_calibration');
    if (!Number.isFinite(row.margin)) throw Error('risk_missing_prediction');
    families.set(row.group, Math.max(families.get(row.group) ?? -Infinity, row.margin));
  }
  const rank = selectRank(families.size, targetFpr, failureProbability);
  if (!rank) throw Error('risk_insufficient_independent_families');
  const sorted = [...families.values()].sort((a, b) => a - b);
  const policy = { version: VERSION, status: 'research_only', selectedOn: 'development_human_reference_rank',
    modelDigest: hash(model), targetFpr, failureProbability, familyCount: families.size,
    documentCount: rows.length, ...rank, cutoffMargin: sorted[rank.ascendingRank - 1],
    comparison: 'strictly_greater', calibrationGroups: [...families.keys()].sort(),
    calibrationLineageKeys: [...new Set(rows.flatMap(r => r.lineageKeys))].sort(),
    calibrationTextHashes: [...new Set(rows.map(r => r.normalizedSha256))].sort(),
    genreCounts: rows.reduce((s, r) => (s[r.genre] = (s[r.genre] || 0) + 1, s), {}),
    definition: 'Threshold selected from family-maximum human-reference margins. Conditional on independent, representative families and valid origin labels. Does not certify other genres, production FPR or authorship probability.' };
  return { ...policy, digest: hash(policy) };
}

function validatePolicy(policy, model) {
  if (!policy || typeof policy !== 'object') return false;
  const { digest, ...body } = policy;
  return digest === hash(body) && policy.version === VERSION && policy.status === 'research_only'
    && policy.modelDigest === hash(model) && policy.selectedOn === 'development_human_reference_rank'
    && policy.comparison === 'strictly_greater' && Number.isFinite(policy.cutoffMargin)
    && policy.familyCount === policy.calibrationGroups?.length && policy.familyCount > 0
    && Array.isArray(policy.calibrationLineageKeys) && policy.calibrationLineageKeys.length > 0
    && Array.isArray(policy.calibrationTextHashes) && policy.calibrationTextHashes.length > 0;
}

function predict(text, model, policy) {
  if (!validatePolicy(policy, model)) return null;
  const raw = require('./detectStyleClassifier').predict(text, model);
  if (!raw) return null;
  const positive = raw.margin > policy.cutoffMargin;
  const shifted = 100 / (1 + Math.exp(-Math.max(-30, Math.min(30, model.plattA * (raw.margin - policy.cutoffMargin)))));
  // Keep integer display, threshold comparisons and the strict rank rule in
  // agreement. Rounding a value just below 50 must never add a false positive.
  const score = positive ? Math.max(50, Math.min(100, Math.floor(shifted))) : Math.min(49, Math.floor(shifted));
  return { version: VERSION, score, rawScore: raw.score, margin: raw.margin, positive,
    policyDigest: policy.digest, status: 'research_only', applied: false };
}

function assertIndependentValidation(policy, model, rows) {
  if (!validatePolicy(policy, model)) throw Error('risk_invalid_policy');
  assertNoTrainingLeakage(model, rows);
  assertNoTrainingLeakage({ trainingGroups: policy.calibrationGroups,
    trainingLineageKeys: policy.calibrationLineageKeys, trainingTextHashes: policy.calibrationTextHashes }, rows);
  if (rows.some(r => r.split !== 'holdout' || r.priorExposure)) throw Error('risk_validation_already_exposed');
}

module.exports = { VERSION, selectRank, fitCalibration, validatePolicy, predict, assertIndependentValidation };
