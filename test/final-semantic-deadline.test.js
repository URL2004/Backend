'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finalSemanticDeadline } = require('../engine-gpt-prod/finalSemanticDeadline');
const schedule = require('../engine-gpt-prod/semanticAuditSchedule');

// F-01 (2026-10-09): the old 120s / shared 180s limits were shorter than one
// confirming verdict needs (3.9s + 19.4ms per output token, envelope 10,000+
// tokens). Every expected section now owns one full verdict limit.
test('the final audit limit gives every expected section its own verdict limit', () => {
  const section = schedule.FINAL_VERDICT_SECTION_LIMIT_MS;
  assert.equal(section, 270000);
  for (const [chars, waves] of [[0,1],[5999,1],[6000,1],[6001,1],[18000,1],[18001,2],[20000,2],[36000,2],[36001,3]]) {
    const expected = waves * section;
    const policy = finalSemanticDeadline({ source:'가'.repeat(chars), startedAt:1000 });
    assert.equal(policy.limitMs, expected, `${chars} chars`);
    assert.equal(policy.deadlineMs, 1000 + expected);
    assert.equal(policy.postRepairDeadlineMs, 121000);
    assert.equal(policy.verifyReserveMs, expected - 30000);
    assert.equal(policy.sectionLimitMs, section);
    assert.ok(policy.hardLimitMs >= expected + section, 'the ceiling also covers one retry wave');
  }
  assert.equal(finalSemanticDeadline({candidate:'나'.repeat(18001),startedAt:0}).deadlineMs,540000);
  assert.equal(finalSemanticDeadline({source:'가'.repeat(6000),startedAt:0}).longDocument,false);
  assert.equal(finalSemanticDeadline({source:'가'.repeat(6001),startedAt:0}).longDocument,true);
});

test('the verdict limit is below the HTTP response wait and above the measured tail', () => {
  // 180s cut 11% of confirming calls on 2026-10-09; the client waits 300s.
  assert.ok(schedule.FINAL_VERDICT_SECTION_LIMIT_MS > 180000);
  assert.ok(schedule.FINAL_VERDICT_SECTION_LIMIT_MS < 300000);
  assert.deepEqual(schedule.estimateVerdictSections(2237), { expected: 1, upper: 1 });
  assert.deepEqual(schedule.estimateVerdictSections(8584), { expected: 2, upper: 2 });
  assert.deepEqual(schedule.estimateVerdictSections(20376), { expected: 3, upper: 5 });
  assert.deepEqual(schedule.estimateVerdictSections(29962), { expected: 4, upper: 7 });
});

test('the final audit never exceeds or renews the existing job deadline', () => {
  for (const remaining of [-1,0,1,90000,120000,269999,270000,270001,900000]) {
    const policy=finalSemanticDeadline({source:'가'.repeat(7000),startedAt:1000,jobDeadlineMs:1000+remaining});
    assert.equal(policy.deadlineMs,1000+Math.min(remaining,270000));
    assert.equal(policy.postRepairDeadlineMs,1000+Math.min(remaining,120000));
    assert.equal(policy.verdictDeadlineMs(1000),1000+Math.min(remaining,policy.hardLimitMs));
    assert.ok(policy.verdictDeadlineMs(1000+5000)<=1000+remaining || remaining<0);
  }
});

test('the verdict clock starts when the audit starts, not before the pre-final repair', () => {
  const policy = finalSemanticDeadline({ source:'가'.repeat(3000), startedAt:0 });
  assert.equal(policy.verdictDeadlineMs(0), policy.hardLimitMs);
  assert.equal(policy.verdictDeadlineMs(7000), 7000 + policy.hardLimitMs);
  assert.equal(policy.verdictPolicy.verdictCallLimitMs, 270000);
  assert.deepEqual(policy.verdictPolicy.verdictSchedule, { version: schedule.VERDICT_SCHEDULE_VERSION,
    sectionLimitMs: 270000, retryLimit: 1, retrySections: 2 });
});

test('engine shares a single bounded deadline with repairs and final verification', () => {
  const code = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod'),'utf8');
  assert.ok(code.includes("require('./finalSemanticDeadline').finalSemanticDeadline"));
  assert.ok(code.includes('finalDeadlinePolicy.verifyReserveMs'));
  assert.ok(code.includes('deadlineMs: postRepairDeadlineMs'));
  assert.ok(code.includes('finalSemanticRevalidation.scheduleDiagnostics = recheck.scheduleDiagnostics || null'));
  // The final verdict runs under its own schedule and audit-start clock.
  assert.ok(code.includes('finalDeadlinePolicy.verdictDeadlineMs(Date.now())'));
  assert.ok(code.includes("require('./callLedger').withPolicy(finalDeadlinePolicy.verdictPolicy"));
  assert.ok(code.includes('deadlineMs: finalVerdictDeadlineMs'));
});
