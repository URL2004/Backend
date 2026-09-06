'use strict';

// Local, deterministic research training. No network, subprocesses or production writes.
const fs = require('node:fs');
const { sha, assertManifest, assertTrainingRows } = require('../lib/detectBenchmark');
const { FEATURE_NAMES, VERSION, extractFeatures, validateModel } = require('../lib/detectEvidenceFeatures');
const [corpusPath, manifestPath, observationsPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/train-detect-evidence.js corpus.json manifest.json observations.json model.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const corpus = read(corpusPath), manifest = read(manifestPath), observations = read(observationsPath);
assertManifest(manifest, corpus);
const source = new Map(corpus.map(r => [r.id, r])), observed = new Map(observations.map(r => [r.id, r]));
if (observed.size !== observations.length) throw Error('training_duplicate_observations');
const records = manifest.records.filter(r => observed.has(r.id));
if (records.length !== observations.length) throw Error('training_unknown_observation');
assertTrainingRows(records);
const prepared = records.flatMap(r => {
  const o = observed.get(r.id);
  if (o.sha256 !== r.sha256) throw Error('training_text_mismatch');
  const f = extractFeatures(source.get(r.id).text, o.modelScore, o.profile);
  return f ? [{ ...r, features: f, label: r.authorship === 'ai' ? 1 : 0 }] : [];
});
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const mean = values => values.reduce((s, v) => s + v, 0) / values.length;
function fit(rows) {
  const center = FEATURE_NAMES.map((_, i) => mean(rows.map(r => r.features.values[i])));
  const scale = center.map((m, i) => Math.max(.01, Math.sqrt(mean(rows.map(r => (r.features.values[i] - m) ** 2)))));
  const x = rows.map(r => r.features.values.map((v, i) => (v - center[i]) / scale[i]));
  const weights = FEATURE_NAMES.map(() => 0); let intercept = 0;
  for (let step = 0; step < 1800; step++) {
    const grad = weights.map(w => .02 * w); let interceptGrad = 0;
    rows.forEach((r, j) => {
      const error = (sigmoid(intercept + weights.reduce((s, w, i) => s + w * x[j][i], 0)) - r.label) / rows.length;
      interceptGrad += error; grad.forEach((_, i) => { grad[i] += error * x[j][i]; });
    });
    intercept -= .05 * interceptGrad;
    weights.forEach((_, i) => { weights[i] = Math.max(0, Math.min(100, weights[i] - .05 * grad[i])); });
  }
  return { weights, mean: center, scale, intercept };
}
function platt(rows, model) {
  const logits = rows.map(r => model.intercept + model.weights.reduce((s, w, i) => s + w * (r.features.values[i] - model.mean[i]) / model.scale[i], 0));
  let a = 1, b = 0;
  for (let step = 0; step < 1500; step++) {
    let ga = .02 * (a - 1), gb = .02 * b;
    rows.forEach((r, i) => { const d = (sigmoid(a * logits[i] + b) - r.label) / rows.length; ga += d * logits[i]; gb += d; });
    a = Math.max(.05, Math.min(100, a - .03 * ga)); b = Math.max(-100, Math.min(100, b - .03 * gb));
  }
  return { plattA: a, plattB: b };
}
const specs = [
  { key: 'short_review_research', genres: ['short_review', 'review_blog'], profiles: ['unknown', 'general', 'review_blog', 'social', 'personal_essay'], minChars: 100, maxChars: 299 },
  { key: 'explainer_research', genres: ['explainer'], profiles: ['general', 'report_assignment', 'long_explainer'], minChars: 300, maxChars: 4000 }
];
const models = [], skipped = [];
for (const spec of specs) {
  const selected = prepared.filter(r => spec.genres.includes(r.genre) && r.chars >= spec.minChars && r.chars <= spec.maxChars && spec.profiles.includes(r.features.profile));
  // Reserve a calibration subset inside development, grouped independently of final holdout.
  const isCalibration = r => parseInt(sha('calibration-v1\0' + r.group).slice(0, 8), 16) / 0x100000000 < .3;
  const fitting = selected.filter(r => !isCalibration(r)), calibrating = selected.filter(isCalibration);
  const counts = a => [a.filter(r => r.label === 0).length, a.filter(r => r.label === 1).length];
  if (counts(fitting).some(n => n < 20) || counts(calibrating).some(n => n < 10)) { skipped.push({ key: spec.key, fit: counts(fitting), calibration: counts(calibrating) }); continue; }
  const trained = fit(fitting);
  models.push({ ...spec, ...trained, ...platt(calibrating, trained), fitCounts: counts(fitting), calibrationCounts: counts(calibrating),
    fitGroups: [...new Set(fitting.map(r => r.group))], calibrationGroups: [...new Set(calibrating.map(r => r.group))] });
}
const model = { version: 'detect-evidence-fusion-v1', status: 'research_only', featureVersion: VERSION, featureNames: FEATURE_NAMES,
  manifestDigest: manifest.digest, trainingGroups: [...new Set(prepared.map(r => r.group))], models,
  definition: 'Monotone logistic fusion with separate development Platt calibration. Benchmark-mixture research scores only; no verified authorship probability.',
  trainingSources: [...new Set(records.map(r => r.source))], licenses: [...new Set(records.map(r => r.license))],
  skipped, prepared: prepared.length, observations: observations.length };
if (!validateModel(model)) throw Error('training_no_valid_model');
fs.writeFileSync(outputPath, JSON.stringify(model, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ prepared: prepared.length, models: models.map(m => ({ key: m.key, fit: m.fitCounts, calibration: m.calibrationCounts })), skipped, status: model.status }));
