'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDetectPreview } = require('../lib/detectPreviewTask');

test('a fast detection result still waits for the independently generated sentence preview', async () => {
  let complete;
  const preview = startDetectPreview(() => new Promise(resolve => { complete = resolve; }));
  const detection = await Promise.resolve({ probability: 9 });
  assert.equal(detection.probability, 9);
  complete({ before: 'Original sentence.', after: 'Rewritten sentence.' });
  assert.equal((await preview.result).after, 'Rewritten sentence.');
});
test('preview deadline resolves even if a provider ignores abort; late output cannot replace it', async () => {
  let complete, signal;
  const preview = startDetectPreview(s => { signal = s; return new Promise(resolve => { complete = resolve; }); }, { timeoutMs: 15 });
  assert.equal(await preview.result, null);
  assert.equal(signal.aborted, true);
  complete({ after: 'Too late' });
  assert.equal(await preview.result, null);
});
test('failed detection can cancel preview without waiting for its deadline', async () => {
  const preview = startDetectPreview(() => new Promise(() => {}));
  preview.cancel();
  assert.equal(await preview.result, null);
});
test('preview failure is isolated from the paid detection result', async () => {
  let observed;
  const preview = startDetectPreview(async () => { throw new Error('provider unavailable'); }, { onError: e => { observed = e.message; } });
  assert.equal(await preview.result, null);
  assert.equal(observed, 'provider unavailable');
});

test('deadline, caller cancellation and provider rejection have distinct, single outcomes', async () => {
  for (const state of ['deadline', 'cancelled', 'provider_error']) {
    const outcomes = [], errors = [];
    let reject;
    const p = startDetectPreview(() => new Promise((_, r) => { reject = r; }), {
      timeoutMs: 10, onError: e => errors.push(e), onOutcome: x => outcomes.push(x)
    });
    await Promise.resolve();
    if (state === 'cancelled') p.cancel();
    if (state === 'provider_error') reject(Error('provider'));
    await p.result;
    reject(Error('late rejection')); await new Promise(r => setImmediate(r)); p.cancel();
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].status, state);
    assert.equal(errors.length, state === 'provider_error' ? 1 : 0);
    assert.ok(p.outcome.elapsedMs >= 0);
  }
});
