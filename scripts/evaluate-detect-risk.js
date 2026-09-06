'use strict';
const fs = require('node:fs'), path = require('node:path');
const { sha, assertManifest, consumeHoldout } = require('../lib/detectBenchmark');
const risk = require('../lib/detectRiskCalibration');
const { evaluateValidation } = require('../lib/detectValidation');
const [corpusPath, manifestPath, modelPath, policyPath, scoresPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/evaluate-detect-risk.js corpus.json manifest.json model.json policy.json scores.json output.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const corpus = read(corpusPath), manifest = read(manifestPath), model = read(modelPath), policy = read(policyPath), scores = read(scoresPath);
assertManifest(manifest, corpus);
const expected = manifest.records.filter(r => r.split === 'holdout' && r.permissions.evaluate && ['human_reference', 'ai'].includes(r.authorship));
risk.assertIndependentValidation(policy, model, expected);
if (fs.existsSync(outputPath) || scores.length !== expected.length || new Set(scores.map(r => r.id)).size !== expected.length) throw Error('risk_incomplete_or_existing_evaluation');
const sources = new Map(corpus.map(r => [r.id, r.text])), metadata = new Map(expected.map(r => [r.id, r]));
const rows = scores.map(s => {
  const r = metadata.get(s.id);
  if (!r || s.sha256 !== r.sha256 || s.candidateHash !== policy.digest) throw Error('risk_evaluation_source_or_policy_mismatch');
  const prediction = risk.predict(sources.get(r.id), model, policy);
  if (s.candidateScore !== (prediction?.score ?? s.baselineScore)
    || s.candidateStatus !== (prediction ? 'scored' : 'fallback')) throw Error('risk_evaluation_prediction_mismatch');
  return { ...s, ...r };
});
// The same pooled cutoff applies to every observed genre; these are not
// independently fitted or separately certified genre policies.
const thresholds = { selectedOn: 'development_calibration',
  byGenre: Object.fromEntries([...new Set(rows.map(r => r.genre))].map(g => [g, { '0.05': 50 }])), calibrationGroups: policy.calibrationGroups };
thresholds.digest = sha(JSON.stringify(thresholds));
const report = evaluateValidation(rows, { thresholdPolicy: thresholds });
const receipt = consumeHoldout(path.join(path.dirname(manifestPath), manifest.digest + '.holdout-consumed.json'), { manifest, candidateHash: policy.digest });
fs.writeFileSync(outputPath, JSON.stringify({ ...report, policyDigest: policy.digest, receipt }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ n: rows.length, releaseEligible: false, reasons: report.reasons }));
