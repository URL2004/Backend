'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const trace = require('../lib/transformAttemptTrace');
const ledger = require('../engine-gpt-prod/callLedger');
const cost = require('../engine-gpt-prod/modelCostSummary');
const benchmark = require('../scripts/audit-quality-benchmark');

test('attempt lifecycle keeps cancelled, preview and unfinished denominators distinct', () => {
  const job = { status: 'queued', queuedAt: 100, needed: 20 };
  trace.observeStatus(job, 100);
  job.status = 'running';
  const id = trace.begin(job, 'main', 200);
  trace.capture(job, id, { modelCallCount: 1, httpAttemptCount: 2,
    modelCost: cost.summarize([{ stage: 'primary', httpAttemptCount: 2, elapsedMs: 90, usage: { estimatedUsd: 0.03 }, unknownEstimatedUsd: 0.01 }]) });
  job.status = 'cancelled';
  trace.finish(job, id, { aborted: true, reason: 'AbortError', now: 500 });
  const summary = trace.summary(job);
  assert.equal(summary.outcome, 'cancelled');
  assert.equal(summary.unchargedKnownUsd, 0.03);
  assert.equal(summary.unknownReservedUsd, 0.01);
  assert.equal(summary.attempts[0].providerAbort, 'not_observed');
  assert.equal(summary.attempts[0].queueWaitMs, 100);
  assert.equal(summary.attempts[0].executionWallMs, 300);
  assert.equal(summary.userCharge.state, 'not_committed');
  assert.equal(trace.summary({ status: 'done', structurePreview: true }).outcome, 'preview_completed');
  assert.equal(trace.summary({ status: 'running' }).outcome, 'unfinished');
  assert.equal(trace.summary({ status: 'done' }).observed, false);
});

test('ledger observer captures failed spend without swallowing errors or breaking engine attachment', async () => {
  const seen = [], attached = [];
  await ledger.observe(async () => {
    const result = await ledger.run(() => ledger.track({ model: 'fixture' }, async () => ({ httpAttemptCount: 1, usage: { estimatedUsd: 0.1 } })), (value, snapshot) => attached.push(snapshot));
    assert.equal(result.httpAttemptCount, 1);
    await assert.rejects(ledger.run(() => ledger.track({}, async () => { throw Object.assign(new Error('abort'), { code: 'AbortError', httpAttemptCount: 1, unknownEstimatedUsd: 0.2 }); })), /abort/);
  }, snapshot => seen.push(snapshot));
  assert.equal(attached.length, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].unknownEstimatedUsd, 0.2);
});

test('nested ledger scopes observe each physical call once and queued worker sinks retain ownership', async () => {
  const snapshots = [];
  await ledger.observe(() => ledger.run(() => ledger.run(() => ledger.track({}, async () => ({ httpAttemptCount: 1, usage: { estimatedUsd: 0.12 } })))), value => snapshots.push(value));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].modelCallCount, 1);
  const seen = [], sink = ledger.observe(() => ledger.observationSink(), value => seen.push(['first', value]));
  ledger.observe(() => sink(42), value => seen.push(['second', value]));
  assert.deepEqual(seen, [['first', 42]]);
});

test('worker checkpoints do not complete the job and cancelled work retains earlier observed spend', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), EventEmitter = require('node:events');
  const workers = [];
  class FakeWorker extends EventEmitter { constructor() { super(); workers.push(this); } terminate() { return Promise.resolve(); } }
  const context = { module: { exports: {} }, __dirname, process: { env: { HUMANIZE_ENGINE_WORKERS: '1' } },
    require: name => name === 'node:worker_threads' ? { Worker: FakeWorker } : name === './logger' ? { currentContext: () => ({}) }
      : name === '../engine-gpt-prod/callLedger' ? ledger : require(name) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/humanizeWorkerPool'), 'utf8'), context);
  const seen = [], first = new AbortController();
  const a = ledger.observe(() => context.module.exports.runHumanize({ signal: first.signal }), value => seen.push(['a', value]));
  const b = ledger.observe(() => context.module.exports.runHumanize(), value => seen.push(['b', value]));
  workers[0].emit('message', { callLedger: { modelCallCount: 1 } });
  assert.equal(workers.length, 1);
  first.abort();
  await assert.rejects(a, error => error.code === 'ABORT_ERR');
  await new Promise(resolve => setImmediate(resolve));
  workers[1].emit('message', { callLedger: { modelCallCount: 2 } });
  workers[1].emit('message', { result: 'complete' });
  assert.equal(await b, 'complete');
  assert.deepEqual(seen, [['a', { modelCallCount: 1 }], ['b', { modelCallCount: 2 }]]);
});

test('lease-owned execution saves final attempt archive before releasing ownership', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const code = fs.readFileSync(require.resolve('../routes/transform'), 'utf8');
  const job = { id: 'fixture', status: 'queued', queuedAt: Date.now(), ac: new AbortController() };
  const events = [], archives = [];
  const context = { attemptTrace: trace, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, process,
    executionCoordinator: { acquire: async () => ({ token: 'owner' }), renew: async () => true,
      release: async () => { events.push('release'); } },
    require: name => name === '../engine-gpt-prod/callLedger' ? ledger : require(name),
    persistJob: async current => { assert.equal(current.executionToken, 'owner'); events.push('persist'); archives.push(structuredClone(trace.summary(current))); return { ok: true }; },
    jobPersistChains: new Map(), logger: { warn() {} } };
  vm.runInNewContext(code.slice(code.indexOf('async function executeOwned('), code.indexOf('function auxiliaryRoute(')), context);
  await context.executeOwned(job, 'main', async () => {
    job.status = 'done';
    trace.observeStatus(job);
    // Earlier terminal archive exists, followed by the attempt-finalized update.
    await context.persistJob(job);
  });
  assert.deepEqual(events, ['persist', 'persist', 'release']);
  assert.equal(archives[0].attempts[0].finishedAtMs, undefined);
  assert.ok(archives[1].attempts[0].finishedAtMs);
  assert.equal(archives[1].outcome, 'transform_completed');
  assert.equal(job.executionToken, undefined);
});

test('stage costs keep calls, HTTP retries, mandatory classification and wall latency separate', () => {
  const value = cost.summarize([
    { stage: 'semantic_document', mandatoryAudit: true, httpAttemptCount: 2, elapsedMs: 100, usage: { estimatedUsd: 0.2 } },
    { stage: 'semantic_document', httpAttemptCount: 1, elapsedMs: 300, unknownEstimatedUsd: 0.1 },
    { stage: 'primary', httpAttemptCount: 0, elapsedMs: 900 }
  ]);
  assert.equal(value.stages[0].calls, 2);
  assert.equal(value.stages[0].httpAttempts, 3);
  assert.deepEqual(value.stages[0].latency, { sampleCount: 2, p50Ms: 100, p95Ms: 300, totalCallElapsedMs: 400 });
  assert.equal(value.stages[1].latency.sampleCount, 0);
  assert.equal(value.mandatoryAuditUsd, 0.2);
  assert.deepEqual(cost.sanitize(value), value);
});

test('offline comparison excludes missing quality gates and never invents independent labels', () => {
  const result = benchmark.analyze({ rows: [{ id: 'unlabelled', genre: 'poem', baseline: { knownUsd: 1 }, candidate: { knownUsd: 0.1 } }] });
  assert.equal(result.groups[0].qualityMatchedPairs, 0);
  assert.equal(result.groups[0].candidate.knownUsd, null);
  assert.equal(result.detector.falsePositiveRate, null);
  assert.throws(() => benchmark.analyze({ rows: [{ id: 'x' }, { id: 'x' }] }), /unique/);
  const labelled = benchmark.analyze({ detectorThreshold: 50, rows: [
    { id: 'h', sourceGroupId: 'a', independentLabel: true, labelSource: 'synthetic-test', workflowLabel: 'human', detectorScore: 10 },
    { id: 'a', sourceGroupId: 'b', independentLabel: true, labelSource: 'synthetic-test', workflowLabel: 'ai', detectorScore: 70 }
  ] });
  assert.equal(labelled.detector.falsePositiveRate, 0);
  assert.equal(labelled.detector.falseNegativeRate, 0);
});

test('explicit batch proposals preserve IDs and protected, role and contract boundaries', () => {
  const block = (id, extra = {}) => ({ id, text: 'fixture', editable: true, protected: false, parentId: 'p1', contractId: 'c1', role: 'prose', ...extra });
  const blocks = [block('a'), block('b'), block('q', { protected: true }), block('c'), block('d', { parentId: 'p2' })];
  assert.equal(benchmark.planBatchExperiment(blocks).enabled, false);
  assert.deepEqual(benchmark.planBatchExperiment(blocks, { enabled: true }).batches.map(batch => batch.blockIds), [['a', 'b'], ['c'], ['d']]);
});
