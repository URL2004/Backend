'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayFinalVerdict } = require('./helpers/final-verdict-replay.cjs');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');
const schedule = require('../engine-gpt-prod/semanticAuditSchedule');

// F-01. The eight results of 2026-10-09 whose final semantic verdict ended
// "incomplete". Only numbers come from the stored schedule diagnostics:
// section sizes, the old limit, the budget left when the audit started, and the
// duration/outcome of the sections that DID finish. A section that was cut has
// no stored duration; `assumed` is the duration used for the replay (above the
// point where it was cut, taken from the same job's other confirming verdicts).
// [sourceChars, outputChars, stored outcome, stored ms | null, assumed ms]
const CASES = {
  H0075: { limit: 120000, budgetAtStart: 116264, windows: [[2237, 2243, 'cut', null, 150000]] },
  H0141: { limit: 120000, budgetAtStart: 112600, windows: [[2397, 2311, 'cut', null, 200000]] },
  H0109: { limit: 120000, budgetAtStart: 119207, windows: [[4382, 4262, 'cut', null, 200000]] },
  H0042: { limit: 120000, budgetAtStart: 119842, windows: [[5629, 5382, 'cut', null, 200000]] },
  H0113: { limit: 180000, budgetAtStart: 173224, windows: [[4399, 4147, 'fail', 169438], [4125, 3921, 'cut', null, 200000]] },
  H0105: { limit: 180000, budgetAtStart: 176207, windows: [[6534, 6455, 'fail', 175886], [6037, 5622, 'cut', null, 200000]] },
  H0067: { limit: 180000, budgetAtStart: 171720, windows: [[8182, 8280, 'fail', 156083], [8313, 8075, 'uncertain', 159701],
    [3879, 3844, 'cut', null, 100000]] },
  H0050: { limit: 180000, budgetAtStart: 161059, windows: [[8616, 8339, 'uncertain', 147648], [8165, 8112, 'cut', null, 150000],
    [8463, 8247, 'cut', null, 185000], [4700, 4907, 'cut', null, 100000]] }
};
// What production stored for each section under the old shared deadline.
const STORED = {
  H0075: ['deadline_timeout'], H0141: ['deadline_timeout'], H0109: ['deadline_timeout'], H0042: ['deadline_timeout'],
  H0113: ['fail', 'deadline_timeout'], H0105: ['fail', 'deadline_timeout'],
  H0067: ['fail', 'uncertain', 'deadline_timeout'],
  H0050: ['uncertain', 'deadline_timeout', 'deadline_timeout', 'cancelled_before_start']
};
const sizes = spec => spec.windows.map(w => [w[0], w[1]]);
const stored = spec => index => spec.windows[index][2] === 'cut' ? 'fail' : spec.windows[index][2];
const latencyOf = (spec, cut = w => w[4]) => index => spec.windows[index][3] ?? cut(spec.windows[index]);

for (const [ref, spec] of Object.entries(CASES)) {
  test(`${ref}: the old shared final deadline reproduces the stored incomplete verdict`, { concurrency: false }, async t => {
    const run = await replayFinalVerdict(t, { windows: sizes(spec), shape: 'legacy', legacyLimitMs: spec.limit,
      preludeMs: spec.limit - spec.budgetAtStart, latency: latencyOf(spec), verdict: stored(spec) });
    assert.equal(run.report.verificationCompleted, false);
    assert.equal(run.report.pass, false);
    assert.equal(run.report.uncertain, true);
    assert.deepEqual(run.outcomes, STORED[ref]);
    assert.equal(run.diagnostics.deadlineExceeded, true);
    assert.ok(Math.abs(run.diagnostics.budgetMsAtStart - spec.budgetAtStart) < 1000);
    // The whole final stage ended at exactly the old limit, as stored.
    assert.ok(Math.abs(run.finalStageMs - spec.limit) <= 1000, `final stage ${run.finalStageMs}ms`);
  });

  test(`${ref}: under the verdict schedule the same conditions finish the verdict`, { concurrency: false }, async t => {
    const run = await replayFinalVerdict(t, { windows: sizes(spec), preludeMs: spec.limit - spec.budgetAtStart,
      latency: latencyOf(spec), verdict: stored(spec) });
    assert.equal(run.report.verificationCompleted, true);
    assert.equal(run.report.progress.unfinishedSections.length, 0);
    assert.equal(run.report.progress.completedSections, spec.windows.length);
    // One verdict per section: no added call beyond the sections the audit owns.
    assert.equal(run.calls.length, spec.windows.length);
    assert.ok(run.calls.every(call => call.attempt === 1 && call.maxRounds === 0));
    assert.equal(run.diagnostics.outcomeCounts.deadline_timeout, 0);
    assert.equal(run.diagnostics.outcomeCounts.cancelled_before_start, 0);
    // Sections that had finished keep their verdicts; nothing is re-labelled.
    spec.windows.forEach((w, index) => { if (w[2] !== 'cut') assert.equal(run.outcomes[index], w[2]); });
    assert.ok(run.finalStageMs <= run.policy.limitMs + (spec.limit - spec.budgetAtStart) + 1000,
      `final stage ${run.finalStageMs}ms within ${run.policy.limitMs}ms`);
  });

  test(`${ref}: a cut verdict that needs almost the whole section limit still finishes`, { concurrency: false }, async t => {
    const run = await replayFinalVerdict(t, { windows: sizes(spec), preludeMs: spec.limit - spec.budgetAtStart,
      latency: latencyOf(spec, () => schedule.FINAL_VERDICT_SECTION_LIMIT_MS - 5000), verdict: stored(spec) });
    assert.equal(run.report.verificationCompleted, true);
    assert.equal(run.calls.length, spec.windows.length);
  });
}

test('length does not decide completion: only the time one verdict needs does', { concurrency: false }, async t => {
  // A 2,237-character document, exactly the stored budget of H0075.
  for (const needed of [60000, 110000, 117000, 150000, 180000, 240000, 265000]) {
    const windows = [[2237, 2243]], preludeMs = 120000 - 116264;
    const before = await replayFinalVerdict(t, { windows, shape: 'legacy', legacyLimitMs: 120000, preludeMs, latency: () => needed });
    const after = await replayFinalVerdict(t, { windows, preludeMs, latency: () => needed });
    assert.equal(before.report.verificationCompleted, needed < 116264, `legacy ${needed}ms`);
    assert.equal(after.report.verificationCompleted, true, `schedule ${needed}ms`);
    assert.equal(after.calls.length, 1);
  }
});

test('one slow section does not starve the sections queued behind it', { concurrency: false }, async t => {
  const windows = [[8600, 8300], [8400, 8200], [8100, 8100], [4700, 4900]];
  // Two sections run at once. The first needs 265s, its neighbour 170s.
  const latency = index => [265000, 170000, 60000, 60000][index];
  const before = await replayFinalVerdict(t, { windows, shape: 'legacy', legacyLimitMs: 180000, latency });
  assert.equal(before.report.verificationCompleted, false);
  // The third section started with 10s of the shared 180s left; the fourth never started.
  assert.deepEqual(before.outcomes, ['deadline_timeout', 'pass', 'deadline_timeout', 'cancelled_before_start']);
  const after = await replayFinalVerdict(t, { windows, latency });
  assert.equal(after.report.verificationCompleted, true);
  assert.equal(after.report.pass, true);
  assert.deepEqual(after.outcomes, ['pass', 'pass', 'pass', 'pass']);
  assert.equal(after.calls.length, 4);
  // 170s + 60s + 60s ran beside the 265s section: no section waited for a full limit.
  assert.ok(after.finalStageMs <= 291000, `final stage ${after.finalStageMs}ms`);
});

test('an imminent job deadline still wins and keeps the existing incomplete state', { concurrency: false }, async t => {
  const run = await replayFinalVerdict(t, { windows: [[5000, 5000]], jobRemainingMs: 100000, latency: () => 150000 });
  assert.equal(run.report.verificationCompleted, false);
  assert.equal(run.report.pass, false);
  assert.equal(run.report.uncertain, true);
  assert.deepEqual(run.outcomes, ['deadline_timeout']);
  assert.ok(run.finalStageMs <= 101000, 'the final verdict never runs past the job deadline');
  assert.equal(run.calls.length, 1);
  // Optional recovery may not start inside the final verdict's reserve, so the
  // job normally reaches the final audit with its section limit intact.
  let now = 0;
  const jobDeadlineMs = 10000 + 120000 + run.policy.limitMs;
  const budget = createRecoveryBudget(1, { clock: () => now, jobDeadlineMs, finalAuditReserveMs: run.policy.limitMs });
  assert.equal(budget.snapshot().finalAuditReserveMs, 270000);
  now = 10000;
  assert.equal(budget.canStart({ priority: 'late' }), true);
  now += 1;
  assert.equal(budget.denialReason({ priority: 'late' }), 'recovery_final_audit_time_reserved');
});

test('a continuing model outage ends bounded and incomplete, as before', { concurrency: false }, async t => {
  for (const windows of [[[2400, 2300]], [[8600, 8300], [8400, 8200], [8100, 8100], [4700, 4900]]]) {
    const run = await replayFinalVerdict(t, { windows, latency: () => Infinity });
    assert.equal(run.report.verificationCompleted, false);
    assert.equal(run.report.pass, false);
    assert.equal(run.report.uncertain, true);
    assert.equal(run.report.progress.completedSections, 0);
    assert.ok(run.finalStageMs <= run.policy.hardLimitMs, `final stage ${run.finalStageMs}ms`);
    // At most one retry wave on top of one request per section.
    assert.ok(run.calls.length <= windows.length + 2);
  }
});

test('a caller cancellation stops the final verdict at once', { concurrency: false }, async t => {
  const run = await replayFinalVerdict(t, { windows: [[2400, 2300]], latency: () => 200000, abortAfterMs: 40000 });
  assert.equal(run.report.verificationCompleted, false);
  assert.deepEqual(run.outcomes, ['cancelled']);
  assert.ok(run.finalStageMs <= 41000);
  assert.equal(run.calls.length, 1);
});
