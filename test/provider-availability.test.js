'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createProviderAvailability } = require('../lib/providerAvailability');
const recovery = require('../lib/transformProviderRecovery');
function fixture() {
  let state = null, now = 1000, reads = 0, tail = Promise.resolve();
  const store = { read: async () => { reads++; return state; }, update: fn => {
    const run = tail.then(() => { const result = fn(state); state = result.state; return result; });
    tail = run.catch(() => {}); return run;
  } };
  return { store, clock: () => now, advance: ms => { now += ms; }, get state() { return state; }, get reads() { return reads; },
    client: () => createProviderAvailability({ store, clock: () => now, pauseMs: 100, probeMs: 500, cacheMs: 10 }) };
}
test('quota pauses all instances; a single real recovery request is admitted', async () => {
  const f = fixture(), a = f.client(), b = f.client();
  const ordinary = await a.beforeRequest();
  await a.quota();
  await a.settle(ordinary, true);
  await assert.rejects(a.beforeRequest(), { code: 'OPENAI_QUOTA_EXHAUSTED' });
  await assert.rejects(b.beforeRequest(), { code: 'OPENAI_QUOTA_EXHAUSTED' });
  f.advance(101);
  const results = await Promise.allSettled([a.beforeRequest(), b.beforeRequest()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const ticket = results.find(r => r.status === 'fulfilled').value;
  await a.settle(ticket, true); f.advance(11);
  assert.equal(await b.beforeRequest(), null);
  assert.equal(f.state.open, false);
});
test('new quota invalidates stale recovery success; abandoned probes expire', async () => {
  const f = fixture(), a = f.client(), b = f.client();
  await a.quota(); f.advance(101); const old = await a.beforeRequest();
  await b.quota(); await a.settle(old, true);
  assert.equal(f.state.open, true);
  f.advance(101); const abandoned = await a.beforeRequest();
  f.advance(501); const replacement = await b.beforeRequest();
  assert.notEqual(replacement.probeId, abandoned.probeId);
  await a.settle(abandoned, true); assert.equal(f.state.open, true);
  await b.settle(replacement, false); assert.equal(f.state.open, true);
});
test('healthy concurrent calls coalesce the operational read; no per-chunk transaction', async () => {
  const f = fixture(), a = f.client();
  assert.deepEqual(await Promise.all(Array.from({ length: 50 }, () => a.beforeRequest())), Array(50).fill(null));
  assert.equal(f.reads, 1); assert.equal(f.state, null);
});
test('late pre-outage read and a failed circuit write cannot erase local cooldown', async () => {
  let release, now = 1000;
  const a = createProviderAvailability({ clock: () => now, cacheMs: 1,
    store: { read: () => new Promise(resolve => { release = resolve; }), update: async () => { throw Error('offline'); } } });
  const reading = a.snapshot(); await Promise.resolve();
  await a.quota(); release(null); await reading;
  await assert.rejects(a.beforeRequest(), { code: 'OPENAI_QUOTA_EXHAUSTED' });
});
test('outage recovery is bounded, retains mode/evidence/price, and never bills or downgrades', () => {
  for (const mode of ['blog', 'formal', 'polish']) {
    const job = { id: 'fixture', uid: 'synthetic', status: 'running', text: '보존할 합성 원문', mode, needed: 80, deducted: false, approvedEvidence: 'evidence' };
    assert.equal(recovery.defer(job, 61000, 1000), true);
    assert.equal(job.status, 'queued'); assert.equal(job.retryNotBeforeMs, 61000);
    assert.equal(recovery.payload(job).automaticResume, true);
    recovery.defer(job, 99999999, 1000 + recovery.HOLD_MS);
    assert.equal(job.status, 'error'); assert.equal(recovery.canRetry(job), true);
    assert.equal(job.mode, mode); assert.equal(job.needed, 80); assert.equal(job.deducted, false);
    assert.equal(job.text, '보존할 합성 원문'); assert.equal(job.approvedEvidence, 'evidence');
    assert.equal(recovery.payload(job).automaticResume, false);
  }
});
test('saved completions, payments and cancellation bypass provider recovery', () => {
  for (const job of [{ status: 'running', pendingCompletion: {} }, { status: 'done' }, { status: 'cancelled' }, { status: 'awaiting_payment' }]) {
    const before = JSON.stringify(job); assert.equal(recovery.defer(job, 100), false); assert.equal(JSON.stringify(job), before);
  }
});
