'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { auc, calibration, operatingPoint, exactMcNemar, evaluateEvidenceScores } = require('../lib/detectEvaluation');
function sample() { return Array.from({ length: 40 }, (_, i) => ({ id: 'case-' + i, group: 'group-' + i,
  split: 'holdout', genre: 'explainer', lengthBucket: '300_999', authorship: i < 20 ? 'human_reference' : 'ai',
  baselineScore: i < 20 ? 10 : 20, candidateScore: i < 20 ? 10 : 80,
  baselineRepeats: [10, 11, 12], candidateRepeats: [10, 10, 10], baselineLatencyMs: 100, candidateLatencyMs: 101,
  baselineCostUsd: .001, candidateCostUsd: .001 })); }
test('rank AUC counts ties, degenerate labels remain unmeasured', () => {
  const rows = [10, 20, 20, 30].map((score, i) => ({ score, authorship: i < 2 ? 'human_reference' : 'ai' }));
  assert.equal(auc(rows, 'score'), .875);
  assert.equal(auc(rows.slice(0, 2), 'score'), null);
  assert.equal(operatingPoint(rows, 'score').threshold, 30);
});
test('calibration includes the 100 boundary and does not claim population probability', () => {
  const result = calibration([{ score: 0, authorship: 'human_reference' }, { score: 100, authorship: 'ai' }], 'score');
  assert.equal(result.ece, 0); assert.equal(result.brier, 0); assert.equal(result.reliability[9].n, 1);
  assert.match(result.meaning, /not a production/);
});
test('exact paired significance is stable for small and large counts', () => {
  assert.equal(exactMcNemar(0, 0), 1); assert.equal(exactMcNemar(4, 0), .125);
  assert.equal(exactMcNemar(1000, 1000), 1); assert(exactMcNemar(1000, 0) < 1e-100);
});
test('missing genres, repeats or performance cannot silently pass full release gate', () => {
  const result = evaluateEvidenceScores(sample());
  assert(result.reasons.includes('insufficient_genre:resume_application')); assert.equal(result.releaseEligible, false);
  const subset = evaluateEvidenceScores(sample(), { requiredGenres: ['explainer'] });
  assert.equal(subset.pointCriteriaPassed, true); assert.equal(subset.releaseEligible, false);
  const missing = sample().map(({ candidateRepeats, ...r }) => r);
  assert(evaluateEvidenceScores(missing, { requiredGenres: ['explainer'] }).reasons.includes('repeat_evidence_missing'));
  const invalid = sample(); invalid[0].candidateRepeats = [10, null, 12];
  assert.throws(() => evaluateEvidenceScores(invalid), /invalid_repeats/);
});
test('a higher AI mean never excuses new human false positives', () => {
  const rows = sample(); rows[0].candidateScore = 90;
  assert(evaluateEvidenceScores(rows).reasons.includes('human_false_positive_gate'));
});
