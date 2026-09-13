'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateConsistencyComparison: evaluate } = require('../lib/detectEvaluation');
const repeats = (values, seconds = 1, usd = .001) => values.map(score => ({ score, seconds, usd }));
const row = (id, baseline, candidate, label = 'unknown') => ({ id, genre: 'explainer', label,
  cacheExcluded: true, historyCalibrationExcluded: true, baseline: repeats(baseline), candidate: repeats(candidate) });

test('consistency evaluation separates band flips from variance and never approves a small development screen', () => {
  const report = evaluate([row('a', [58, 46, 36], [42, 43, 44])]);
  assert.equal(report.pairs[0].baseline.range, 22);
  assert.equal(report.pairs[0].candidate.range, 2);
  assert.equal(report.pairs[0].baseline.bands, 2);
  assert.equal(report.pairs[0].candidate.bands, 1);
  assert.equal(report.releaseEligible, false);
  assert.deepEqual(report.reasons, ['insufficient_labelled_genre_coverage']);
});

test('stable but uniformly lower scores, high false positives or large costs are not improvements', () => {
  const ai = row('ai', [34, 32, 33], [16, 16, 16], 'ai');
  const human = row('human', [20, 22, 21], [58, 58, 58], 'human_reference');
  human.candidate = repeats([58, 58, 58], 3, .004);
  const report = evaluate([ai, human]);
  for (const reason of ['ai_low_band_sensitivity_regression', 'human_false_positive_regression', 'cost_overhead', 'latency_overhead']) {
    assert.ok(report.reasons.includes(reason));
  }
  assert.equal(report.diagnosticPass, false);
});

test('cached results, malformed repeats, duplicates and missing cost are not accepted as repeat evidence', () => {
  const valid = row('a', [10, 11, 12], [10, 11, 12]);
  assert.throws(() => evaluate([]), /empty/);
  assert.throws(() => evaluate([valid, valid]), /duplicate/);
  assert.throws(() => evaluate([{ ...valid, cacheExcluded: false }]), /incomparable/);
  assert.throws(() => evaluate([{ ...valid, candidate: repeats([1, 2]) }]), /repeats/);
  assert.throws(() => evaluate([{ ...valid, candidate: repeats([1, 2, 3, 4]) }]), /unpaired/);
  assert.throws(() => evaluate([{ ...valid, candidate: [{ score: 1 }, { score: 2 }, { score: 3 }] }]), /repeats/);
});
