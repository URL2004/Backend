'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { guardExecutionLease } = require('../lib/executionLeaseGuard');
const turn = () => new Promise(resolve => setImmediate(resolve));
function timers() {
  const timeouts = new Map(), intervals = new Map(); let id = 0;
  return { timeouts, intervals, setTimeout(fn, ms) { timeouts.set(++id, { fn, ms }); return id; }, clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { intervals.set(++id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); } };
}
test('hung renewal is bounded, cannot overlap, and late success cannot revive ownership', async () => {
  const t = timers(), controller = new AbortController(), lease = { expiresAtMs: 90000 };
  let resolveRenewal, calls = 0;
  guardExecutionLease({ lease, controller, timers: t, clock: () => 0,
    coordinator: { renew: () => { calls++; return new Promise(resolve => { resolveRenewal = resolve; }); } } });
  const renew = [...t.intervals.values()][0].fn;
  renew(); renew(); await turn(); assert.equal(calls, 1);
  [...t.timeouts.values()].find(timer => timer.ms === 10000).fn();
  assert.equal(controller.signal.reason.code, 'EXECUTION_LEASE_LOST');
  assert.equal(t.timeouts.size, 0); assert.equal(t.intervals.size, 0);
  lease.expiresAtMs = 200000; resolveRenewal(true); await turn();
  assert.equal(t.timeouts.size, 0); assert.equal(t.intervals.size, 0);
});
test('local lease expiry fires before remote expiry even without renewal callbacks; stale acquisition never runs', () => {
  const t = timers(), controller = new AbortController();
  guardExecutionLease({ lease: { expiresAtMs: 90000 }, controller, timers: t, clock: () => 1000, coordinator: {} });
  const expiry = [...t.timeouts.values()][0]; assert.equal(expiry.ms, 88000); expiry.fn();
  assert.equal(controller.signal.aborted, true);
  const stale = new AbortController(), t2 = timers();
  guardExecutionLease({ lease: { expiresAtMs: 90000 }, controller: stale, timers: t2, clock: () => 90001, coordinator: {} });
  assert.equal(stale.signal.aborted, true); assert.equal(t2.intervals.size, 0);
});
test('a failing lease-loss observer cannot escape the timer or prevent abort', () => {
  const t = timers(), controller = new AbortController();
  guardExecutionLease({ lease: { expiresAtMs: 90000 }, controller, timers: t, clock: () => 0, coordinator: {}, onLost() { throw new Error('observer failed'); } });
  assert.doesNotThrow(() => [...t.timeouts.values()][0].fn());
  assert.equal(controller.signal.reason.code, 'EXECUTION_LEASE_LOST');
});
test('confirmed renewal moves local deadline and cancellation marks job before aborting', async () => {
  const t = timers(), controller = new AbortController(), lease = { expiresAtMs: 90000 }; let cancelled = false;
  const coordinator = { renew: async () => { lease.expiresAtMs = 110000; return true; } };
  const stop = guardExecutionLease({ coordinator, lease, controller, timers: t, clock: () => 20000,
    onLost: value => { cancelled = value.cancelled; } });
  [...t.intervals.values()][0].fn(); await turn();
  assert.deepEqual([...t.timeouts.values()].map(value => value.ms), [89000]);
  coordinator.renew = async () => { lease.cancelled = true; return false; };
  [...t.intervals.values()][0].fn(); await turn();
  assert.equal(cancelled, true); assert.equal(controller.signal.aborted, true); stop();
});

test('pre-aborted worker waits for no capacity and creates no worker', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), { EventEmitter } = require('node:events');
  const workers = [];
  class Worker extends EventEmitter { constructor() { super(); workers.push(this); } terminate() { return Promise.resolve(); } }
  const context = { module: { exports: {} }, __dirname, process: { env: {} }, require: name => {
    if (name === 'node:worker_threads') return { Worker };
    if (name === 'node:path') return require(name);
    if (name === './logger') return { currentContext: () => ({}) };
    if (name === './humanizeCapacity') return { workerCapacity: () => 1 };
    return { observationSink: () => () => {} };
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/humanizeWorkerPool'), 'utf8'), context);
  const run = context.module.exports.runHumanize, first = run({});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run({ signal: controller.signal }), error => error.code === 'ABORT_ERR');
  assert.equal(workers.length, 1);
  workers[0].emit('message', { result: {} }); await first;
});

test('predeploy refuses an active auxiliary or in-flight admission independently of running count', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../scripts/predeploy-v2'), 'utf8');
  const code = source.slice(source.indexOf("      add('active_jobs_zero'"), source.indexOf("      if (args['expect-live-v2']"));
  for (const [auxiliaryJobs, pendingAdmissions, expected] of [[0, 0, true], [1, 0, false], [0, 1, false]]) {
    const checks = [];
    vm.runInNewContext(code, { live: { activeJobs: 0, queuedJobs: 0, auxiliaryJobs, pendingAdmissions }, add: (_, ok) => checks.push(ok) });
    assert.equal(checks.every(Boolean), expected);
  }
});
