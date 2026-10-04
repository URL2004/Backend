'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const completionState = require('../lib/transformCompletionState');
process.env.LOG_LEVEL = 'fatal';
process.env.TRANSFORM_QUEUE_TICK_MS = '20';
const config = require('../config');
config.verifyToken = async token => token;
config.ADMIN_UIDS = [];
const billing = require('../lib/usageBilling');
const runtime = require('../lib/gptRuntimeConfig');
let balance = 500, engineCalls = 0, chargeAttempts = 0, spendDuringGeneration = true;
const ledger = new Map();
billing.authenticate = async token => ({ uid: token });
billing.precheckCredits = async (token, amount) => {
  if (balance < amount) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
  return { uid: token, plan: 'free' };
};
billing.commitCreditDeduct = async (uid, amount, op, key) => {
  chargeAttempts++;
  if (ledger.has(key)) return;
  if (balance < amount) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
  ledger.set(key, amount); balance -= amount;
};
runtime.getRuntimeConfig = async () => ({ models: { detectEscalation: 'fixture' } });
runtime.isGptActive = () => true;
require('../routes/analyze-gpt').runHumanizeChunked = async opts => {
  engineCalls++;
  if (spendDuringGeneration) balance = 0;
  return { floorReport: { status: 'pass', criticals: [], warnings: [], metrics: {} }, qualityStatus: 'clean', engineMeta: {},
    result: { outputText: opts.text + '\n\n관찰한 내용을 정리했다.', engineMeta: {} } };
};
const express = require('express');
const app = express(); app.use(express.json());
const router = require('../routes/transform'); app.use(router);
const source = '연구팀은 지역 도서관의 이용 현황을 살펴봤다. 신청 과정에서 겪은 불편을 모아 안내문을 고쳤다. 이용자의 의견을 듣고 결과를 비교해 필요한 내용을 정리했다. 실제 사용 과정에서 생긴 문제를 기록했다.';

test('HTTP: insufficient balance holds the result, explicit resume bills once, cancel never resumes', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, body, uid = 'owner') => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + uid, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { http: response.status, ...await response.json() };
  };
  const waitFor = async (id, status) => {
    for (let n = 0; n < 200; n++) {
      const row = await request('/transform/' + id);
      if (row.status === status) return row;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Expected ' + status + ': ' + JSON.stringify(await request('/transform/' + id)));
  };
  try {
    const started = await request('/transform', { text: source, mode: 'blog', effectNoticeAccepted: true });
    assert.equal(started.http, 200);
    const id = started.jobId;
    const held = await waitFor(id, 'awaiting_payment');
    assert.equal(held.code, 'INSUFFICIENT_CREDITS');
    assert.equal(held.deducted, false); assert.equal(held.result, undefined);
    assert.equal((await request('/transform/active')).job.id, id);
    assert.equal((await request('/transform', { text: source, mode: 'blog' })).http, 409);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(chargeAttempts, 1); assert.equal(engineCalls, 1);
    assert.equal((await request('/transform/' + id + '/resume-payment', {}, 'other')).http, 403);
    assert.equal((await request('/transform/' + id + '/resume-payment', {})).http, 402);
    balance = 500; spendDuringGeneration = false;
    assert.equal((await request('/transform/' + id + '/resume-payment', {})).http, 200);
    const done = await waitFor(id, 'done');
    assert.ok(done.result.outputText); assert.equal(done.deducted, true);
    assert.equal(engineCalls, 1); assert.equal(ledger.size, 1); assert.equal(chargeAttempts, 2);
    assert.equal((await request('/transform/' + id + '/resume-payment', {})).http, 409);
    assert.equal((await request('/transform/active')).job, null);

    spendDuringGeneration = true; balance = 500;
    const second = await request('/transform', { text: source + ' 후속 결과도 함께 확인했다.', mode: 'blog', effectNoticeAccepted: true });
    await waitFor(second.jobId, 'awaiting_payment');
    assert.equal((await request('/transform/' + second.jobId + '/cancel', {}, 'other')).http, 403);
    assert.equal((await request('/transform/' + second.jobId + '/cancel', {})).http, 200);
    balance = 500;
    assert.equal((await request('/transform/' + second.jobId + '/resume-payment', {})).http, 409);
    await new Promise(r => setTimeout(r, 120));
    assert.equal((await request('/transform/' + second.jobId)).status, 'cancelled');
    assert.equal((await request('/transform/active')).job, null);
    assert.equal(ledger.size, 1); assert.equal(engineCalls, 2);
  } finally { await new Promise(r => server.close(r)); }
});

test('restart keeps payment holds, clears legacy cancelled completion and only queues transient recovery', async () => {
  const now = Date.now();
  const docs = [
    { id: 'cancelled', status: 'cancelled', createdAt: now, pendingCompletion: { result: {} } },
    { id: 'payment', status: 'awaiting_payment', createdAt: now, pendingCompletion: { result: {} } },
    { id: 'transient', status: 'running', createdAt: now, pendingCompletion: { result: {} } }
  ];
  const context = { completionState, AbortController, Date, jobs: new Map(), TERMINAL_JOB_STATUSES: new Set(['done', 'blocked', 'error', 'cancelled']),
    JOB_TTL_MS: 21600000, RESTORE_QUEUE_DRAIN_DELAY_MS: 1, RESTORE_RUNNING_RECOVERY_DELAY_MS: 1,
    logger: { info() {}, warn(error) { throw error; } }, archiveJob() {}, deletePersisted() {},
    persistJob: async () => ({ ok: true }), scheduleQueueDrain() {}, restorationReady: false,
    db: { collection() { return { orderBy() { return { limit() { return { get: async () => ({ docs: docs.map(row => ({ id: row.id, data: () => structuredClone(row) })) }) }; } }; } }; } } };
  const code = fs.readFileSync(require.resolve('../routes/transform'), 'utf8');
  vm.createContext(context);
  vm.runInContext(code.slice(code.indexOf('async function restoreJobs()'), code.indexOf('\nrestoreJobs();')), context);
  await context.restoreJobs();
  assert.equal(context.jobs.get('cancelled').status, 'cancelled');
  assert.equal(context.jobs.get('cancelled').pendingCompletion, null);
  assert.equal(context.jobs.get('payment').status, 'awaiting_payment');
  assert.equal(context.jobs.get('transient').status, 'queued');
});

test('billing never retries a balance failure but retries a transient error', async () => {
  let calls = 0;
  await assert.rejects(billing.retryAsync(async () => { calls++; throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 }); }, 3, 1));
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await billing.retryAsync(async () => { if (++calls < 3) throw new Error('temporary'); return 'ok'; }, 3, 1), 'ok');
  assert.equal(calls, 3);
});
