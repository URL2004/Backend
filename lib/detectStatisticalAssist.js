'use strict';

const VERSION = 'statistical-assist-v1';
const MODEL_VERSION = 'korean-style-statistics-v1';
const PROFILES = new Set(['general', 'report_assignment', 'long_explainer']);
const tables = new WeakMap();
let model;

function enabled(value = process.env.DETECT_STATISTICAL_ASSIST_ENABLED) {
  return /^(1|true|on|yes)$/iu.test(String(value || '').trim());
}
function loadModel() {
  if (!model) {
    const candidate = require('../engine-gpt-prod/models/korean-style-statistics-v1.json');
    const size = candidate.features?.length;
    if (candidate.version !== MODEL_VERSION || !size || size > 30000
      || candidate.idf?.length !== size || candidate.weights?.length !== size
      || ![candidate.intercept, candidate.threshold, ...candidate.idf, ...candidate.weights].every(Number.isFinite)) {
      throw new Error('invalid_statistical_model');
    }
    model = candidate;
  }
  return model;
}

function marginFor(text, modelValue = loadModel()) {
  let table = tables.get(modelValue);
  if (!table) { table = new Map(modelValue.features.map((feature, i) => [feature, i])); tables.set(modelValue, table); }
  const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z]/gu, '');
  const counts = new Map();
  for (let n = 2; n <= 5; n++) for (let i = 0; i <= normalized.length - n; i++) {
    const index = table.get(normalized.slice(i, i + n));
    if (index !== undefined) counts.set(index, (counts.get(index) || 0) + 1);
  }
  let norm = 0, dot = 0;
  for (const [index, count] of counts) {
    const value = (1 + Math.log(count)) * modelValue.idf[index];
    norm += value * value; dot += value * modelValue.weights[index];
  }
  return { margin: (norm ? dot / Math.sqrt(norm) : 0) + modelValue.intercept - modelValue.threshold, features: counts.size };
}

function sanitizeSupport(value) {
  if (!value || value.version !== VERSION || value.applied !== true
    || ![value.originalScore, value.score, value.margin].every(Number.isFinite)
    || value.originalScore < 21 || value.originalScore >= 50 || value.score < 50 || value.score > 74
    || value.margin <= 0 || !Number.isSafeInteger(value.features) || value.features < 100 || value.features > 30000
    || !PROFILES.has(value.profile)) return null;
  return { version: VERSION, modelVersion: MODEL_VERSION, applied: true,
    originalScore: value.originalScore, score: value.score,
    margin: value.margin, features: value.features, profile: value.profile };
}

function applyAssist(result, source, { profile, active = enabled(), modelValue } = {}) {
  const originalScore = result?.probability;
  if (!active || !PROFILES.has(profile) || typeof source !== 'string'
    || source.length < 500 || source.length > 2600
    || typeof originalScore !== 'number' || !Number.isFinite(originalScore) || originalScore < 21 || originalScore >= 50) return result;
  const letters = source.match(/[가-힣a-z]/giu) || [];
  if (!letters.length || (source.match(/[가-힣]/gu) || []).length / letters.length < 0.5) return result;
  const evidence = Array.isArray(result.signalEvidence) ? result.signalEvidence : [];
  if (!evidence.some(x => x && x.category !== 'other_observed_style'
    && ['moderate', 'strong'].includes(x.strength) && ['recurring', 'pervasive'].includes(x.scope)
    && Array.isArray(x.locations) && new Set(x.locations.filter(loc => Number.isSafeInteger(loc?.sentenceIndex) && loc.sentenceIndex >= 0).map(loc => loc.sentenceIndex)).size >= 2)) return result;
  try {
    const { margin, features } = marginFor(source, modelValue);
    if (!Number.isFinite(margin) || margin <= 0 || features < 100) return result;
    const probability = Math.max(originalScore, Math.min(74, Math.round(100 / (1 + Math.exp(-margin)))));
    return { ...result, probability, statisticalSupport: sanitizeSupport({
      version: VERSION, applied: true, originalScore, score: probability, margin, features, profile
    }) };
  } catch {
    // A missing/corrupt optional model never destroys a completed paid analysis.
    return result;
  }
}

module.exports = { VERSION, MODEL_VERSION, enabled, marginFor, sanitizeSupport, applyAssist };
