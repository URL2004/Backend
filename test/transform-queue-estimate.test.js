'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateQueue } = require('../lib/transformQueueEstimate');
const now = 2000000;
const queued = (id, mode = 'formal', estSec = 120, order = 1) => ({ id, mode, estSec, status: 'queued', queuedAt: now - 1000 + order });
const running = (id, mode, estSec, elapsed) => ({ id, mode, estSec, status: 'running', startedAt: now - elapsed * 1000 });
const eta = (target, jobs, options = {}) => estimateQueue(target, jobs, { now, ...options }).queueEtaSec;

test('remaining predecessor time, not the target duration, determines queue ETA', () => {
  const target = queued('target', 'blog', 40);
  const jobs = [running('active', 'formal', 1200, 300), target];
  assert.equal(eta(target, jobs), 900);
  target.estSec = 2400;
  assert.equal(eta(target, jobs), 900);
  assert.equal(eta(target, jobs, { now: now + 100000 }), 800);
});
test('shared capacity and per-pool ceilings mirror admission and skip ineligible pools', () => {
  const long = queued('long', 'formal', 700, 1), short = queued('short', 'blog', 40, 2);
  const jobs = [running('active', 'formal', 600, 100), long, short];
  assert.equal(eta(short, jobs, { sharedCap: 2 }), 15);
  assert.equal(eta(long, jobs, { sharedCap: 2 }), 500);
  assert.equal(eta(short, jobs, { sharedCap: 1 }), 1200);
});
test('launching jobs occupy one slot and do not queue for a second execution', () => {
  const launchingJob = queued('launch', 'blog', 180), target = queued('target', 'blog', 40, 2);
  const options = { launching: new Set(['launch']) };
  assert.equal(eta(target, [launchingJob, target], options), 180);
  assert.equal(eta(launchingJob, [launchingJob, target], options), 15);
});
test('retry holds and unknown restart holds are not reported as an immediate start', () => {
  const held = { ...queued('held'), retryNotBeforeMs: now + 75000 }, target = queued('target', 'blog', 40, 2);
  assert.equal(eta(held, [held, target]), 75);
  assert.equal(eta(target, [held, target]), 15);
  held._restartRecoveryPending = true;
  assert.equal(eta(held, [held, target]), null);
  assert.equal(eta(target, [held, target]), 15);
  held._restartRecoveryHoldUntilMs = now + 90000;
  assert.equal(eta(held, [held, target]), 90);
});
test('overdue and malformed runtime estimates stay finite without mutating jobs', () => {
  const target = queued('target'), active = running('active', 'formal', 300, 1000);
  const before = JSON.stringify([active, target]);
  assert.equal(eta(target, [active, target]), 30);
  assert.equal(JSON.stringify([active, target]), before);
  active.estSec = NaN;
  assert.equal(eta(target, [active, target]), 90);
  assert.deepEqual(estimateQueue({ status: 'done' }, []), {});
});
