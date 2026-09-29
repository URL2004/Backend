'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finalSemanticDeadline } = require('../engine-gpt-prod/finalSemanticDeadline');

test('short final audits retain 120 seconds, long final audits get at most 180 seconds', () => {
  for (const [chars, expected] of [[0,120000],[5999,120000],[6000,120000],[6001,180000],[20000,180000]]) {
    const policy = finalSemanticDeadline({ source:'가'.repeat(chars), startedAt:1000 });
    assert.equal(policy.limitMs, expected);
    assert.equal(policy.deadlineMs, 1000 + expected);
    assert.equal(policy.postRepairDeadlineMs, 121000);
    assert.equal(policy.verifyReserveMs, expected - 30000);
  }
  assert.equal(finalSemanticDeadline({candidate:'나'.repeat(6001),startedAt:0}).deadlineMs,180000);
});

test('long final extension never exceeds or renews the existing job deadline', () => {
  for (const remaining of [-1,0,1,90000,120000,179999,180000,180001]) {
    const policy=finalSemanticDeadline({source:'가'.repeat(7000),startedAt:1000,jobDeadlineMs:1000+remaining});
    assert.equal(policy.deadlineMs,1000+Math.min(remaining,180000));
    assert.equal(policy.postRepairDeadlineMs,1000+Math.min(remaining,120000));
  }
});

test('engine shares a single bounded deadline with repairs and final verification', () => {
  const code = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod'),'utf8');
  assert.ok(code.includes("require('./finalSemanticDeadline').finalSemanticDeadline"));
  assert.ok(code.includes('finalDeadlinePolicy.verifyReserveMs'));
  assert.ok(code.includes('deadlineMs: postRepairDeadlineMs'));
  assert.ok(code.includes('finalSemanticRevalidation.scheduleDiagnostics = recheck.scheduleDiagnostics || null'));
});
