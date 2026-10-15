'use strict';

// engine-deep-audit-20261015 W3 / Q3: request-scoped call ledger and cost
// summaries, absolute deadlines, cancellation ownership, and the fenced
// processing lease of durable generate jobs. Synthetic only: the provider is
// stubbed, persistence is the in-memory job store (no Firebase configured).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.WRITING_LAB_CONTEXT_SECRET ||= 'writing-lab-test-secret-with-enough-entropy';
process.env.DEV_NO_AUTH = '1';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const { logger } = require('../lib/logger');
const usageLogs = [];
logger.info = (event, fields) => { if (event === 'gpt_prod.usage') usageLogs.push(fields); };
logger.warn = () => {};
logger.error = () => {};

const engine = require('../engine-writing-v1');
const jobs = require('../engine-writing-v1/jobStore');
const telemetry = require('../engine-writing-v1/telemetry');
const lifecycle = require('../engine-writing-v1/requestLifecycle');
const router = require('../routes/writinglab');
const { installOpenAIStub, failure, writerResult } = require('./helpers/writing-openai-stub.cjs');

const SAFE = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
const SHORT = '원종동 카페에서 3만원 결제.';
const INPUT = {
  genre: 'review_blog', subtype: 'place_visit', targetChars: 800, charLimitMode: 'with_space', tone: 'friendly',
  answers: { subject: '원종동의 카페를 방문했어요.', spending: '총 30,000원을 결제했어요.' }
};

let sequence = 0;
const requestId = () => `wlv2_lifecycle_${Date.now().toString(36)}_${(sequence += 1)}`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function startServer(t) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, init = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init
  });
  const get = path => fetch(`${base}${path}`);
  return { post, get };
}

async function preparedGenerateBody(api, id) {
  const prepared = await (await api.post('/writing-lab/v2/prepare', INPUT)).json();
  assert.ok(prepared.assessmentToken);
  return { ...INPUT, shortMode: true, assessmentToken: prepared.assessmentToken, requestId: id };
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function reset() {
  jobs.resetMemoryForTests();
  telemetry.resetMemoryForTests();
  usageLogs.length = 0;
}

const sumUsd = logs => Math.round(logs.reduce((sum, row) => sum + Number(row.estimatedUsd || 0), 0) * 1e6);

// ── W3: request-scoped ledger and stored cost summaries ──────────────

test('W3: a generate request records one ledger whose call totals match the individual usage logs', async t => {
  reset();
  const stub = installOpenAIStub(t, {
    writing_engine_v1_result: () => writerResult(SHORT),
    writing_engine_v1_repair: () => ({ outputText: SAFE, notes: [] })
  });
  const api = await startServer(t);
  const id = requestId();
  const response = await api.post('/writing-lab/v2/generate', await preparedGenerateBody(api, id));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.draft, SAFE);
  assert.deepEqual(payload.usage.modelCalls, { count: 4, httpAttempts: 4, retries: 0 });
  assert.equal(JSON.stringify(payload).includes('knownUsd'), false, 'USD is not returned to the client');

  assert.equal(usageLogs.length, stub.calls.length);
  const stored = await jobs.get('dev-local', id);
  assert.equal(stored.state, 'READY');
  assert.equal(stored.cost.version, 'writing-cost-v1');
  assert.equal(stored.cost.kind, 'generate');
  assert.equal(stored.cost.modelCallCount, usageLogs.length);
  assert.equal(stored.cost.httpAttemptCount, stub.calls.length);
  assert.equal(Math.round(stored.cost.knownUsd * 1e6), sumUsd(usageLogs));
  assert.deepEqual(stored.cost.phases.map(row => row.phase).sort(),
    ['main', 'writing_lab_deterministic_repair_1_1', 'writing_lab_draft', 'writing_lab_draft_repair_confirm'].sort());
  assert.equal(JSON.stringify(stored.cost).includes('원종동'), false, 'no user text in the cost summary');

  const [row] = await telemetry.snapshot(1);
  assert.equal(row.events.GENERATE_READY, 1);
  assert.equal(row.costs.generate.requests, 1);
  assert.equal(row.costs.generate.modelCalls, 4);
  assert.equal(row.costs.generate.httpAttempts, 4);
  assert.equal(row.costs.generate.knownMicroUsd, sumUsd(usageLogs));
});

test('W3: a draft fallback after provider failures keeps failed calls, retries and unknown usage in the ledger', async t => {
  reset();
  const stub = installOpenAIStub(t, { writing_engine_v1_result: () => failure(503, 'busy') });
  const api = await startServer(t);
  const id = requestId();
  const response = await api.post('/writing-lab/v2/generate', await preparedGenerateBody(api, id));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.semantic.deterministicProjection, true);
  assert.equal(payload.billing.waivedReason ?? 'admin', 'admin');
  const stored = await jobs.get('dev-local', id);
  assert.equal(stored.cost.failedCallCount, 1);
  assert.equal(stored.cost.httpAttemptCount, stub.calls.length);
  assert.equal(stored.cost.retryCounts.server, 2);
  assert.equal(stored.cost.unknownUsageCount, 3, 'possibly billed 5xx sends stay unknown');
  assert.equal(usageLogs.length, 1, 'one failed logical call, one usage log');
  const [row] = await telemetry.snapshot(1);
  assert.equal(row.events.GENERATE_FALLBACK_READY, 1);
  assert.equal(row.costs.generate.failedCalls, 1);
  assert.equal(row.costs.generate.unknownUsageCalls, 3);
});

test('W3/W4: finalize and check run in their own ledgers and expose the verifier-outage contract', async t => {
  reset();
  let outage = false;
  installOpenAIStub(t, {
    writing_engine_v1_result: () => writerResult(SAFE),
    gpt_prod_semantic_judge: () => (outage ? failure(503, 'busy') : { violations: [] })
  });
  const api = await startServer(t);
  const generated = await (await api.post('/writing-lab/v2/generate', await preparedGenerateBody(api, requestId()))).json();
  assert.ok(generated.verificationToken);
  outage = true;
  usageLogs.length = 0;
  const humanized = '원종동의 카페에 들렀고 그날 결제한 금액은 모두 합해 총 30,000원이었어요.';
  const finalized = await (await api.post('/writing-lab/v2/finalize', { verificationToken: generated.verificationToken, text: humanized })).json();
  assert.equal(finalized.delivery.source, 'verified_generation_fallback');
  assert.equal(finalized.text, generated.draft);
  assert.equal(finalized.delivery.fallbackReason, 'verification_unavailable');
  assert.equal(finalized.delivery.retryable, true);
  assert.equal(usageLogs.length, 1);

  const checked = await (await api.post('/writing-lab/v2/check', { verificationToken: generated.verificationToken, text: humanized })).json();
  assert.equal(checked.release.verification, 'unavailable');
  assert.equal(checked.retryable, true);

  const [row] = await telemetry.snapshot(1);
  assert.equal(row.events.FINALIZE_FALLBACK, 1);
  assert.equal(row.events.FINALIZE_VERIFICATION_UNAVAILABLE, 1);
  assert.equal(row.events.FINAL_CHECK_UNAVAILABLE, 1);
  assert.equal(row.costs.finalize.requests, 1);
  assert.equal(row.costs.finalize.httpAttempts, 3, 'judge 5xx: one send + two server retries');
  assert.equal(row.costs.finalize.unknownUsageCalls, 3);
  assert.equal(row.costs.check.requests, 1);
});

test('W3/Q2: the writing cost summary keeps a proven request rejection out of unknown usage, but not a 5xx', async t => {
  const { completeJson } = require('../engine-gpt-prod/openaiClient');
  const schema = { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] };
  const call = () => completeJson({ system: 's', user: 'u', schema, schemaName: 'probe', model: 'gpt-6-luna', meta: { task: 'detect', phase: 'probe' } });
  let status = 400;
  installOpenAIStub(t, { probe: () => failure(status, 'rejected', { type: status === 400 ? 'invalid_request_error' : 'server_error' }) });
  await assert.rejects(lifecycle.runMeasured('check', call), error => {
    assert.equal(error.writingCost.failedCallCount, 1);
    assert.equal(error.writingCost.httpAttemptCount, 1);
    assert.equal(error.writingCost.unknownUsageCount, 0);
    assert.equal(error.writingCost.unknownReservedUsd, 0);
    assert.equal(error.callLedger, undefined, 'raw ledger entries are not carried on the error');
    return true;
  });
  status = 503;
  await assert.rejects(lifecycle.runMeasured('check', call), error => {
    assert.equal(error.writingCost.httpAttemptCount, 3);
    assert.equal(error.writingCost.unknownUsageCount, 3);
    assert.ok(error.writingCost.unknownReservedUsd > 0);
    return true;
  });
});

// ── Q3: fenced processing lease ──────────────────────────────────────

test('Q3: the processing lease blocks takeover while renewed, fences the stale owner after takeover', async () => {
  jobs.resetMemoryForTests();
  const t0 = 1_800_000_000_000;
  const id = 'wlv2_lease_fence_0001';
  const first = await jobs.begin('lease-user', id, 'hash', t0, { deadlineMs: 8 * 60 * 1000 });
  assert.equal(first.state, 'NEW');
  assert.ok(first.leaseId);
  assert.equal(first.leaseExpiresAtMs, t0 + jobs.LEASE_TTL_MS);
  assert.equal((await jobs.begin('lease-user', id, 'hash', t0 + 1000)).state, 'PROCESSING');

  const renewed = await jobs.renew('lease-user', id, 'hash', first.leaseId, t0 + 60_000);
  assert.equal(renewed.ok, true);
  assert.equal(renewed.leaseExpiresAtMs, t0 + 60_000 + jobs.LEASE_TTL_MS);
  assert.equal((await jobs.begin('lease-user', id, 'hash', t0 + 120_000)).state, 'PROCESSING', 'renewed lease still owned');
  assert.equal((await jobs.get('lease-user', id)).state, 'PROCESSING');

  // The owner stops renewing (crash/hang): after expiry the same request may resume.
  const second = await jobs.begin('lease-user', id, 'hash', t0 + 151_000);
  assert.equal(second.state, 'NEW');
  assert.notEqual(second.leaseId, first.leaseId);

  assert.deepEqual(await jobs.renew('lease-user', id, 'hash', first.leaseId, t0 + 152_000), { ok: false, reason: 'LEASE_LOST' });
  await assert.rejects(jobs.complete('lease-user', id, 'hash', { ok: true, draft: 'stale' }, t0 + 153_000, { leaseId: first.leaseId }),
    error => error.code === 'WRITING_JOB_LEASE_LOST');
  assert.deepEqual(await jobs.fail('lease-user', id, 'hash', new Error('stale'), t0 + 153_000, { leaseId: first.leaseId }),
    { recorded: false, fenced: true });
  assert.equal((await jobs.get('lease-user', id)).state, 'PROCESSING', 'the current owner is untouched');

  await jobs.complete('lease-user', id, 'hash', { ok: true, draft: 'current' }, t0 + 154_000, { leaseId: second.leaseId });
  const ready = await jobs.get('lease-user', id);
  assert.equal(ready.state, 'READY');
  assert.equal(ready.result.draft, 'current');
});

test('Q3: renewals never extend a lease past deadline + grace, so a 10-minute retry finds a reclaimable job', async () => {
  jobs.resetMemoryForTests();
  const t0 = 1_800_000_000_000;
  const id = 'wlv2_lease_deadline_01';
  const claim = await jobs.begin('lease-user', id, 'hash', t0, { deadlineMs: 8 * 60 * 1000 });
  assert.equal(claim.deadlineAtMs, t0 + 8 * 60 * 1000);
  let lastOk = null;
  let refusal = null;
  for (let at = t0 + 30_000; at <= t0 + 10 * 60 * 1000; at += 30_000) {
    const renewed = await jobs.renew('lease-user', id, 'hash', claim.leaseId, at);
    if (renewed.ok) {
      lastOk = renewed;
      assert.ok(renewed.leaseExpiresAtMs <= claim.deadlineAtMs + jobs.FINISH_GRACE_MS);
    } else { refusal = renewed.reason; break; }
  }
  assert.equal(lastOk.leaseExpiresAtMs, claim.deadlineAtMs + jobs.FINISH_GRACE_MS);
  assert.equal(refusal, 'LEASE_EXPIRED');
  const retry = await jobs.begin('lease-user', id, 'hash', t0 + 10 * 60 * 1000);
  assert.equal(retry.state, 'NEW');
  const stale = await jobs.get('lease-user', id);
  assert.equal(stale.state, 'PROCESSING');
});

test('Q3: an expired lease is reported as resumable by GET jobs', async t => {
  jobs.resetMemoryForTests();
  const api = await startServer(t);
  const id = 'wlv2_lease_resumable_01';
  await jobs.begin('dev-local', id, 'hash', Date.now() - 10 * 60 * 1000);
  const response = await api.get(`/writing-lab/v2/jobs/${id}`);
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'PROCESSING');
  assert.equal(body.resumable, true);
});

test('Q3: the lease keeper aborts locally before an unconfirmed lease can be taken over', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  t.after(() => t.mock.timers.reset());
  const now = Date.now();
  let renewCalls = 0;
  const lease = lifecycle.createJobLease({
    store: { renew: async () => { renewCalls += 1; return { ok: false, reason: 'UNAVAILABLE' }; } },
    uid: 'u', requestId: 'wlv2_keeper_unavailable', inputHash: 'h', leaseId: 'L1',
    leaseExpiresAtMs: now + 90_000, deadlineAtMs: now + 8 * 60 * 1000
  });
  t.after(() => lease.stop());
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  t.mock.timers.tick(30_000); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(lease.signal.aborted, false, 'store outage is tolerated while the lease is confirmed');
  await lease.assertOwned();
  t.mock.timers.tick(19_999); await flush();
  assert.equal(lease.signal.aborted, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(lease.signal.aborted, true, 'aborts guardMs before the confirmed expiry');
  assert.equal(lease.signal.reason.code, lifecycle.ABORT_CODES.LEASE_LOST);
  assert.equal(lease.lostReason(), 'local_expiry');
  await assert.rejects(lease.assertOwned(), error => error.code === 'WRITING_JOB_LEASE_LOST');
  assert.ok(renewCalls >= 2);
});

test('Q3: successful renewals keep ownership; a refused renewal or the deadline aborts with its own reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  t.after(() => t.mock.timers.reset());
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  const start = Date.now();
  const healthy = lifecycle.createJobLease({
    store: { renew: async (_u, _r, _h, _l, at) => ({ ok: true, leaseExpiresAtMs: at + 90_000 }) },
    uid: 'u', requestId: 'r', inputHash: 'h', leaseId: 'L', leaseExpiresAtMs: start + 90_000, deadlineAtMs: start + 300_000
  });
  for (let i = 0; i < 9; i += 1) { t.mock.timers.tick(30_000); await flush(); }
  assert.equal(healthy.signal.aborted, false, 'renewed for 270s past the initial 90s lease');
  t.mock.timers.tick(30_000); await flush();
  assert.equal(healthy.signal.aborted, true);
  assert.equal(healthy.signal.reason.code, lifecycle.ABORT_CODES.DEADLINE);
  healthy.stop();

  const refused = lifecycle.createJobLease({
    store: { renew: async () => ({ ok: false, reason: 'LEASE_LOST' }) },
    uid: 'u', requestId: 'r', inputHash: 'h', leaseId: 'L', leaseExpiresAtMs: Date.now() + 90_000, deadlineAtMs: Date.now() + 300_000
  });
  t.mock.timers.tick(30_000); await flush();
  assert.equal(refused.signal.aborted, true);
  assert.equal(refused.signal.reason.code, lifecycle.ABORT_CODES.LEASE_LOST);
  refused.stop();
});

test('Q3: the engine treats a deadline as a free projection fallback, and a lost lease as a stop without output', async () => {
  const waitForAbort = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true });
  });
  const deadline = new AbortController();
  const pendingDeadline = engine.generate(INPUT, { shortMode: true, signal: deadline.signal, callWriter: waitForAbort,
    semanticVerify: async () => { throw new Error('no verdict after the deadline'); } });
  deadline.abort(lifecycle.abortError(lifecycle.ABORT_CODES.DEADLINE));
  const projected = await pendingDeadline;
  assert.equal(projected.release.pass, true);
  assert.equal(projected.semantic.deterministicProjection, true);
  assert.equal(projected.attempts[0].stage, 'writer_unavailable');

  const lost = new AbortController();
  const pendingLost = engine.generate(INPUT, { shortMode: true, signal: lost.signal, callWriter: waitForAbort });
  lost.abort(lifecycle.abortError(lifecycle.ABORT_CODES.LEASE_LOST));
  await assert.rejects(pendingLost, error => error.code === 'WRITING_JOB_LEASE_LOST' && error.status === 409);

  let writerCalls = 0;
  const late = await engine.generate(INPUT, {
    shortMode: true,
    deadlineAtMs: Date.now() + engine.MODEL_STEP_RESERVE_MS - 1,
    callWriter: async () => { writerCalls += 1; return writerResult(SAFE); }
  });
  assert.equal(writerCalls, 0, 'no model step that could not be verified before the deadline');
  assert.deepEqual(late.attempts[0], { stage: 'writer_skipped', pass: false, reasons: ['deadline_reached'] });
  assert.equal(late.semantic.deterministicProjection, true);
});

test('Q3: a concurrent retry gets PROCESSING, a client disconnect does not cancel the durable job', async t => {
  reset();
  const release = deferred();
  const started = deferred();
  installOpenAIStub(t, {
    writing_engine_v1_result: async () => { started.resolve(); await release.promise; return writerResult(SAFE); }
  });
  const api = await startServer(t);
  const id = requestId();
  const body = await preparedGenerateBody(api, id);
  const client = new AbortController();
  const first = api.post('/writing-lab/v2/generate', body, { signal: client.signal }).catch(error => ({ aborted: error.name }));
  await started.promise;

  const concurrent = await api.post('/writing-lab/v2/generate', body);
  assert.equal(concurrent.status, 202);
  assert.equal((await concurrent.json()).status, 'PROCESSING');

  client.abort();
  assert.equal((await first).aborted, 'AbortError');
  release.resolve();
  const ready = await waitFor(async () => {
    const response = await api.get(`/writing-lab/v2/jobs/${id}`);
    return response.status === 200 ? response.json() : null;
  });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.draft, SAFE);

  const replay = await api.post('/writing-lab/v2/generate', body);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).draft, SAFE, 'idempotent replay of the stored result');
});

// The dev-auth harness is an admin (never billed); the billing fence is the
// assertOwned() call that precedes commitCreditDeduct in the route.
test('Q3: an owner that lost its lease mid-generation does not persist its result and reports PROCESSING', async t => {
  reset();
  const release = deferred();
  const started = deferred();
  installOpenAIStub(t, {
    writing_engine_v1_result: async () => { started.resolve(); await release.promise; return writerResult(SAFE); }
  });
  const api = await startServer(t);
  const id = requestId();
  const body = await preparedGenerateBody(api, id);
  const pending = api.post('/writing-lab/v2/generate', body);
  await started.promise;
  const stored = await waitFor(async () => {
    const job = await jobs.get('dev-local', id);
    return job.state === 'PROCESSING' ? job : null;
  });
  // A takeover after the lease expired (simulated with a future clock).
  const takeover = await jobs.begin('dev-local', id, stored.inputHash, Date.now() + 10 * 60 * 1000);
  assert.equal(takeover.state, 'NEW');
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'PROCESSING');
  const after = await jobs.get('dev-local', id);
  assert.equal(after.state, 'PROCESSING', 'the stale owner did not write READY over the new owner');
  const [row] = await telemetry.snapshot(1);
  assert.equal(row.events.GENERATE_LEASE_LOST, 1);
  assert.equal(row.events.GENERATE_READY, undefined);
});

test('Q3: a client disconnect cancels a synchronous finalize and its in-flight verdict call', async t => {
  reset();
  let judgeAborted = false;
  const judgeStarted = deferred();
  let blockJudge = false;
  installOpenAIStub(t, {
    writing_engine_v1_result: () => writerResult(SAFE),
    gpt_prod_semantic_judge: request => {
      if (!blockJudge) return { violations: [] };
      judgeStarted.resolve();
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => {
        judgeAborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true }));
    }
  });
  const api = await startServer(t);
  const generated = await (await api.post('/writing-lab/v2/generate', await preparedGenerateBody(api, requestId()))).json();
  blockJudge = true;
  const client = new AbortController();
  const pending = api.post('/writing-lab/v2/finalize', {
    verificationToken: generated.verificationToken,
    text: '원종동의 카페에 들렀고 그날 결제한 금액은 모두 합해 총 30,000원이었어요.'
  }, { signal: client.signal }).catch(error => ({ aborted: error.name }));
  await judgeStarted.promise;
  client.abort();
  assert.equal((await pending).aborted, 'AbortError');
  await waitFor(() => judgeAborted);
  const row = await waitFor(async () => {
    const [current] = await telemetry.snapshot(1);
    return current?.events?.FINALIZE_CANCELLED ? current : null;
  });
  assert.equal(row.events.FINALIZE_CANCELLED, 1);
  assert.equal(row.events.FINALIZE_FALLBACK, undefined);
});
