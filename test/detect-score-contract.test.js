'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertScore, scoreContract } = require('../lib/detectScoreContract');
const { DETECT_SCHEMA } = require('../engine-gpt-prod/schemas');
const { groundSignals } = require('../lib/detectGrounding');
const policy = require('../lib/detectEvidenceReview');
const source = '협력은 중요한 가치를 실현하는 기반이다. 소통은 새로운 가치를 창출하는 핵심이다.';
const evidence = () => groundSignals([{ category: 'generic_abstraction', strength: 'moderate',
  scope: 'recurring', evidenceSentences: [0, 1] }], source);

test('provider score has one integer unit, with valid zero and one', () => {
  assert.deepEqual(DETECT_SCHEMA.properties.probability, { type: 'integer', minimum: 0, maximum: 100 });
  for (let score = 0; score <= 100; score++) assert.equal(assertScore(score), score);
  for (const score of [.03, .43, .57, 20.49, -1, 101, NaN, Infinity, null, undefined, '43']) {
    assert.equal(scoreContract(score).valid, false);
    assert.throws(() => assertScore(score), { code: 'DETECT_SCORE_CONTRACT' });
  }
});

test('review selection tests low and high conflicts, keeps complete single-judge result', () => {
  const primary = { probability: 34, signalEvidence: evidence() };
  for (const probability of [0, 1, .43, 101, 72]) {
    const reviewed = { probability, signalEvidence: evidence() };
    assert.equal(policy.selectReviewedCandidate(primary, reviewed, source).result, primary);
  }
  const lower = { probability: 8, signalEvidence: [] };
  assert.equal(policy.selectReviewedCandidate(primary, lower, source).result, lower);
  const lowConflict = { probability: 1, signalEvidence: evidence() };
  assert.equal(policy.candidateConsistency(lowConflict, source).reason, 'low_score_recurring_evidence');
  assert.equal(require('../lib/detectDiagnostics').recheckReason(lowConflict, source,
    { models: { detect: 'one', detectEscalation: 'two' } }), 'low_score_evidence_conflict');
  const badLocation = { probability: 34, signalEvidence: evidence().map(s => ({ ...s,
    locations: [{ start: 999, end: 1000 }] })) };
  assert.equal(policy.candidateConsistency(badLocation, source).reason, 'evidence_location_mismatch');
});

test('actual chain rejects malformed primary/review without guessing scale or losing billed usage', async t => {
  const client = require('../engine-gpt-prod/openaiClient'), original = client.completeJson;
  let queue;
  client.completeJson = async options => {
    assert(queue.length, 'no extra model retry');
    return { json: queue.shift(), model: options.model,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, estimatedUsd: .01 } };
  };
  delete require.cache[require.resolve('../engine-gpt-prod')];
  const engine = require('../engine-gpt-prod');
  client.completeJson = original;
  t.after(() => { delete require.cache[require.resolve('../engine-gpt-prod')]; });
  const config = { models: { detect: 'primary-test', detectEscalation: 'review-test' } };
  const valid = { probability: 34, confidence: 'high', signals: [{ category: 'generic_abstraction',
    strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }] };
  for (const [responses, expected, selected] of [
    [[{ probability: .43, signals: [], confidence: 'high' }, { probability: 12, signals: [], confidence: 'high' }], 12, 'recheck'],
    [[valid, { ...valid, probability: .57 }], 34, 'primary'],
    [[valid, { ...valid, probability: 0 }], 34, 'primary']
  ]) {
    queue = responses;
    const result = await engine.detect({ text: source, config, allowLocalFallback: false });
    assert.equal(result.probability, expected);
    assert.equal(result.detectDiagnostics.selectedPhase, selected);
    assert.equal(result.detectDiagnostics.attempts.length, 2);
    assert.equal(result.gptMeta.usage.totalTokens, 40);
    assert.equal(queue.length, 0);
  }
  queue = [{ probability: .43 }, { probability: .57 }];
  await assert.rejects(engine.detect({ text: source, config, allowLocalFallback: false }), { code: 'DETECT_SCORE_CONTRACT' });
  assert.equal(queue.length, 0);
});
