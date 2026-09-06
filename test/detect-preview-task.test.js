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
