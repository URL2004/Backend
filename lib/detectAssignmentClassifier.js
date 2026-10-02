'use strict';

// Independent character-statistics path trained on Korean student assignments
// (NIKL grading/feedback corpus, local evaluation approval) against GPT-6
// assignments written from the same prompts. Runs after the model score,
// cause ceiling and the existing statistical assist; it can only raise the
// displayed score into the bounded 50..74 band and never lowers anything.
// Default OFF: DETECT_ASSIGNMENT_CLASSIFIER_ENABLED=1 turns it on. The cache
// variant includes the flag, version and threshold, so cached results never
// mix states. Evaluation record: docs/detect-assignment-classifier.md.
const { predict, validateModel } = require('./detectStyleClassifier');

const VERSION = 'assignment-classifier-v1';
const POLICY_VERSION = 'assignment-classifier-raw-threshold-v2';
const MODEL_VERSION = 'korean-assignment-classifier-v1';
const MODEL_PATH = '../engine-gpt-prod/models/korean-assignment-classifier-v1.json';
const CEILING = 74;
let cachedModel = null;

function enabled(value = process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED) {
  return /^(1|true|on|yes)$/iu.test(String(value ?? '').trim());
}

// Platt-calibrated classifier score at which the independent path starts.
// 50 = development threshold (NIKL dev: 0/120 human, cross-domain 519: 0/259).
function highThreshold(value = process.env.DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 30 && n <= 95 ? n : 50;
}

function loadModel() {
  if (!cachedModel) {
    const candidate = require(MODEL_PATH);
    if (!validateModel(candidate) || candidate.modelVersion !== MODEL_VERSION) throw new Error('invalid_assignment_classifier_model');
    cachedModel = candidate;
  }
  return cachedModel;
}

// Bounded, monotone mapping: classifier score threshold..100 → displayed 50..74.
function mapScore(score, threshold) {
  const span = Math.max(1, 100 - threshold);
  return Math.round(50 + Math.max(0, Math.min(1, (score - threshold) / span)) * (CEILING - 50));
}

function safeProfile(value) {
  return require('../engine-gpt-prod/documentProfile').CONTENT_GENRES.includes(value) ? value : 'unknown';
}

function sanitizeClassifierReference(value) {
  if (!value || value.version !== VERSION || value.modelVersion !== MODEL_VERSION
    || value.basis !== 'independent_statistics' || value.scoreApplied !== false
    || ![value.classifierScore, value.margin].every(Number.isFinite)
    || value.classifierScore < 0 || value.classifierScore > 100
    || !Number.isSafeInteger(value.features) || value.features < 20 || value.features > 20000
    || (Object.hasOwn(value, 'rawClassifierScore') && (!Number.isFinite(value.rawClassifierScore) || value.rawClassifierScore < 0 || value.rawClassifierScore > 100))) return null;
  return { version: VERSION, modelVersion: MODEL_VERSION, basis: 'independent_statistics', scoreApplied: false,
    classifierScore: value.classifierScore, margin: value.margin, features: value.features, profile: safeProfile(value.profile),
    ...(Object.hasOwn(value, 'rawClassifierScore') ? { rawClassifierScore: value.rawClassifierScore } : {}),
    ...(Number.isFinite(value.threshold) && value.threshold >= 30 && value.threshold <= 95 ? { threshold: value.threshold } : {}) };
}

function applyClassifier(result, source, { profile = 'unknown', active = enabled(), threshold = highThreshold(), predictor = null } = {}) {
  const original = result?.probability;
  if (!active || typeof source !== 'string' || typeof original !== 'number' || !Number.isFinite(original) || original < 0 || original >= CEILING) return result;
  threshold = highThreshold(threshold);
  let document;
  try { document = require('./detectInputDocument').buildDetectInputDocument(source); } catch { return result; }
  // Quoted, tabular or code-bearing documents were not part of the validation.
  if (document.protectedSpans.length) return result;
  let prediction;
  try { prediction = predictor ? predictor(source) : predict(source, loadModel()); } catch { return result; }
  if (!prediction || !Number.isFinite(prediction.score)) return result;
  const classifierScore = Math.round(prediction.score * 10) / 10;
  const reference = sanitizeClassifierReference({ version: VERSION, modelVersion: MODEL_VERSION, basis: 'independent_statistics', scoreApplied: false,
    classifierScore, rawClassifierScore: prediction.score, threshold,
    margin: prediction.margin, features: prediction.matchedFeatures, profile });
  if (!reference) return result;
  // Only the decision uses the unrounded prediction. Keep the established
  // display mapping unchanged for predictions that actually meet the threshold.
  if (prediction.score < threshold) return { ...result, classifierReference: reference };
  const probability = Math.max(original, mapScore(classifierScore, threshold));
  if (probability === original) return { ...result, classifierReference: reference };
  const statisticalSupport = sanitizeAssignmentSupport({
    version: VERSION, modelVersion: MODEL_VERSION, applied: true, basis: 'independent_statistics',
    originalScore: original, score: probability, margin: prediction.margin, features: prediction.matchedFeatures,
    profile, classifierScore, rawClassifierScore: prediction.score, threshold
  });
  return { ...result, probability, statisticalSupport,
    statisticalStages: require('./detectStatisticalAssist').appendSupportStage(result, statisticalSupport) };
}

// Closed projection for cache/history/logs. Returns null for anything that does not match this path's contract.
function sanitizeAssignmentSupport(value) {
  if (!value || value.version !== VERSION || value.modelVersion !== MODEL_VERSION || value.applied !== true || value.basis !== 'independent_statistics'
    || ![value.originalScore, value.score, value.margin, value.classifierScore].every(Number.isFinite)
    || value.originalScore < 0 || value.originalScore >= CEILING || value.score < 50 || value.score > CEILING || value.score <= value.originalScore
    || !Number.isSafeInteger(value.features) || value.features < 20 || value.features > 20000
    || value.classifierScore < 0 || value.classifierScore > 100
    || (Object.hasOwn(value, 'rawClassifierScore') && (!Number.isFinite(value.rawClassifierScore) || value.rawClassifierScore < 0 || value.rawClassifierScore > 100))) return null;
  return { version: VERSION, modelVersion: MODEL_VERSION, applied: true, basis: 'independent_statistics',
    originalScore: value.originalScore, score: value.score, margin: value.margin, features: value.features,
    profile: safeProfile(value.profile), classifierScore: value.classifierScore,
    ...(Object.hasOwn(value, 'rawClassifierScore') ? { rawClassifierScore: value.rawClassifierScore } : {}),
    threshold: Number.isFinite(value.threshold) ? value.threshold : highThreshold() };
}

module.exports = { VERSION, POLICY_VERSION, MODEL_VERSION, CEILING, enabled, highThreshold, loadModel, mapScore, applyClassifier, sanitizeAssignmentSupport, sanitizeClassifierReference };
