'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExecutionCoordinator } = require('../lib/transformExecution');
const { createAdminHumanizeExecution } = require('../lib/adminHumanizeExecution');
const { executionLimits } = require('../lib/humanizeCapacity');

function database() {
  const rows = new Map();
  let chain = Promise.resolve();
  return { rows, collection: name => ({ doc: id => `${name}/${id}` }),
    runTransaction(fn) {
      const operation = chain.then(() => fn({
        get: async ref => ({ exists: rows.has(ref), data: () => structuredClone(rows.get(ref)) }),
        set: (ref, value, options) => rows.set(ref, options?.merge
          ? { ...rows.get(ref), ...structuredClone(value) } : structuredClone(value))
      }));
      chain = operation.catch(() => {});
      return operation;
    }
  };
}
function fakeTimers() {
  const timeouts = new Set(), intervals = new Set();
  return { timeouts, intervals,
    setTimeout(fn) { timeouts.add(fn); return fn; }, clearTimeout(fn) { timeouts.delete(fn); },
    setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); }
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const slots = db => Object.values(db.rows.get('transformExecutionLeases/active')?.slots || {});
function user(db, id) {
  const job = { id, uid: id, mode: 'formal', status: 'queued' };
  db.rows.set(`transformJobs/${id}`, job);
  return job;
}

test('admin reservations share user limits across instances, use server IDs, and preserve strict job validation', async () => {
  const db = database(), options = { db, ...executionLimits({ HUMANIZE_ENGINE_WORKERS: '2' }) };
  const users = createExecutionCoordinator(options), admins = createExecutionCoordinator(options);
  const first = await users.acquire(user(db, 'user-one'), 'main');
  const admin = await admins.acquireAdmin({ uid: 'verified-admin', id: 'client-selected' });
  assert.ok(first); assert.ok(admin);
  assert.equal(await users.acquire(user(db, 'user-two'), 'main'), null);
  assert.equal(await admins.acquireAdmin({ uid: 'other-admin' }), null);
  const adminSlot = slots(db).find(row => row.feature === 'admin_runtime');
  assert.match(adminSlot.jobId, /^admin_runtime_[0-9a-f-]{36}$/);
  assert.equal([...db.rows.keys()].some(key => key.includes(adminSlot.jobId)), false);
  await admins.release(admin);
  assert.ok(await users.acquire(user(db, 'user-two'), 'main'));
  await users.release(first);
  assert.equal(await admins.acquire({ id: 'missing', uid: 'new-admin', mode: 'blog' }, 'admin_runtime'), null);
});

test('admin reservations reject deleting accounts and concurrent work for the same owner', async () => {
  const db = database(), coordinator = createExecutionCoordinator({ db, ...executionLimits({}) });
  db.rows.set('accountDeletionJobs/deleting-admin', { status: 'processing' });
  assert.equal(await coordinator.acquireAdmin({ uid: 'deleting-admin' }), null);
  assert.equal(slots(db).length, 0);
  const job = user(db, 'same-admin');
  const lease = await coordinator.acquire(job, 'main');
  assert.equal(await coordinator.acquireAdmin({ uid: job.uid }), null);
  await coordinator.release(lease);
  assert.ok(await coordinator.acquireAdmin({ uid: job.uid }));
  assert.equal(await createExecutionCoordinator({ db: null, caps: {} }).acquireAdmin({ uid: 'admin' }), null);
});

test('busy or unavailable admin execution never submits worker work', async () => {
  const db = database(), coordinator = createExecutionCoordinator({ db, ...executionLimits({ HUMANIZE_ENGINE_WORKERS: '1' }) });
  await coordinator.acquire(user(db, 'busy-user'), 'main');
  let calls = 0;
  const run = createAdminHumanizeExecution({ db, env: { HUMANIZE_ENGINE_WORKERS: '1' }, runHumanize: () => { calls++; } });
  await assert.rejects(run({ uid: 'admin', options: {} }), error => error.status === 409);
  const offline = createAdminHumanizeExecution({ db: null, runHumanize: () => { calls++; } });
  await assert.rejects(offline({ uid: 'admin', options: {} }), error => error.status === 503);
  assert.equal(calls, 0);
});

for (const outcome of ['success', 'failure', 'disconnect', 'deadline', 'lease_lost', 'shutdown']) {
  test(`admin ${outcome} releases ownership and clears heartbeat/deadline`, async () => {
    const db = database(), timers = fakeTimers(), controller = new AbortController();
    let received;
    const run = createAdminHumanizeExecution({ db, timers,
      runHumanize: async options => {
        received = options;
        if (outcome === 'success') return { status: 'done' };
        if (outcome === 'failure') throw new Error('synthetic-provider-failure');
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
    });
    const pending = run({ uid: 'admin', options: { uid: 'forged', signal: null, deadlineMs: Infinity }, signal: controller.signal });
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await turn();
    if (outcome === 'disconnect') controller.abort();
    if (outcome === 'deadline') [...timers.timeouts][0]();
    if (outcome === 'shutdown') {
      assert.equal(run.stats().activeJobs, 1);
      run.shutdown(); run.shutdown();
    }
    if (outcome === 'lease_lost') {
      db.rows.set('transformExecutionLeases/active', { slots: {} });
      [...timers.intervals][0]();
    }
    const result = await observed;
    assert.equal(received.uid, 'admin');
    assert.ok(received.deadlineMs <= Date.now() + 300000);
    if (outcome === 'success') assert.deepEqual(result.value, { status: 'done' });
    else assert.ok(result.error);
    if (outcome === 'lease_lost') assert.equal(result.error.code, 'EXECUTION_LEASE_LOST');
    if (outcome === 'deadline') assert.equal(result.error.code, 'JOB_DEADLINE');
    if (outcome === 'shutdown') assert.equal(result.error.code, 'SERVER_DRAINING');
    assert.equal(timers.timeouts.size, 0); assert.equal(timers.intervals.size, 0);
    assert.equal(slots(db).length, 0);
    assert.equal(run.stats().activeJobs, 0); assert.equal(run.stats().pendingAdmissions, 0);
    const users = createExecutionCoordinator({ db, ...executionLimits({}) });
    assert.ok(await users.acquire(user(db, 'after-admin'), 'main'));
  });
}

test('disconnect during lease acquisition releases the reservation without starting a provider', async () => {
  const db = database(), original = db.runTransaction.bind(db), controller = new AbortController(), timers = fakeTimers();
  let releaseAcquisition, calls = 0;
  const gate = new Promise(resolve => { releaseAcquisition = resolve; });
  db.runTransaction = async fn => { const result = await original(fn); await gate; return result; };
  const run = createAdminHumanizeExecution({ db, timers, runHumanize: () => { calls++; } });
  const pending = run({ uid: 'admin', options: {}, signal: controller.signal });
  const observed = assert.rejects(pending, error => error.name === 'AbortError');
  await turn();
  controller.abort(); releaseAcquisition();
  await observed;
  assert.equal(calls, 0); assert.equal(slots(db).length, 0);
  assert.equal(timers.timeouts.size, 0); assert.equal(timers.intervals.size, 0);
});

test('shutdown during acquisition stays visible in health, releases the lease, and prevents new admissions', async () => {
  const db = database(), original = db.runTransaction.bind(db), timers = fakeTimers();
  let releaseAcquisition, calls = 0, transactions = 0;
  const gate = new Promise(resolve => { releaseAcquisition = resolve; });
  db.runTransaction = async fn => { transactions++; const result = await original(fn); await gate; return result; };
  const run = createAdminHumanizeExecution({ db, timers, runHumanize: () => { calls++; } });
  const pending = run({ uid: 'admin', options: {} });
  const observed = assert.rejects(pending, error => error.code === 'SERVER_DRAINING' && error.status === 503);
  assert.deepEqual(run.stats(), { activeJobs: 1, pendingAdmissions: 1, draining: false });
  await turn();
  run.shutdown();
  assert.deepEqual(run.stats(), { activeJobs: 1, pendingAdmissions: 1, draining: true });
  const before = transactions;
  await assert.rejects(run({ uid: 'other-admin', options: {} }), error => error.status === 503);
  assert.equal(transactions, before);
  releaseAcquisition();
  await observed;
  assert.equal(calls, 0); assert.equal(slots(db).length, 0);
  assert.deepEqual(run.stats(), { activeJobs: 0, pendingAdmissions: 0, draining: true });
  assert.equal(timers.timeouts.size, 0); assert.equal(timers.intervals.size, 0);
});

test('admin health remains busy until lease release finishes, including provider failure', async () => {
  const db = database(), original = db.runTransaction.bind(db), timers = fakeTimers();
  let releaseCleanup, transactions = 0;
  const gate = new Promise(resolve => { releaseCleanup = resolve; });
  db.runTransaction = async fn => {
    const sequence = ++transactions, result = await original(fn);
    if (sequence === 2) await gate;
    return result;
  };
  const run = createAdminHumanizeExecution({ db, timers, runHumanize: async () => { throw new Error('synthetic-failure'); } });
  const observed = assert.rejects(run({ uid: 'admin', options: {} }), /synthetic-failure/);
  await turn();
  assert.deepEqual(run.stats(), { activeJobs: 1, pendingAdmissions: 0, draining: false });
  releaseCleanup(); await observed;
  assert.equal(run.stats().activeJobs, 0);
});

test('server health includes admin acquisition and shutdown aborts admins before awaiting transform persistence', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  let resolveTransform;
  const events = [], forcedTimeouts = [];
  const transformWait = new Promise(resolve => { resolveTransform = resolve; });
  const admin = { activeJobs: 1, pendingAdmissions: 1, draining: false };
  const context = {
    shuttingDown: false,
    transformRouter: {
      stats: () => ({ activeJobs: 2, pendingAdmissions: 1, queuedJobs: 3, draining: false, restorationReady: true }),
      shutdown: () => { events.push('transform'); return transformWait; }
    },
    paymentRouter: {
      adminHumanizeStats: () => admin,
      shutdownAdminHumanize: () => { events.push('admin'); admin.draining = true; }
    },
    require: () => ({ outbox: () => ({ stop() {} }) }),
    logger: { warn() {}, error() {} },
    server: { close: () => events.push('close') },
    process: { exit() {} },
    setTimeout: (_fn, ms) => { forcedTimeouts.push(ms); return { unref() {} }; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function executionStats()'), source.indexOf('async function detailedHealth()')), context);
  const health = context.executionStats();
  assert.equal(health.activeJobs, 3); assert.equal(health.adminHumanizeJobs, 1);
  assert.equal(health.pendingAdmissions, 2); assert.equal(health.queuedJobs, 3);
  vm.runInContext(source.slice(source.indexOf('async function shutdown(sig)'), source.indexOf("process.on('SIGTERM'")), context);
  const pending = context.shutdown('SIGTERM');
  assert.deepEqual(events, ['admin', 'transform']);
  assert.equal(context.executionStats().draining, true);
  await context.shutdown('SIGTERM');
  assert.deepEqual(events, ['admin', 'transform']);
  resolveTransform(); await pending;
  assert.deepEqual(events, ['admin', 'transform', 'close']);
  assert.deepEqual(forcedTimeouts, [5000]);
});
