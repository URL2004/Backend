'use strict';

const VERSION = 'statistical-assist-v4-evidence-bounded';
const MODEL_VERSION = 'korean-style-statistics-v1';
const PROFILES = new Set(['general', 'report_assignment', 'long_explainer']);
const tables = new WeakMap();
let model;

function enabled(value = process.env.DETECT_STATISTICAL_ASSIST_ENABLED) {
  return /^(1|true|on|yes)$/iu.test(String(value || '').trim());
}
function independentEnabled(value = process.env.DETECT_INDEPENDENT_STATISTICS_ENABLED) {
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
  const independent = value?.basis === 'independent_statistics';
  const modern = value?.version === VERSION;
  if (!value || ![VERSION, 'statistical-assist-v3-monotone', 'statistical-assist-v2', 'statistical-assist-v1'].includes(value.version) || value.applied !== true
    || ![value.originalScore, value.score, value.margin].every(Number.isFinite)
    || value.originalScore < (independent ? 0 : 21) || value.originalScore >= (modern ? 74 : 50)
    || value.score < (independent && modern ? 21 : 50) || value.score > (independent && modern ? 49 : 74) || value.score <= value.originalScore
    || value.margin <= 0 || !Number.isSafeInteger(value.features) || value.features < 100 || value.features > 30000
    || (independent && (!modern && value.version !== 'statistical-assist-v2' || value.margin < 0.05))
    || !PROFILES.has(value.profile)) return null;
  return { version: value.version, modelVersion: MODEL_VERSION, applied: true,
    originalScore: value.originalScore, score: value.score,
    margin: value.margin, features: value.features, profile: value.profile,
    ...(independent ? { basis: 'independent_statistics' } : {}) };
}

function applyAssist(result, source, { profile, active = enabled(), independentActive = independentEnabled(), modelValue } = {}) {
  const originalScore = result?.probability;
  if (!active || !PROFILES.has(profile) || typeof source !== 'string'
    || source.length < 500 || source.length > 2600
    || typeof originalScore !== 'number' || !Number.isFinite(originalScore) || originalScore < 0 || originalScore >= 74) return result;
  const document = require('./detectInputDocument').buildDetectInputDocument(source);
  // The exported model was validated on prose. Both support branches must use
  // the same protection gate; a model cause cannot authorize quoted/table text.
  // Mixed protected documents stay out of this optional model until validated.
  if (document.protectedSpans.length) return result;
  const letters = source.match(/[가-힣a-z]/giu) || [];
  if (!letters.length || (source.match(/[가-힣]/gu) || []).length / letters.length < 0.5) return result;
  const evidence = Array.isArray(result.signalEvidence) ? result.signalEvidence : [];
  const groundedModelSupport = originalScore >= 21 && evidence.some(x => x && x.category !== 'other_observed_style'
    && ['moderate', 'strong'].includes(x.strength) && ['recurring', 'pervasive'].includes(x.scope)
    && Array.isArray(x.locations) && new Set(x.locations.filter(loc => Number.isSafeInteger(loc?.sentenceIndex) && loc.sentenceIndex >= 0).map(loc => loc.sentenceIndex)).size >= 2);
  const independentScope = independentActive && result.confidence !== 'low'
    && document.eligibleSentenceCount >= 4;
  if (!groundedModelSupport && !independentScope) return result;
  try {
    const { margin, features } = marginFor(source, modelValue);
    if (!Number.isFinite(margin) || margin <= 0 || features < 100) return result;
    if (!groundedModelSupport && margin < 0.05) return result;
    // 독립 통계는 문장별 원인을 제공하지 않으므로 단독으로는 중간 구간
    // 상한(49)까지만 지지한다. 모델이 반복 위치까지 확인한 원인 한 건이
    // 있을 때 통계를 두 번째 독립 근거로 세어 높은 구간(50~74)을 허용한다.
    const ceiling = groundedModelSupport ? 74 : 49;
    const probability = Math.max(originalScore, Math.min(ceiling, Math.round(100 / (1 + Math.exp(-margin)))));
    if (probability === originalScore) return result;
    return { ...result, probability, statisticalSupport: sanitizeSupport({
      version: VERSION, applied: true, originalScore, score: probability, margin, features, profile,
      ...(!groundedModelSupport ? { basis: 'independent_statistics' } : {})
    }) };
  } catch {
    // A missing/corrupt optional model never destroys a completed paid analysis.
    return result;
  }
}

module.exports = { VERSION, MODEL_VERSION, enabled, independentEnabled, marginFor, sanitizeSupport, applyAssist };
