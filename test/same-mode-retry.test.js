'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../routes/transform'), 'utf8');
const routeCode = source.slice(source.indexOf("router.post('/transform/:id/retry'"), source.indexOf("router.post('/transform/:id/refine-paragraph'"));
function instance(store) {
  let handler, drains = 0;
  const ctx = { router: { post: (_path, fn) => { handler = fn; } }, Date, AbortController, Promise,
    providerRecovery: require('../lib/transformProviderRecovery'), providerAvailability: require('../lib/providerAvailability'),
    jobs: new Map(), pendingAdmissions: new Set(), auxiliaryUsers: new Set(), admissionRequests: new Set(),
    draining: false, restorationReady: true, activeJobFor: () => null, queuedJobsForPool: () => [],
    poolOf: mode => mode === 'formal' ? 'formal' : 'short', queueCap: () => 50,
    loadControlJob: async () => ({ ...store.job }), tokenFromReq: () => 'fixture-token',
    precheckExistingJobBilling: async (job, _token, needed) => { store.prechecks.push({ mode: job.mode, needed, billingMode: job.billingMode }); },
    activeJobPayload: job => ({ id: job.id, status: job.status, mode: job.mode }),
    persistJob: async (job, options) => {
      await Promise.resolve();
      if (store.rejection) return { ok: false, code: store.rejection };
      if (store.job.status !== options.expectedStatus) return { ok: false, code: 'TRANSFORM_STATE_CHANGED' };
      assert.equal(options.requireClaim, true);
      store.job = { ...job }; store.writes++; return { ok: true };
    }, scheduleQueueDrain: () => { drains++; }, usageBilling: { authErrorMessage: message => message } };
  vm.runInNewContext(routeCode, ctx);
  return { ctx, get drains() { return drains; }, async request() {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: store.job.id }, body: { requestId: 'retry-fixture-001' } }, res, error => { throw error; }); return res;
  } };
}
const fixture = mode => ({ writes: 0, prechecks: [], job: { id: 'aaaaaaaaaaaaaaaa', uid: 'synthetic-owner',
  status: 'blocked', mode, needed: mode === 'formal' ? 80 : 20, billingMode: 'credit', text: '합성 문서입니다.',
  terminalAtMs: 10, blockOffer: { fallbackOffer: true }, approvedEvidence: 'approved-fixture', basicStyle: 'report' } });

test('delivery staging rejects any basic or advanced downgrade before billing', () => {
  const { assertSelectedMode } = require('../lib/transformCompletionState');
  for (const mode of ['formal', 'blog']) {
    for (const result of [{ engineMeta: { effectiveMode: 'polish' } }, { engineMeta: { requestStrength: 'polish' } }, { preservationFallback: true }]) {
      assert.throws(() => assertSelectedMode({ mode }, result, mode), { code: 'TRANSFORM_MODE_MISMATCH' });
    }
    assert.throws(() => assertSelectedMode({ mode }, {}, 'polish'), { code: 'TRANSFORM_MODE_MISMATCH' });
    assert.doesNotThrow(() => assertSelectedMode({ mode }, { engineMeta: { effectiveMode: 'assignment' } }, mode));
  }
  assert.doesNotThrow(() => assertSelectedMode({ mode: 'polish' }, { engineMeta: { effectiveMode: 'polish' } }, 'polish'));
});

test('provider interruption can resume by the same id, including concurrent and lost-response retries',async()=>{
  const store=fixture('formal');store.job.status='error';store.job.recoverableErrorCode='SERVICE_TEMPORARILY_UNAVAILABLE';
  store.job.providerRecoveryStartedAtMs=100;store.job.providerRecoveryCount=3;
  const a=instance(store),b=instance(store);
  const result=await Promise.all([a.request(),b.request()]);
  assert.ok(result.every(x=>x.statusCode===200));assert.equal(store.writes,1);
  assert.equal(store.job.mode,'formal');assert.equal(store.job.providerRecoveryStartedAtMs,null);
  await a.request();assert.equal(store.writes,1);
  store.job.status='error';store.job.executionFeature=null;store.job.recoverableErrorCode='UNKNOWN';
  assert.equal((await a.request()).statusCode,409);
});

test('two instances accept one durable retry with unchanged mode, price, evidence and style', async () => {
  for (const mode of ['formal', 'blog', 'polish']) {
    const store = fixture(mode), first = instance(store), other = instance(store);
    const replies = await Promise.all([first.request(), other.request()]);
    assert.ok(replies.every(r => r.statusCode === 200 && r.body.status === 'queued'));
    assert.equal(store.writes, 1); assert.equal(first.drains + other.drains, 1);
    assert.equal(store.job.mode, mode); assert.equal(store.job.needed, mode === 'formal' ? 80 : 20);
    assert.equal(store.job.executionFeature, 'retry'); assert.equal(store.job.approvedEvidence, 'approved-fixture');
    assert.equal(store.job.basicStyle, 'report'); assert.equal(store.job.terminalAtMs, null);
    assert.equal(first.ctx.admissionRequests.size + other.ctx.admissionRequests.size, 0);
    store.job.status = 'running'; assert.equal((await first.request()).body.status, 'running');
    store.job.status = 'blocked'; assert.equal((await other.request()).body.status, 'blocked');
    store.job.status = 'done'; assert.equal((await other.request()).body.status, 'done');
    assert.equal(store.writes, 1);
  }
});

test('a failed durable write leaves blocked state, releases admission and runs no worker', async () => {
  const store = fixture('blog'); store.rejection = 'TRANSFORM_JOB_PERSIST_UNAVAILABLE';
  const a = instance(store), response = await a.request();
  assert.equal(response.statusCode, 503); assert.equal(store.job.status, 'blocked');
  assert.equal(a.drains, 0); assert.equal(a.ctx.jobs.size, 0); assert.equal(a.ctx.pendingAdmissions.size, 0);
});

test('coupon retry retains coupon billing and queue acceptance never charges', async () => {
  const store = fixture('formal'); store.job.billingMode = 'coupon'; store.job.needed = 1;
  const a = instance(store); await a.request();
  assert.equal(store.prechecks[0].billingMode, 'coupon'); assert.equal(store.prechecks[0].needed, 1);
  assert.equal(store.job.deducted, undefined); assert.equal(store.job.mode, 'formal');
});

test('cancelled work and full queues cannot be reactivated through retry', async () => {
  const store = fixture('blog'), a = instance(store);
  store.job.status = 'cancelled'; assert.equal((await a.request()).statusCode, 409);
  store.job.status = 'blocked'; a.ctx.queuedJobsForPool = () => Array(50).fill({});
  assert.equal((await a.request()).statusCode, 503); assert.equal(store.writes, 0);
});

test('an accepted retry uses ordinary queue ownership and original mode after restart', async () => {
  const restart = require('../lib/transformRestartRecovery');
  for (const mode of ['formal', 'blog']) {
    const job = { ...fixture(mode).job, status: 'running', executionFeature: 'retry' };
    restart.prepareRunningJobForRestart(job); restart.releaseRestartRecoveryHold(job);
    let called;
    const ctx = { Date, db: null, launchingJobs: new Set(), restartRecovery: restart,
      providerRecovery: require('../lib/transformProviderRecovery'), providerAvailability: require('../lib/providerAvailability'),
      executeOwned: async (row, feature, run) => { assert.equal(feature, 'main'); await run(); return true; },
      logger: { info() {}, warn() {} }, scheduleQueueDrain() {}, persistJob() {},
      runHumanizeJob: async row => { called = row.mode; row.status = 'done'; },
      runJob: async row => { called = row.mode; row.status = 'done'; },
      runSearchPhase() { throw new Error('lost approved evidence'); } };
    vm.runInNewContext(source.slice(source.indexOf('function launchQueuedJob(job) {'), source.indexOf('const queueDrainInterval =')), ctx);
    ctx.launchQueuedJob(job); await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, mode); assert.equal(job.status, 'done');
  }
});
