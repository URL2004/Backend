'use strict';

const { sourceSentences } = require('./detectGrounding');
const { marginFor } = require('./detectStatisticalAssist');
const VERSION = 'detect-evidence-features-v1';
const FEATURE_NAMES = ['modelScore', 'ngramMargin', 'sentenceUniformity', 'endingRepetition', 'connectorRate', 'abstractClosureRate'];
const PROFILES = new Set(['general', 'report_assignment', 'long_explainer', 'resume_application', 'personal_essay', 'review_blog', 'student_self_assessment', 'social', 'unknown']);
const finite = v => typeof v === 'number' && Number.isFinite(v);

function extractFeatures(text, modelScore, profile) {
  if (typeof text !== 'string' || text.length < 100 || text.length > 4000 || !finite(modelScore) || modelScore < 0 || modelScore > 100) return null;
  const hangul = (text.match(/[가-힣]/gu) || []).length, letters = (text.match(/[가-힣a-z]/giu) || []).length;
  if (!letters || hangul / letters < .5 || !PROFILES.has(profile)) return null;
  if (profile === 'unknown' && text.length >= 300) return null;
  if (/(?:^|\n)\s*(?:>|\||```|참고문헌|references\b)/imu.test(text) || /[“"][^”"]{100,}[”"]/u.test(text)) return null;
  const sentences = sourceSentences(text).map(s => s.text), n = sentences.length;
  if (!n) return null;
  const lengths = sentences.map(s => s.replace(/\s/gu, '').length), mean = lengths.reduce((s, v) => s + v, 0) / n;
  const cv = mean ? Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / n) / mean : 0;
  const endings = new Map();
  for (const sentence of sentences) {
    const clean = sentence.replace(/[^가-힣]/gu, '');
    if (clean.length >= 2) { const end = clean.slice(-2); endings.set(end, (endings.get(end) || 0) + 1); }
  }
  const statistics = marginFor(text);
  if (!finite(statistics.margin) || statistics.features < 30) return null;
  const connectorRate = sentences.filter(s => /^(?:따라서|그러므로|결론적으로|또한|한편|이러한|이를 통해|종합하면|더 나아가)/u.test(s.trim())).length / n;
  const abstractClosureRate = sentences.filter(s => /(?:중요(?:성|하다|합니다)|기여할|필수적|긍정적인 영향|의미가 있|기대할 수|발전시킬)/u.test(s)).length / n;
  return { version: VERSION, profile, chars: text.length, sentences: n, matchedFeatures: statistics.features,
    values: [modelScore / 100, Math.max(-5, Math.min(5, statistics.margin)), n < 2 ? 0 : 1 / (1 + cv),
      n < 2 ? 0 : Math.max(0, ...endings.values()) / n, connectorRate, abstractClosureRate] };
}

function validateModel(model) {
  if (!model || model.version !== 'detect-evidence-fusion-v1' || model.status !== 'research_only' || model.featureVersion !== VERSION
    || JSON.stringify(model.featureNames) !== JSON.stringify(FEATURE_NAMES) || !Array.isArray(model.models) || !model.models.length || model.models.length > 12) return false;
  return model.models.every(m => /^[a-z0-9_-]{1,50}$/u.test(m.key || '') && Array.isArray(m.profiles) && m.profiles.length > 0 && m.profiles.every(p => PROFILES.has(p))
    && Number.isInteger(m.minChars) && m.minChars >= 100 && Number.isInteger(m.maxChars) && m.maxChars <= 4000 && m.minChars <= m.maxChars
    && ['weights', 'mean', 'scale'].every(k => Array.isArray(m[k]) && m[k].length === FEATURE_NAMES.length && m[k].every(finite))
    && m.weights.every(w => w >= 0 && w <= 100) && m.scale.every(s => s > 0 && s <= 100) && finite(m.intercept) && Math.abs(m.intercept) <= 100
    && finite(m.plattA) && m.plattA > 0 && m.plattA <= 100 && finite(m.plattB) && Math.abs(m.plattB) <= 100);
}

function predict(features, model) {
  if (!features || !validateModel(model)) return null;
  const candidates = model.models.filter(m => features.chars >= m.minChars && features.chars <= m.maxChars && m.profiles.includes(features.profile));
  if (candidates.length !== 1) return null;
  const m = candidates[0];
  if (!Array.isArray(features.values) || features.values.length !== FEATURE_NAMES.length || !features.values.every(finite)) return null;
  const z = m.intercept + m.weights.reduce((s, w, i) => s + w * (features.values[i] - m.mean[i]) / m.scale[i], 0);
  const score = 100 / (1 + Math.exp(-Math.max(-30, Math.min(30, m.plattA * z + m.plattB))));
  return { score: Math.round(score), modelKey: m.key };
}

module.exports = { VERSION, FEATURE_NAMES, PROFILES, extractFeatures, validateModel, predict };
