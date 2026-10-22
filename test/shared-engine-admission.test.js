'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createExecutionCoordinator } = require('../lib/transformExecution');
const { workerCapacity } = require('../lib/humanizeCapacity');
const source = fs.readFileSync(require.resolve('../routes/transform'), 'utf8');

test('shared budget prevents two route pools from admitting four jobs to two workers', async () => {
  const coordinator = createExecutionCoordinator({ db: null, caps: { formal: 2, short: 2 }, totalCap: 2 });
  const jobs = ['formal', 'blog', 'formal', 'blog'].map((mode, i) => ({ id: String(i), uid: String(i), mode }));
  const leases = await Promise.all(jobs.map(job => coordinator.acquire(job, 'main')));
  assert.equal(leases.filter(Boolean).length, 2);
  assert.ok(leases[0]); assert.ok(leases[1]); assert.equal(leases[2], null); assert.equal(leases[3], null);
  await coordinator.release(leases[0]);
  assert.ok(await coordinator.acquire(jobs[2], 'main'));
  assert.equal(await coordinator.acquire(jobs[3], 'refine'), null);
});

function scheduler(jobs, active = { formal: 0, short: 0 }, cap = 2, held = new Set()) {
  const launched = [];
  const poolOf = mode => mode === 'formal' ? 'formal' : 'short';
  const ctx = { draining: false, ENGINE_ACTIVE_CAP: cap, poolOf, poolCap: () => 2,
    countActive: (_, mode) => ({ running: active[poolOf(mode)] }),
    queuedJobsForPool: pool => jobs.filter(job => poolOf(job.mode) === pool),
    launchQueuedJob: job => { if (held.has(job.id)) return false; launched.push(job.id); return true; } };
  vm.runInNewContext(source.slice(source.indexOf('function drainQueue()'), source.indexOf('function launchQueuedJob(job)')), ctx);
  return { run: ctx.drainQueue, launched };
}

test('older short work wins a free slot over newer formal work, and vice versa', () => {
  const jobs = [{ id: 'formal', mode: 'formal', queuedAt: 20 }, { id: 'short', mode: 'blog', queuedAt: 10 }];
  const h = scheduler(jobs, { formal: 1, short: 0 });
  assert.equal(h.run(), 1); assert.deepEqual(h.launched, ['short']);
  jobs[0].queuedAt = 5;
  const other = scheduler(jobs, { formal: 0, short: 1 });
  assert.equal(other.run(), 1); assert.deepEqual(other.launched, ['formal']);
});

test('held recovery jobs do not idle an available slot; occupied workers admit no extra jobs', () => {
  const jobs = [{ id: 'held', mode: 'formal', queuedAt: 1 }, { id: 'ready', mode: 'blog', queuedAt: 2 }];
  const h = scheduler(jobs, { formal: 0, short: 0 }, 1, new Set(['held']));
  assert.equal(h.run(), 1); assert.deepEqual(h.launched, ['ready']);
  assert.equal(scheduler(jobs, { formal: 1, short: 1 }).run(), 0);
});

test('queue display accounts for the other mode occupying all engine workers', () => {
  const formal = { id: 'older', mode: 'formal', status: 'queued', queuedAt: Date.now() - 1000 };
  const short = { id: 'mine', mode: 'blog', status: 'queued', queuedAt: Date.now() };
  const running = [1, 2].map(i => ({ id: 'active-' + i, mode: 'formal', status: 'running', estSec: 120, startedAt: Date.now() }));
  const ctx = { Date, require, ENGINE_ACTIVE_CAP: 2, MAX_ACTIVE_GLOBAL: 2, BLOG_MAX_ACTIVE: 2,
    launchingJobs: new Set(), jobs: new Map([...running, formal, short].map(job => [job.id, job])) };
  vm.runInNewContext(source.slice(source.indexOf('function queueDetails(job)'), source.indexOf('function activeJobPayload(job)')), ctx);
  const result = ctx.queueDetails(short);
  assert.equal(result.queuePosition, 2); assert.equal(result.queueSize, 2); assert.equal(result.queueEtaSec, 120);
});

test('route and worker budget is a bounded integer even for malformed configuration', () => {
  for (const [value, expected] of [[undefined, 2], ['bad', 2], ['Infinity', 2], ['0', 2], ['1', 1], ['1.5', 1], ['99', 3]]) {
    assert.equal(workerCapacity({ HUMANIZE_ENGINE_WORKERS: value }), expected);
  }
});

test('a lease acquired after shutdown begins is returned without starting main or auxiliary work', async () => {
  for (const feature of ['main', 'refine']) {
    let acquireDone, released = 0, ran = false;
    const ctx = { draining: false, require, executionCoordinator: {
      acquire: () => new Promise(resolve => { acquireDone = resolve; }),
      release: async () => { released++; }
    } };
    vm.runInNewContext(source.slice(source.indexOf('async function executeOwned('), source.indexOf('function auxiliaryRoute(')), ctx);
    const job = { id: 'synthetic-stop', uid: 'fixture', status: 'queued' };
    const pending = ctx.executeOwned(job, feature, () => { ran = true; });
    ctx.draining = true;
    acquireDone({ token: 'owned', persisted: { status: 'running' } });
    assert.equal(await pending, false); assert.equal(released, 1); assert.equal(ran, false);
    assert.equal(job.status, 'queued'); assert.equal(job.startedAt, undefined); assert.equal(job.executionToken, undefined);
  }
});
