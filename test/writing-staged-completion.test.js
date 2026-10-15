'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { creditHistoryDocumentId } = require('../lib/creditLotAccounting');
const lifecycle = require('../engine-writing-v1/requestLifecycle');
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function firestore() {
  const rows = new Map(), versions = new Map();
  const deletion = { __delete: true };
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const apply = (base, patch) => {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value?.__delete) delete result[key];
      else result[key] = clone(value);
    }
    return result;
  };
  const put = (key, value) => { rows.set(key, clone(value)); versions.set(key, (versions.get(key) || 0) + 1); };
  const snapshot = ref => ({ id: ref.id, exists: rows.has(ref.path), data: () => clone(rows.get(ref.path)) });
  class Ref { constructor(path) { this.path = path; this.id = path.split('/').at(-1); }
    collection(name) { return new Collection(this.path + '/' + name); } async get() { return snapshot(this); } }
  class Collection { constructor(path) { this.path = path; } doc(id) { return new Ref(this.path + '/' + id); } }
  const db = { rows, put, beforeCommit: null, afterCommit: null,
    collection(name) { return new Collection(name); },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const reads = new Map(), writes = []; let startedWrites = false;
        const tx = {
          async get(ref) { assert.equal(startedWrites, false, 'all reads precede all writes'); reads.set(ref.path, versions.get(ref.path) || 0); return snapshot(ref); },
          set(ref, value, options) { startedWrites = true; writes.push({ ref, value, merge: options?.merge }); },
          update(ref, value) { startedWrites = true; writes.push({ ref, value, merge: true }); },
          create(ref, value) { startedWrites = true; assert.equal(rows.has(ref.path), false); writes.push({ ref, value }); },
          delete(ref) { startedWrites = true; writes.push({ ref, remove: true }); }
        };
        const value = await fn(tx);
        if (db.beforeCommit) { const hook = db.beforeCommit; db.beforeCommit = null; await hook(); }
        if ([...reads].some(([key, version]) => (versions.get(key) || 0) !== version)) continue;
        for (const write of writes) {
          if (write.remove) { rows.delete(write.ref.path); versions.set(write.ref.path, (versions.get(write.ref.path) || 0) + 1); }
          else put(write.ref.path, write.merge ? apply(rows.get(write.ref.path), write.value) : write.value);
        }
        if (db.afterCommit) { const hook = db.afterCommit; db.afterCommit = null; await hook(); }
        return value;
      }
      throw new Error('transaction conflict retry limit');
    }
  };
  return { db, admin: { firestore: { Timestamp: { fromMillis: value => value }, FieldValue: {
    delete: () => deletion, serverTimestamp: () => Date.now(), increment: value => value
  } } } };
}

function load(t) {
  const store = firestore();
  const paths = ['../config', '../engine-writing-v1/jobStore', '../engine-writing-v1/usage', '../lib/usageBilling'].map(require.resolve);
  const previous = paths.map(path => require.cache[path]);
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: store };
  for (const path of paths.slice(1)) delete require.cache[path];
  const jobs = require('../engine-writing-v1/jobStore'), usage = require('../engine-writing-v1/usage'), billing = require('../lib/usageBilling');
  t.after(() => paths.forEach((path, i) => { if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path]; }));
  const uid = 'synthetic-staged-owner', id = 'synthetic_staged_request_01', hash = 'synthetic-hash';
  store.db.put('users/' + uid, { credits: 20, plan: 'free', creditLotV1Balance: 0 });
  return { ...store, jobs, usage, billing, uid, id, hash, key: 'writingLabV2Jobs/' + jobs.storageKey(uid, id) };
}

function completion(overrides = {}) { return { version: 'writing-completion-v1', needed: 10, applied: true,
  cost: { version: 'writing-cost-v1', modelCallCount: 3 }, payload: { ok: true, status: 'READY',
    draft: 'Synthetic verified draft.', verificationToken: 'signed-context', billing: { applied: true, credits: 10, plan: 'free' },
    usage: { modelCalls: { count: 3 } } }, ...overrides }; }
async function stage(f) {
  const claim = await f.jobs.begin(f.uid, f.id, f.hash);
  const pending = await f.jobs.stageCompletion(f.uid, f.id, f.hash, completion(), Date.now(), { leaseId: claim.leaseId });
  const guard = tx => f.jobs.prepareDebitCompletion(tx, f.uid, f.id, f.hash, claim.leaseId, pending.stageId);
  const usageGuard = tx => f.jobs.assertSideEffectOwnership(tx, f.uid, f.id, f.hash, claim.leaseId, { stageId: pending.stageId });
  return { claim, pending, guard, usageGuard };
}

test('hung heartbeat cannot hold assertOwned or a storage wait past local ownership; late success never reauthorizes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  t.after(() => t.mock.timers.reset());
  const rpc = deferred(); let calls = 0;
  const lease = lifecycle.createJobLease({ store: { renew: () => { calls++; return rpc.promise; } }, uid: 'u', requestId: 'r', inputHash: 'h', leaseId: 'l',
    leaseExpiresAtMs: Date.now() + 90_000, deadlineAtMs: Date.now() + 400_000, heartbeatMs: 30_000, renewTimeoutMs: 5_000 });
  t.after(() => lease.stop());
  t.mock.timers.tick(30_000); await flush();
  const ownership = assert.rejects(lease.assertOwned(), { code: 'WRITING_JOB_LEASE_LOST' });
  const storage = assert.rejects(lease.waitFor(() => new Promise(() => {})), { code: 'WRITING_JOB_LEASE_LOST' });
  t.mock.timers.tick(5_000); await flush(); await ownership; await storage;
  assert.equal(calls, 1); assert.equal(lease.lostReason(), 'renew_timeout');
  rpc.resolve({ ok: true, leaseExpiresAtMs: Date.now() + 900_000 }); await flush();
  await assert.rejects(lease.assertOwned(), { code: 'WRITING_JOB_LEASE_LOST' });
  lease.stop(); t.mock.timers.tick(900_000); await flush(); assert.equal(calls, 1);
});

test('staging refreshes retention, is immutable, bounds size, and preserves failures for same-result takeover', async t => {
  const f = load(t), { claim, pending } = await stage(f);
  assert.ok(pending.stageId); assert.ok(f.db.rows.get(f.key).expiresAt >= Date.now() + f.jobs.JOB_TTL_MS - 1000);
  const same = await f.jobs.stageCompletion(f.uid, f.id, f.hash, completion({ payload: { ...pending.payload, draft: 'replacement' } }), Date.now(), { leaseId: claim.leaseId });
  assert.deepEqual(same, pending);
  await assert.rejects(f.jobs.stageCompletion(f.uid, f.id, f.hash, completion({ payload: { ...pending.payload, draft: 'x'.repeat(720_000) } }), Date.now(), { leaseId: claim.leaseId }), { code: 'WRITING_COMPLETION_TOO_LARGE' });
  await f.jobs.fail(f.uid, f.id, f.hash, new Error('ambiguous commit'), Date.now(), { leaseId: claim.leaseId });
  assert.equal((await f.jobs.get(f.uid, f.id)).leaseExpired, true);
  const next = await f.jobs.begin(f.uid, f.id, f.hash);
  assert.notEqual(next.leaseId, claim.leaseId); assert.deepEqual(next.pendingCompletion, pending);
  await assert.rejects(f.jobs.complete(f.uid, f.id, f.hash, pending.payload, Date.now(), { leaseId: claim.leaseId }), { code: 'WRITING_JOB_LEASE_LOST' });
  await assert.rejects(f.jobs.complete(f.uid, f.id, f.hash, { ...pending.payload, draft: 'replacement' }, Date.now(), { leaseId: next.leaseId }));
  const guard = tx => f.jobs.prepareDebitCompletion(tx, f.uid, f.id, f.hash, next.leaseId, pending.stageId);
  const receipt = await f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: guard, returnReceipt: true });
  f.db.put(f.key, { ...f.db.rows.get(f.key), leaseExpiresAtMs: Date.now() - 1 });
  await f.jobs.complete(f.uid, f.id, f.hash, { ...pending.payload, billing: f.jobs.billingFromReceipt(pending.payload.billing, receipt) }, Date.now(), { leaseId: next.leaseId });
  assert.equal(f.db.rows.get(f.key).pendingCompletion, undefined); assert.equal((await f.jobs.get(f.uid, f.id)).result.draft, pending.payload.draft);
});

test('takeover after a debit guard read conflicts and prevents the old debit; new owner charges exactly once', async t => {
  const f = load(t), s = await stage(f);
  f.db.beforeCommit = async () => { f.db.put(f.key, { ...f.db.rows.get(f.key), leaseId: 'replacement-owner' }); };
  await assert.rejects(f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard, returnReceipt: true }), { code: 'WRITING_JOB_LEASE_LOST' });
  assert.equal(f.db.rows.get('users/' + f.uid).credits, 20);
  const guard = tx => f.jobs.prepareDebitCompletion(tx, f.uid, f.id, f.hash, 'replacement-owner', s.pending.stageId);
  const first = await f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: guard, returnReceipt: true });
  const again = await f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: guard, returnReceipt: true });
  assert.equal(first.applied, true); assert.equal(again.duplicate, true); assert.equal(f.db.rows.get('users/' + f.uid).credits, 10);
  assert.equal(f.db.rows.get(f.key).pendingCompletion.billingReceipt.credits, 10);
});

test('actual unlimited waiver is saved atomically with its receipt and composed into completion', async t => {
  const f = load(t), s = await stage(f);
  f.db.put('users/' + f.uid, { credits: 0, plan: 'unlimited' });
  const receipt = await f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard, returnReceipt: true });
  assert.equal(receipt.applied, false); assert.equal(receipt.credits, 0);
  const payload = { ...s.pending.payload, billing: f.jobs.billingFromReceipt(s.pending.payload.billing, receipt) };
  await f.jobs.complete(f.uid, f.id, f.hash, payload, Date.now(), { leaseId: s.claim.leaseId });
  assert.equal((await f.jobs.get(f.uid, f.id)).result.billing.applied, false);
});

test('refund and terminal stage deletion commit together even when the transaction response is lost', async t => {
  const f = load(t), s = await stage(f);
  await f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard, returnReceipt: true });
  const guard = tx => f.jobs.prepareCompensatedCompletion(tx, f.uid, f.id, f.hash, s.claim.leaseId, s.pending.stageId);
  f.db.afterCommit = async () => { throw new Error('response lost after commit'); };
  await assert.rejects(f.billing.commitCreditRestore(f.uid, 10, 'writing_lab_v2_generate', f.id, { transactionGuard: guard }));
  assert.equal(f.db.rows.get('users/' + f.uid).credits, 20);
  assert.equal(f.db.rows.get(f.key).pendingCompletion, undefined);
  assert.equal((await f.jobs.begin(f.uid, f.id, f.hash)).state, 'FAILED');
  await assert.rejects(f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard }), { code: 'WRITING_JOB_LEASE_LOST' });
});

test('legacy restore marker prevents a retained stage from charging or delivering after compensation', async t => {
  const f = load(t), s = await stage(f);
  f.db.put(`users/${f.uid}/creditHistory/${creditHistoryDocumentId('restore', f.id)}`, { used: -10 });
  await assert.rejects(f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard }), { code: 'WRITING_JOB_ALREADY_RESTORED' });
  assert.equal(f.db.rows.get('users/' + f.uid).credits, 20);
});

test('a credit-history ID belonging to a different operation cannot pay for a writing stage', async t => {
  const f = load(t), s = await stage(f);
  f.db.put(`users/${f.uid}/creditHistory/${creditHistoryDocumentId('deduct', f.id)}`, { type: 'detect', used: 10 });
  await assert.rejects(f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard }), { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(f.db.rows.get('users/' + f.uid).credits, 20);
});

for (const action of ['usage', 'refund']) test(`takeover during ${action} transaction prevents old-owner side effects`, async t => {
  const f = load(t), s = await stage(f);
  await f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard, returnReceipt: true });
  f.db.beforeCommit = async () => { f.db.put(f.key, { ...f.db.rows.get(f.key), leaseId: 'replacement-owner' }); };
  const operation = action === 'usage'
    ? f.usage.commitSuccessful(f.uid, f.id, 5, { transactionGuard: s.usageGuard })
    : f.billing.commitCreditRestore(f.uid, 10, 'writing_lab_v2_generate', f.id, {
      transactionGuard: tx => f.jobs.prepareCompensatedCompletion(tx, f.uid, f.id, f.hash, s.claim.leaseId, s.pending.stageId)
    });
  await assert.rejects(operation, { code: 'WRITING_JOB_LEASE_LOST' });
  assert.equal(f.db.rows.get('users/' + f.uid).credits, 10);
  assert.equal(await f.usage.successfulCount(f.uid), 0);
  assert.equal(f.db.rows.get(f.key).status, 'PROCESSING');
});

test('usage is UID-scoped, validates legacy ownership, and retries an ambiguous commit without spending a second cap slot', async t => {
  const f = load(t), s = await stage(f);
  f.db.put('writingLabGenerationCommits/' + f.id, { uid: 'another-user', operation: 'writing_lab_v2_generate' });
  f.db.afterCommit = async () => { throw new Error('usage response lost'); };
  assert.equal((await f.usage.commitSuccessful(f.uid, f.id, 1, { transactionGuard: s.usageGuard })).unavailable, true);
  assert.equal((await f.usage.commitSuccessful(f.uid, f.id, 1, { transactionGuard: s.usageGuard })).duplicate, true);
  assert.equal(await f.usage.successfulCount(f.uid), 1);
  assert.equal((await f.usage.commitSuccessful('another-user', f.id, 1)).duplicate, true, 'its own legacy record remains idempotent');
  assert.equal((await f.usage.commitSuccessful('third-user', f.id, 1)).committed, true);
});

test('account deletion prevents stage/side effects and fail removes the retained user-content job', async t => {
  const f = load(t), s = await stage(f);
  f.db.put('accountDeletionJobs/' + f.uid, { status: 'processing', leaseUntilMs: Date.now() + 60_000 });
  await assert.rejects(f.usage.commitSuccessful(f.uid, f.id, 5, { transactionGuard: s.usageGuard }), { code: 'ACCOUNT_DELETION_IN_PROGRESS' });
  await assert.rejects(f.billing.commitCreditDeduct(f.uid, 10, 'writing_lab_v2_generate', f.id, {}, { transactionGuard: s.guard }), { code: 'ACCOUNT_DELETION_IN_PROGRESS' });
  await f.jobs.fail(f.uid, f.id, f.hash, Object.assign(new Error('deletion'), { code: 'ACCOUNT_DELETION_IN_PROGRESS' }), Date.now(), { leaseId: s.claim.leaseId });
  assert.equal(f.db.rows.has(f.key), false); assert.equal(f.db.rows.get('users/' + f.uid).credits, 20);
});
