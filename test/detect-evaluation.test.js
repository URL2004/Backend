'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePairedScores, wilson } = require('../lib/detectEvaluation');
function fixture(split = 'holdout') {
  return Array.from({ length: 20 }, (_, i) => [
    { id: 'h' + i, group: 'g' + i, split, authorship: 'human_reference', baselineScore: 10, candidateScore: 10 },
    { id: 'a' + i, group: 'g' + i, split, authorship: 'ai', baselineScore: 10, candidateScore: i === 0 ? 50 : 10 }
  ]).flat();
}
test('release gate requires five percentage points and no added human false positives', () => {
  assert.equal(evaluatePairedScores(fixture()).releaseEligible, true);
  const rows = fixture(); rows[0].candidateScore = 50;
  const result = evaluatePairedScores(rows);
  assert.equal(result.releaseEligible, false);
  assert.equal(result.metrics[50].ai.delta, .05);
  assert.equal(result.metrics[50].human_reference.pairedRaised, 1);
  assert.equal(evaluatePairedScores(fixture('development'), { split: 'development' }).releaseEligible, false);
});
test('paired evaluation rejects leakage, missing results, duplicate IDs and wrong labels', () => {
  const rows = fixture(); rows[0].split = 'development';
  assert.throws(() => evaluatePairedScores(rows), /group_leakage/);
  const missing = fixture(); missing[0].candidateScore = null;
  assert.throws(() => evaluatePairedScores(missing), /invalid_score/);
  assert.throws(() => evaluatePairedScores([...fixture(), fixture()[0]]), /duplicate/);
  assert.throws(() => evaluatePairedScores(fixture().filter(x => x.authorship === 'ai')), /missing_label/);
});
test('zero-error sample retains nonzero uncertainty and boundaries count at 21 and 50', () => {
  assert(wilson(0, 20)[1] > .1);
  const rows = fixture(); rows[0].candidateScore = 21;
  const result = evaluatePairedScores(rows);
  assert.equal(result.metrics[21].human_reference.candidatePositive, 1);
  assert.equal(result.metrics[50].human_reference.candidatePositive, 0);
});
