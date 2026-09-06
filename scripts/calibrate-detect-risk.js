'use strict';
const fs = require('node:fs');
const { assertManifest } = require('../lib/detectBenchmark');
const { predict } = require('../lib/detectStyleClassifier');
const { fitCalibration } = require('../lib/detectRiskCalibration');
const [corpusPath, manifestPath, modelPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/calibrate-detect-risk.js corpus.json manifest.json model.json policy.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const corpus = read(corpusPath), manifest = read(manifestPath), model = read(modelPath);
assertManifest(manifest, corpus);
if (fs.existsSync(outputPath)) throw Error('risk_output_already_exists');
const texts = new Map(corpus.map(r => [r.id, r.text]));
const selected = manifest.records.filter(r => r.split === 'development' && r.authorship === 'human_reference');
const rows = [], excluded = [];
for (const r of selected) {
  const prediction = predict(texts.get(r.id), model);
  if (!prediction) { excluded.push({ id: r.id, reason: 'classifier_out_of_scope' }); continue; }
  rows.push({ ...r, margin: prediction.margin });
}
const policy = fitCalibration(rows, model);
fs.writeFileSync(outputPath, JSON.stringify(policy, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: 'research_only', documents: policy.documentCount, families: policy.familyCount,
  cutoffMargin: policy.cutoffMargin, targetFpr: policy.targetFpr, failureProbability: policy.failureProbability,
  excluded, note: 'Requires fresh independent validation before a public scoring change.' }));
