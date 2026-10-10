'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../engine-gpt-prod/semanticAuditSchedule');
const ledger = require('../engine-gpt-prod/callLedger');
const { replayFinalVerdict, sleep } = require('./helpers/final-verdict-replay.cjs');

// F-01, second half. Each verdict-only section owns its time limit instead of
// the remainder of a shared deadline, and a section that ended without a
// verdict is asked once more. Completed sections are never asked again.
const POLICY = schedule.finalVerdictBudget(3000).policy.verdictSchedule;
const items = n => Array.from({ length: n }, (_, index) => ({ index, pair: { sourceContext: '', output: '' } }));
async function drive(t, promise, maxMs = 3600000) {
  let settled = false, value, error;
  promise.then(v => { settled = true; value = v; }, e => { settled = true; error = e; });
  for (let virtual = 0; !settled && virtual < maxMs; virtual += 500) {
    t.mock.timers.tick(500);
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!settled) throw new Error('schedule did not settle');
  if (error) throw error;
  return value;
}
const clock = t => { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1760000000000 }); t.after(() => t.mock.timers.reset()); };

test('without a verdict schedule the runner is the previous shared-signal map', async t => {
  clock(t);
  const audit = new AbortController(), seen = [];
  const worker = async (item, signal) => { seen.push([item.index, signal === audit.signal]); await sleep(1000, signal); };
  // Repair-capable audits never get a section limit or a retry, policy or not.
  for (const options of [{ allowRepair: false, policy: null }, { allowRepair: true, policy: POLICY }, { allowRepair: false }]) {
    seen.length = 0;
    const result = await drive(t, schedule.runSectionSchedule({ schedule: items(3), signal: audit.signal,
      isUnfinished: () => true, ...options }, worker));
    assert.deepEqual(result, { sectionLimitMs: null, retriedSections: 0 });
    assert.deepEqual(seen, [[0, true], [1, true], [2, true]]);
  }
});

test('every section owns a full limit instead of the remainder of a shared deadline', async t => {
  clock(t);
  const started = [], finished = [], t0 = Date.now();
  const worker = async (item, signal) => {
    started.push([item.index, Date.now() - t0]);
    await sleep(200000, signal);
    finished.push(item.index);
  };
  const result = await drive(t, schedule.runSectionSchedule({ schedule: items(4), allowRepair: false, policy: POLICY,
    isUnfinished: index => !finished.includes(index) }, worker));
  // Two at once: the third and fourth start at 200s and still get 270s each.
  assert.deepEqual(started, [[0, 0], [1, 0], [2, 200000], [3, 200000]]);
  assert.deepEqual(finished.sort(), [0, 1, 2, 3]);
  assert.deepEqual(result, { sectionLimitMs: 270000, retriedSections: 0 });
});

test('a section past its limit is cut alone and asked once more; finished sections are not', async t => {
  clock(t);
  const attempts = new Map(), done = new Set(), reasons = [];
  const needed = (index, attempt) => index === 1 && attempt === 1 ? 400000 : 90000;
  const worker = async (item, signal) => {
    const attempt = (attempts.get(item.index) || 0) + 1;
    attempts.set(item.index, attempt);
    try { await sleep(needed(item.index, attempt), signal); done.add(item.index); }
    catch { reasons.push([item.index, signal.reason?.name, Date.now()]); }
  };
  const t0 = Date.now();
  const result = await drive(t, schedule.runSectionSchedule({ schedule: items(3), allowRepair: false, policy: POLICY,
    isUnfinished: index => !done.has(index) }, worker));
  assert.deepEqual([...attempts], [[0, 1], [1, 2], [2, 1]]);
  assert.deepEqual(reasons.map(r => [r[0], r[1], r[2] - t0]), [[1, 'TimeoutError', 270000]]);
  assert.deepEqual([...done].sort(), [0, 1, 2]);
  assert.deepEqual(result, { sectionLimitMs: 270000, retriedSections: 1 });
  // 270s (cut) + 90s (retry): the retry had its own limit.
  assert.equal(Date.now() - t0, 360000);
});

test('a section that fails twice is not asked a third time', async t => {
  clock(t);
  const attempts = new Map();
  const worker = async (item, signal) => {
    attempts.set(item.index, (attempts.get(item.index) || 0) + 1);
    try { await sleep(Infinity, signal); } catch { /* cut by its limit */ }
  };
  const t0 = Date.now();
  const result = await drive(t, schedule.runSectionSchedule({ schedule: items(1), allowRepair: false, policy: POLICY,
    isUnfinished: () => true }, worker));
  assert.deepEqual([...attempts], [[0, 2]]);
  assert.equal(result.retriedSections, 1);
  assert.equal(Date.now() - t0, 540000);
});

test('most sections failing is an outage: no second limit is spent on it', async t => {
  clock(t);
  const attempts = new Map();
  const worker = async (item, signal) => {
    attempts.set(item.index, (attempts.get(item.index) || 0) + 1);
    try { await sleep(Infinity, signal); } catch { /* cut by its limit */ }
  };
  const t0 = Date.now();
  const result = await drive(t, schedule.runSectionSchedule({ schedule: items(4), allowRepair: false, policy: POLICY,
    isUnfinished: () => true }, worker));
  assert.deepEqual([...attempts.values()], [1, 1, 1, 1]);
  assert.equal(result.retriedSections, 0);
  assert.equal(Date.now() - t0, 540000, 'two waves of one limit each');
});

test('the audit signal still cancels every section and prevents the retry', async t => {
  clock(t);
  const audit = new AbortController(), reasons = [], attempts = [];
  setTimeout(() => audit.abort(new DOMException('Job deadline', 'TimeoutError')), 50000);
  const worker = async (item, signal) => {
    attempts.push(item.index);
    try { await sleep(200000, signal); } catch { reasons.push([item.index, signal.aborted, signal.reason?.message]); }
  };
  const t0 = Date.now();
  await drive(t, schedule.runSectionSchedule({ schedule: items(2), signal: audit.signal, allowRepair: false, policy: POLICY,
    isUnfinished: () => true }, worker));
  assert.deepEqual(attempts, [0, 1]);
  assert.deepEqual(reasons, [[0, true, 'Job deadline'], [1, true, 'Job deadline']]);
  assert.equal(Date.now() - t0, 50000);
});

test('the schedule and the request limit reach each section through the call ledger policy', async t => {
  clock(t);
  const seen = [];
  const budget = schedule.finalVerdictBudget(3000);
  await drive(t, ledger.run(() => ledger.withPolicy({ ...budget.policy, deadlineMs: Date.now() + 100000 }, () =>
    schedule.runSectionSchedule({ schedule: items(2), allowRepair: false }, async () => {
      const policy = ledger.current().policy;
      seen.push([policy.verdictCallLimitMs, policy.deadlineMs - Date.now()]);
    }))));
  // The section deadline never extends the caller's own deadline.
  assert.deepEqual(seen, [[270000, 100000], [270000, 100000]]);
  seen.length = 0;
  await drive(t, ledger.run(() => ledger.withPolicy(budget.policy, () =>
    schedule.runSectionSchedule({ schedule: items(1), allowRepair: false }, async () => {
      const policy = ledger.current().policy;
      seen.push([policy.verdictCallLimitMs, policy.deadlineMs - Date.now()]);
    }))));
  assert.deepEqual(seen, [[270000, 270000]]);
});

test('audit: a verdict that needs more than its limit once finishes on the retry', { concurrency: false }, async t => {
  const windows = [[6534, 6455], [6037, 5622]];
  const run = await replayFinalVerdict(t, { windows, latency: (index, attempt) => index === 1 && attempt === 1 ? 400000 : 150000,
    verdict: () => 'fail' });
  assert.equal(run.report.verificationCompleted, true);
  assert.deepEqual(run.outcomes, ['fail', 'fail']);
  assert.deepEqual(run.calls.map(call => [call.index, call.attempt]), [[0, 1], [1, 1], [1, 2]]);
  assert.equal(run.diagnostics.sectionLimitMs, 270000);
  assert.equal(run.diagnostics.retriedWindowCount, 1);
  assert.equal(run.diagnostics.admittedWindowCount, 2);
  assert.deepEqual(run.diagnostics.outcomeCounts, { receipt_reused: 0, cancelled_before_start: 0, pass: 0, fail: 2,
    uncertain: 0, deadline_timeout: 0, cancelled: 0, error: 0 });
  const retried = run.diagnostics.windows[1];
  assert.equal(retried.attempts, 2);
  assert.equal(retried.firstOutcome, 'deadline_timeout');
  assert.equal(retried.firstElapsedMs, 270000);
  assert.equal(retried.elapsedMs, 150000);
  assert.equal(run.diagnostics.windows[0].attempts, undefined);
  // Stored history keeps the new numbers and nothing else.
  const clean = schedule.sanitizeScheduleDiagnostics({ ...run.diagnostics, note: 'synthetic text must not pass',
    windows: run.diagnostics.windows.map(w => ({ ...w, text: 'synthetic text must not pass' })) });
  assert.equal(clean.sectionLimitMs, 270000);
  assert.equal(clean.retriedWindowCount, 1);
  assert.deepEqual([clean.windows[1].attempts, clean.windows[1].firstOutcome, clean.windows[1].firstElapsedMs],
    [2, 'deadline_timeout', 270000]);
  assert.equal(JSON.stringify(clean).includes('synthetic text'), false);
  assert.equal(require('../lib/historyService').compactHistoryEngineMeta({ finalSemanticScheduleDiagnostics: run.diagnostics })
    .finalSemanticScheduleDiagnostics.retriedWindowCount, 1);
});

test('audit: a verdict that never fits is asked twice, then keeps the existing incomplete state', { concurrency: false }, async t => {
  const run = await replayFinalVerdict(t, { windows: [[2397, 2311]], latency: () => 400000 });
  assert.equal(run.report.verificationCompleted, false);
  assert.equal(run.report.pass, false);
  assert.equal(run.report.uncertain, true);
  assert.deepEqual(run.calls.map(call => call.attempt), [1, 2]);
  assert.deepEqual(run.outcomes, ['deadline_timeout']);
  assert.equal(run.diagnostics.windows[0].attempts, 2);
  assert.ok(run.finalStageMs <= 541000, `final stage ${run.finalStageMs}ms`);
});

test('audit: an outage across a long document is not retried', { concurrency: false }, async t => {
  const windows = [[8600, 8300], [8400, 8200], [8100, 8100], [4700, 4900]];
  const run = await replayFinalVerdict(t, { windows, latency: () => Infinity });
  assert.equal(run.report.verificationCompleted, false);
  assert.equal(run.calls.length, 4);
  assert.equal(run.diagnostics.retriedWindowCount, 0);
  assert.ok(run.finalStageMs <= 541000, `final stage ${run.finalStageMs}ms`);
});

test('audit: a transient request failure in one section is recovered without re-judging the others', { concurrency: false }, async t => {
  const windows = [[8600, 8300], [8400, 8200], [8100, 8100]];
  // Section 2 needs more than the request limit once (the client reports a
  // timeout error, not an abort); its second request is ordinary.
  const run = await replayFinalVerdict(t, { windows, latency: (index, attempt) => index === 2 && attempt === 1 ? 280000 : 120000 });
  assert.equal(run.report.verificationCompleted, true);
  assert.equal(run.report.pass, true);
  assert.deepEqual(run.calls.map(call => [call.index, call.attempt]), [[0, 1], [1, 1], [2, 1], [2, 2]]);
  assert.equal(run.diagnostics.windows[2].attempts, 2);
});

test('the audit runs its sections through the section schedule (source check)', () => {
  const code = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod/finalQualityV2'), 'utf8');
  assert.ok(code.includes("require('./semanticAuditSchedule').runSectionSchedule({ schedule, concurrency: 2, signal, allowRepair,"));
  assert.equal(code.includes('mapWithConcurrency(schedule, 2,'), false);
});
