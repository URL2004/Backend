'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutbox, documentId, stageInTransaction } = require('../lib/metaOutbox');

function database() {
  const rows = new Map();
  let chain = Promise.resolve();
  function ref(path) { return { path, delete: async () => rows.delete(path) }; }
  const db = {
    collection(name) { return { doc: id => ref(`${name}/${id}`) }; },
    runTransaction(callback) {
      const operation = chain.catch(() => {}).then(async () => {
        const draft = structuredClone(rows);
        const result = await callback({
          get: async item => ({ exists: draft.has(item.path), data: () => structuredClone(draft.get(item.path)) }),
          set: (item, data) => draft.set(item.path, structuredClone(data))
        });
        rows.clear();
        for (const [key, value] of draft) rows.set(key, value);
        return result;
      });
      chain = operation;
      return operation;
    }
  };
  return { db, rows, ref };
}

function fixture(send) {
  const data = database();
  let nowMs = 1800000000000;
  const event = { event_name: 'Purchase', event_id: 'purchase_order_test', event_time: nowMs / 1000, user_data: { client_ip_address: '203.0.113.1' } };
  const outbox = createOutbox({ db: data.db, send, now: () => nowMs });
  const ref = data.db.collection('metaConversionOutbox').doc(documentId(event));
  return { ...data, event, outbox, ref, now: () => nowMs, advance: ms => { nowMs += ms; }, row: () => data.rows.get(ref.path) };
}

test('outbox is atomic with the business transaction, including rollback', async () => {
  const f = fixture();
  await assert.rejects(f.db.runTransaction(async tx => {
    stageInTransaction(tx, f.db, f.event, 'uid', f.now());
    throw new Error('payment write failed');
  }));
  assert.equal(f.rows.size, 0);
  await f.db.runTransaction(async tx => stageInTransaction(tx, f.db, f.event, 'uid', f.now()));
  assert.equal(f.row().status, 'pending');
});

test('a failed send survives restart, retries the original event time/id, then removes identifiers', async () => {
  const seen = [];
  const f = fixture(async event => { seen.push(event); return { ok: false, retryable: true, status: 503 }; });
  await f.outbox.enqueue(f.event, 'uid');
  await f.outbox.deliver(f.ref);
  assert.equal(f.row().status, 'pending');
  assert.equal(await f.outbox.deliver(f.ref), false);
  f.advance(120000);
  const restarted = createOutbox({ db: f.db, now: f.now, send: async event => { seen.push(event); return { ok: true }; } });
  await restarted.deliver(f.ref);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(f.row().status, 'sent');
  assert.equal(f.row().event, null);
  assert.equal('nextAttemptAtMs' in f.row(), false);
  await restarted.enqueue(f.event, 'uid');
  assert.equal(await restarted.deliver(f.ref), false);
});

test('two workers lease one event once, without blocking the business transaction', async () => {
  let release;
  let sent = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { sent++; await gate; return { ok: true }; });
  await f.outbox.enqueue(f.event, 'uid');
  const first = f.outbox.deliver(f.ref);
  while (!sent) await new Promise(resolve => setImmediate(resolve));
  const other = createOutbox({ db: f.db, now: f.now, send: async () => { sent++; return { ok: true }; } });
  assert.equal(await other.deliver(f.ref), false);
  release();
  await first;
  assert.equal(sent, 1);
});

test('permanent API errors and expired events stop retries and discard matching data', async () => {
  const f = fixture(async () => ({ ok: false, retryable: false, status: 400 }));
  await f.outbox.enqueue(f.event, 'uid');
  await f.outbox.deliver(f.ref);
  assert.equal(f.row().status, 'failed');
  assert.equal(f.row().event, null);
  let sent = 0;
  const old = fixture(async () => { sent++; return { ok: true }; });
  await old.outbox.enqueue(old.event, 'uid');
  old.advance(25 * 3600000);
  await old.outbox.deliver(old.ref);
  assert.equal(sent, 0);
  assert.equal(old.row().status, 'failed');
});

test('a crashed worker lease becomes reclaimable with the original event id', async () => {
  let sent = 0;
  const f = fixture(async () => { sent++; return { ok: true }; });
  await f.outbox.enqueue(f.event, 'uid');
  Object.assign(f.row(), { status: 'sending', leaseToken: 'dead-worker', nextAttemptAtMs: f.now() + 60000 });
  assert.equal(await f.outbox.deliver(f.ref), false);
  f.advance(60001);
  await f.outbox.deliver(f.ref);
  assert.equal(sent, 1);
  assert.equal(f.row().status, 'sent');
});

test('first feature success is server-owned and shared across features and devices', async () => {
  const { recordFirstSuccess } = require('../lib/featureActivation');
  const { db, rows } = database();
  rows.set('users/uid', { createdAt: '2026-09-05T00:00:00.000Z', signupAttribution: { last_touch: { source: 'naver' } } });
  const request = { db, uid: 'uid', runId: 'job-123', feature: 'humanize', chars: 600, nowMs: 1800000000000 };
  const first = await recordFirstSuccess(request);
  assert.equal(first.firstSuccess, true);
  assert.equal(first.scope, 'since_20260905');
  assert.equal((await recordFirstSuccess(request)).eventId, first.eventId);
  assert.equal((await recordFirstSuccess({ ...request, runId: 'detect-456', feature: 'detect' })).firstSuccess, false);
  assert.equal(rows.get('featureActivations/uid').signupSource, 'naver');
  assert.equal(await recordFirstSuccess({ ...request, uid: 'missing' }), null);
  assert.equal(await recordFirstSuccess({ ...request, isInternal: true }), null);
});

test('first success and its CAPI Activation queue commit together without raw product text', async () => {
  const { recordFirstSuccess } = require('../lib/featureActivation');
  const { db, rows } = database();
  rows.set('users/uid', { email: 'person@example.com' });
  const original = process.env.META_CAPI_ACCESS_TOKEN;
  process.env.META_CAPI_ACCESS_TOKEN = 'test-only';
  try {
    await recordFirstSuccess({ db, uid: 'uid', runId: 'job-1', feature: 'detect', chars: 600, input_text: 'private text', nowMs: 1800000000000 });
    const queued = [...rows.entries()].filter(([key]) => key.startsWith('metaConversionOutbox/'));
    assert.equal(queued.length, 1);
    assert.equal(queued[0][1].event.event_name, 'Activation');
    assert.equal(JSON.stringify(queued).includes('person@example.com'), false);
    assert.equal(JSON.stringify(queued).includes('private text'), false);
    rows.set('accountDeletionJobs/uid', { status: 'processing' });
    assert.equal(await recordFirstSuccess({ db, uid: 'uid', runId: 'job-2', feature: 'humanize' }), null);
  } finally {
    if (original === undefined) delete process.env.META_CAPI_ACCESS_TOKEN;
    else process.env.META_CAPI_ACCESS_TOKEN = original;
  }
});
