'use strict';
// Local research baseline. No LLM score, provider call, or existing detector margin.
const { sha, assertTrainingRows } = require('./detectBenchmark');
const { operatingPoint } = require('./detectEvaluation');
const { fastAuc } = require('./detectValidation');
const VERSION = 'korean-character-classifier-v1';
const PREPROCESS = 'nfc-whitespace-char234-tfidf-l2-v1';
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
function terms(text) {
  const s = text.normalize('NFC').replace(/\s+/gu, ' ').trim(), counts = new Map();
  for (const n of [2, 3, 4]) for (let i = 0; i + n <= s.length; i++) {
    const token = s.slice(i, i + n); counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}
function vocabulary(rows, limit) {
  const df = new Map();
  for (const r of rows) for (const t of terms(r.text).keys()) df.set(t, (df.get(t) || 0) + 1);
  const selected = [...df].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
  return { tokens: selected.map(([t]) => t), idf: selected.map(([, n]) => Math.log((1 + rows.length) / (1 + n)) + 1) };
}
function vector(text, model, index = new Map(model.tokens.map((t, i) => [t, i]))) {
  const entries = []; let norm = 0;
  for (const [t, n] of terms(text)) if (index.has(t)) {
    const i = index.get(t), v = (1 + Math.log(n)) * model.idf[i]; entries.push([i, v]); norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  return entries.map(([i, v]) => [i, v / norm]);
}
function fit(rows, { lambda = .01, vocabularySize = 5000, steps = 220 } = {}) {
  if (rows.some(r => !r.text || !['human_reference', 'ai'].includes(r.authorship))) throw Error('classifier_invalid_training_rows');
  if (!rows.some(r => r.authorship === 'human_reference') || !rows.some(r => r.authorship === 'ai')) throw Error('classifier_missing_class');
  const model = vocabulary(rows, vocabularySize), index = new Map(model.tokens.map((t, i) => [t, i]));
  const x = rows.map(r => vector(r.text, model, index)), weights = model.tokens.map(() => 0); let intercept = 0;
  if (weights.length < 10) throw Error('classifier_insufficient_vocabulary');
  for (let step = 0; step < steps; step++) {
    const grad = weights.map(w => lambda * w); let bias = 0;
    for (let j = 0; j < rows.length; j++) {
      const d = (sigmoid(intercept + x[j].reduce((s, [i, v]) => s + weights[i] * v, 0)) - Number(rows[j].authorship === 'ai')) / rows.length;
      bias += d; for (const [i, v] of x[j]) grad[i] += d * v;
    }
    const rate = 2 / Math.sqrt(1 + step / 50); intercept -= rate * bias;
    for (let i = 0; i < weights.length; i++) weights[i] -= rate * grad[i];
  }
  return { ...model, weights, intercept, lambda, steps };
}
function margin(text, model, index) { return model.intercept + vector(text, model, index).reduce((s, [i, v]) => s + model.weights[i] * v, 0); }
function calibrate(rows, model) {
  const index = new Map(model.tokens.map((t, i) => [t, i])), logits = rows.map(r => margin(r.text, model, index));
  let a = 1, b = 0;
  for (let step = 0; step < 2000; step++) {
    let ga = .001 * (a - 1), gb = .001 * b;
    rows.forEach((r, i) => { const d = (sigmoid(a * logits[i] + b) - Number(r.authorship === 'ai')) / rows.length; ga += d * logits[i]; gb += d; });
    a = Math.max(.01, Math.min(100, a - .1 * ga)); b -= .1 * gb;
  }
  return { plattA: a, plattB: b };
}
function validateModel(m) {
  return m?.version === VERSION && m.status === 'research_only' && m.preprocessVersion === PREPROCESS
    && Array.isArray(m.tokens) && m.tokens.length >= 10 && m.tokens.length <= 20000 && new Set(m.tokens).size === m.tokens.length
    && m.tokens.every(t => typeof t === 'string' && t.length >= 2 && t.length <= 4)
    && ['weights', 'idf'].every(k => Array.isArray(m[k]) && m[k].length === m.tokens.length && m[k].every(Number.isFinite))
    && m.idf.every(v => v > 0) && Number.isFinite(m.intercept) && Number.isFinite(m.plattA) && m.plattA > 0 && Number.isFinite(m.plattB);
}
const indexes = new WeakMap();
function predict(text, model) {
  if (typeof text !== 'string' || text.length < 100 || text.length > 20000 || !validateModel(model)) return null;
  const letters = (text.match(/[가-힣a-z]/giu) || []).length, hangul = (text.match(/[가-힣]/gu) || []).length;
  if (!letters || hangul / letters < .5) return null;
  if (!indexes.has(model)) indexes.set(model, new Map(model.tokens.map((t, i) => [t, i])));
  const v = vector(text, model, indexes.get(model)); if (v.length < 20) return null;
  const z = model.intercept + v.reduce((s, [i, x]) => s + model.weights[i] * x, 0);
  return { score: 100 * sigmoid(model.plattA * z + model.plattB), margin: z, matchedFeatures: v.length, version: VERSION };
}
function train(rows, { seed = 'style-classifier-v1', lambdas = [.001, .01, .1], vocabularySize = 5000 } = {}) {
  assertTrainingRows(rows);
  const groupPartition = group => parseInt(sha(seed + '\0' + group).slice(0, 8), 16) % 10;
  const fitRows = rows.filter(r => groupPartition(r.group) >= 3), calibrationRows = rows.filter(r => groupPartition(r.group) < 3);
  const counts = rs => ['human_reference', 'ai'].map(label => rs.filter(r => r.authorship === label).length);
  if (counts(fitRows).some(n => n < 20) || counts(calibrationRows).some(n => n < 10)) throw Error('classifier_insufficient_split');
  const cv = [];
  for (const lambda of lambdas) {
    const predictions = [];
    for (let fold = 0; fold < 3; fold++) {
      const foldOf = r => parseInt(sha('fold\0' + r.group).slice(0, 8), 16) % 3;
      const training = fitRows.filter(r => foldOf(r) !== fold), validation = fitRows.filter(r => foldOf(r) === fold);
      const model = fit(training, { lambda, vocabularySize });
      for (const r of validation) predictions.push({ ...r, score: 100 * sigmoid(margin(r.text, model)) });
    }
    cv.push({ lambda, n: predictions.length, auc: fastAuc(predictions, 'score'), atFpr05: operatingPoint(predictions, 'score', .05), atFpr01: operatingPoint(predictions, 'score', .01) });
  }
  cv.sort((a, b) => b.atFpr05.aiRecall - a.atFpr05.aiRecall || b.auc - a.auc || b.lambda - a.lambda);
  const fitModel = fit(fitRows, { lambda: cv[0].lambda, vocabularySize });
  const model = { version: VERSION, status: 'research_only', preprocessVersion: PREPROCESS, ...fitModel, ...calibrate(calibrationRows, fitModel),
    selection: 'Three grouped folds on fitting rows; separate development calibration rows.', cv, seed,
    trainingGroups: [...new Set(rows.map(r => r.group))], trainingLineageKeys: [...new Set(rows.flatMap(r => r.lineageKeys || []))], trainingTextHashes: [...new Set(rows.map(r => r.normalizedSha256))],
    fitGroups: [...new Set(fitRows.map(r => r.group))], calibrationGroups: [...new Set(calibrationRows.map(r => r.group))],
    counts: { fit: counts(fitRows), calibration: counts(calibrationRows) },
    definition: 'Korean character TF-IDF logistic classifier, independently fit and Platt-calibrated. No LLM score or prior detector weights. Not verified production authorship probabilities.' };
  if (!validateModel(model)) throw Error('classifier_invalid_model');
  const predictions = calibrationRows.map(r => ({ ...r, score: predict(r.text, model)?.score }));
  const byGenre = {};
  for (const genre of [...new Set(predictions.map(r => r.genre))]) {
    const rs = predictions.filter(r => r.genre === genre && Number.isFinite(r.score));
    if (counts(rs).some(n => n < 10)) continue;
    byGenre[genre] = Object.fromEntries([.01, .05].map(fpr => [String(fpr), operatingPoint(rs, 'score', fpr).threshold]));
  }
  const policy = { selectedOn: 'development_calibration', byGenre, calibrationGroups: model.calibrationGroups };
  policy.digest = sha(JSON.stringify(policy));
  return { model, thresholdPolicy: policy };
}
module.exports = { VERSION, PREPROCESS, terms, fit, margin, calibrate, train, validateModel, predict };
