'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const executionPolicy = require('../lib/transformExecution');
const activity = require('../lib/accountActivityClaims');
const completionState = require('../lib/transformCompletionState');
const { createJobDiscovery } = require('../lib/transformJobDiscovery');
const source = fs.readFileSync(require.resolve('../routes/transform'), 'utf8');
const routeRequire = createRequire(require.resolve('../routes/transform'));
const turn = () => new Promise(resolve => setImmediate(resolve));
function database() {
  const rows = new Map(); let chain = Promise.resolve(), reads = 0;
  const snapshot = key => ({ id: key.split('/').at(-1), exists: rows.has(key), data: () => structuredClone(rows.get(key)) });
  return { rows, get reads() { return reads; }, collection(name) {
    return { doc: id => ({ key: name + '/' + id, get: async () => snapshot(name + '/' + id) }),
      where(_field, _operator, statuses) {
        let max = 100, after = '';
        const query = { orderBy() { return query; }, limit(n) { max = n; return query; }, startAfter(doc) { after = doc.id; return query; },
          get: async () => { reads++; return { docs: [...rows.keys()].filter(key => key.startsWith(name + '/') && key.split('/').at(-1) > after && statuses.includes(rows.get(key).status))
            .sort().slice(0, max).map(snapshot) }; } };
        return query;
      }
    };
  }, runTransaction(fn) {
    const operation = chain.then(async () => {
      const writes = [];
      const result = await fn({ get: async ref => snapshot(ref.key), set: (ref, value, options) => writes.push({ key: ref.key, value: structuredClone(value), merge: options?.merge }) });
      for (const write of writes) rows.set(write.key, write.merge ? { ...rows.get(write.key), ...write.value } : write.value);
      return result;
    }); chain = operation.catch(() => {}); return operation;
  } };
}
function persistence(db) {
  const context = { db, require: routeRequire, Date, executionPolicy, completionState,
    jobPersistChains: new Map(), PERSIST_FIELDS: ['id','uid','status','stage','deducted','pendingCompletion','pendingRefinement','executionToken','startedAt','createdAt','refine'],
    JOB_ARCHIVE_COLLECTION: 'transformJobArchive', ACCOUNT_ACTIVITY_COLLECTION: activity.COLLECTION, TRANSFORM_LANE: activity.TRANSFORM_LANE,
    TRANSFORM_CLAIM_TTL_MS: activity.TRANSFORM_CLAIM_TTL_MS, CANCEL_WINDOW_SEC: 45,
    accountDeletionBlocksWrites: activity.accountDeletionBlocksWrites, activeLane: activity.activeLane, laneWithClaim: activity.laneWithClaim, laneWithoutClaim: activity.laneWithoutClaim,
    normalizeCompletedJobState() {}, ensureTerminalTimestamp() {}, attemptTrace: { observeStatus() {} },
    buildArchiveDocument: job => ({ id: job.id, status: job.status }), jobNotification: require('../lib/jobNotification').jobNotification, logger: { warn() {} } };
  vm.runInNewContext(source.slice(source.indexOf('function pruneUndefinedForFirestore('), source.indexOf('function resultLength(')), context);
  return context.persistJob;
}
const job = (id, extra = {}) => ({ id, uid: 'owner-' + id, status: 'queued', mode: 'formal', createdAt: Date.now(), ...extra });

test('remote owner cancellation commits atomically, holds capacity until worker stops, and fences late result staging', async () => {
  const db = database(), original = job('aaaaaaaaaaaaaaaa'); db.rows.set('transformJobs/' + original.id, original);
  const owner = executionPolicy.createExecutionCoordinator({ db, caps: { formal: 1, short: 1 }, totalCap: 1 });
  const lease = await owner.acquire(original, 'main'), persist = persistence(db);
  const current = { ...original, status: 'running', startedAt: Date.now(), executionToken: lease.token };
  assert.equal((await persist(current)).ok, true);
  const cancelled = await persist({ ...original, status: 'cancelled' }, { cancelRequest: true });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.job.status, 'cancelled');
  assert.ok(db.rows.get('transformJobs/' + original.id).cancelRequestedAtMs);
  assert.equal([...db.rows.keys()].filter(key => key.includes('/notifications/')).length, 1);
  const next = job('bbbbbbbbbbbbbbbb'); db.rows.set('transformJobs/' + next.id, next);
  assert.equal(await owner.acquire(next, 'main'), null);
  assert.equal((await persist({ ...current, pendingCompletion: { result: {} } })).code, 'TRANSFORM_CANCELLED');
  assert.equal(await owner.renew(lease), false); assert.equal(lease.cancelled, true);
  assert.equal(await owner.acquire(next, 'main'), null);
  await owner.release(lease); assert.ok(await owner.acquire(next, 'main'));
});

test('remote cancellation cannot bypass completion staging, ownership, deletion or the live cancellation window', async () => {
  for (const scenario of ['staged', 'charged', 'foreign-owner', 'deleted', 'window']) {
    const db = database(), original = job('aaaaaaaaaaaaaaaa', { status: 'running', startedAt: Date.now() });
    if (scenario === 'staged') original.pendingCompletion = { result: {} };
    if (scenario === 'charged') original.deducted = true;
    if (scenario === 'window') original.startedAt -= 46000;
    db.rows.set('transformJobs/' + original.id, original);
    if (scenario === 'deleted') db.rows.set('accountDeletionJobs/' + original.uid, { status: 'processing' });
    const saved = await persistence(db)({ ...original, uid: scenario === 'foreign-owner' ? 'other' : original.uid, status: 'cancelled' }, { cancelRequest: true });
    assert.equal(saved.ok, false, scenario); assert.equal(db.rows.get('transformJobs/' + original.id).status, 'running');
  }
});

test('cancel of an awaiting-payment result clears the hold without charging and repeats idempotently', async () => {
  const db = database(), original = job('aaaaaaaaaaaaaaaa', { status: 'awaiting_payment', pendingCompletion: { result: {} } });
  db.rows.set('transformJobs/' + original.id, original); const persist = persistence(db);
  assert.equal((await persist({ ...original, status: 'cancelled' }, { cancelRequest: true })).ok, true);
  assert.equal((await persist({ ...original, status: 'cancelled' }, { cancelRequest: true })).ok, true);
  assert.equal(db.rows.get('transformJobs/' + original.id).pendingCompletion, null);
  assert.equal([...db.rows.keys()].filter(key => key.includes('/notifications/')).length, 1);
});

test('two-instance completion staging versus cancellation has one authoritative winner in either ordering', async () => {
  for (const cancellationFirst of [false, true]) {
    const db = database(), original = job('aaaaaaaaaaaaaaaa', { status: 'running', startedAt: Date.now() });
    db.rows.set('transformJobs/' + original.id, original);
    const coordinator = executionPolicy.createExecutionCoordinator({ db, caps: { formal: 1, short: 1 }, totalCap: 1 });
    const lease = await coordinator.acquire(original, 'main');
    const ownerWrite = persistence(db), remoteWrite = persistence(db);
    const stage = () => ownerWrite({ ...original, executionToken: lease.token, pendingCompletion: { result: { outputText: 'synthetic result' } } });
    const cancel = () => remoteWrite({ ...original, status: 'cancelled' }, { cancelRequest: true });
    const result = await Promise.all(cancellationFirst ? [cancel(), stage()] : [stage(), cancel()]);
    assert.equal(result[0].ok, true); assert.equal(result[1].ok, false);
    assert.equal(result[1].code, cancellationFirst ? 'TRANSFORM_CANCELLED' : 'TRANSFORM_COMPLETION_IN_PROGRESS');
    const stored = db.rows.get('transformJobs/' + original.id);
    assert.equal(stored.status, cancellationFirst ? 'cancelled' : 'running');
    assert.equal(!!stored.pendingCompletion, !cancellationFirst);
    assert.equal([...db.rows.keys()].some(key => /creditHistory|refund/.test(key)), false);
  }
});

test('discovery finds jobs created after startup, pages fairly, skips live owners and observes drain', async () => {
  const db = database(), seen = []; let enabled = true, now = Date.now();
  const scan = createJobDiscovery({ db, pageSize: 1, clock: () => now, enabled: () => enabled, onJob: row => seen.push(row.id) });
  await scan.scan();
  for (const id of ['aaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbb','cccccccccccccccc']) db.rows.set('transformJobs/' + id, job(id));
  db.rows.set('transformExecutionLeases/active', { slots: { [executionPolicy.keyOf('aaaaaaaaaaaaaaaa')]: { expiresAtMs: now + 90000 } } });
  await scan.scan(); await scan.scan(); await scan.scan(); await scan.scan();
  assert.deepEqual(seen, ['bbbbbbbbbbbbbbbb','cccccccccccccccc']);
  now += 90001; await scan.scan(); assert.equal(seen.at(-1), 'aaaaaaaaaaaaaaaa');
  enabled = false; const before = db.reads; await scan.scan(); assert.equal(db.reads, before);
});

test('discovery allows only one read in flight and never adopts work after shutdown', async () => {
  const db = database(); let unblock, enabled = true; const seen = [];
  const collection = db.collection.bind(db);
  db.collection = name => {
    if (name !== 'transformJobs') return collection(name);
    const query = { where() { return query; }, orderBy() { return query; }, limit() { return query; }, get: () => new Promise(resolve => { unblock = resolve; }) };
    return query;
  };
  const discovery = createJobDiscovery({ db, enabled: () => enabled, onJob: row => seen.push(row) });
  const pending = discovery.scan(); await turn(); assert.equal(await discovery.scan(), false);
  enabled = false; unblock({ docs: [{ id: 'late', data: () => job('late') }] }); await pending;
  assert.equal(seen.length, 0);
});

test('durable loader authorizes before returning and strips foreign tokens without adding an executing job', async () => {
  const db = database(), original = job('aaaaaaaaaaaaaaaa', { status: 'running', executionToken: 'foreign' });
  db.rows.set('transformJobs/' + original.id, original);
  const context = { db, jobs: new Map(), launchingJobs: new Set(), AbortController, completionState, logger: { warn() {} }, requireJobOwner: async () => true };
  vm.runInNewContext(source.slice(source.indexOf('async function loadControlJob('), source.indexOf('function kstDay(')), context);
  const req = { params: { id: original.id } }, res = { status() { return this; }, json() {} };
  const loaded = await context.loadControlJob(req, res);
  assert.equal(loaded.executionToken, undefined); assert.equal(context.jobs.size, 0);
  context.requireJobOwner = async () => false; assert.equal(await context.loadControlJob(req, res), null);
});

test('a timed-out discovery permits a fresh scan and a late old response cannot enqueue or move its cursor', async () => {
  const db = database(), seen = [], collection = db.collection.bind(db); let unblock, reads = 0;
  db.collection = name => {
    if (name !== 'transformJobs') return collection(name);
    const query = { where() { return query; }, orderBy() { return query; }, limit() { return query; }, startAfter() { throw new Error('stale cursor'); },
      get: () => ++reads === 1 ? new Promise(resolve => { unblock = resolve; })
        : Promise.resolve({ docs: [{ id: 'new', data: () => job('new') }] }) };
    return query;
  };
  const discovery = createJobDiscovery({ db, timeoutMs: 5, onJob: row => seen.push(row.id) });
  await assert.rejects(discovery.scan(), error => error.code === 'TRANSFORM_DISCOVERY_TIMEOUT');
  assert.equal(await discovery.scan(), true);
  unblock({ docs: [{ id: 'old', data: () => job('old') }] }); await turn();
  assert.deepEqual(seen, ['new']); assert.equal(await discovery.scan(), true);
  assert.deepEqual(seen, ['new', 'new']);
});
