'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
process.env.WRITING_LAB_CONTEXT_SECRET ||= 'writing-lab-synthetic-staged-test-secret';
delete process.env.DEV_NO_AUTH; delete process.env.FIREBASE_SERVICE_ACCOUNT;
const config = require('../config');
config.verifyToken = async token => token === 'synthetic-stage-token' ? 'synthetic-stage-user' : null;
const logger = require('../lib/logger').logger;
logger.warn = () => {}; logger.error = () => {}; logger.info = () => {};
const billing = require('../lib/usageBilling'), usage = require('../engine-writing-v1/usage');
const jobs = require('../engine-writing-v1/jobStore'), engine = require('../engine-writing-v1');
const telemetry = require('../engine-writing-v1/telemetry');
const { signContext, verifyContext } = require('../engine-writing-v1/contextToken');
const router = require('../routes/writinglab');
const { installOpenAIStub, writerResult } = require('./helpers/writing-openai-stub.cjs');
const INPUT = { genre: 'review_blog', subtype: 'place_visit', targetChars: 800, charLimitMode: 'with_space', tone: 'friendly',
  answers: { subject: '원종동의 카페를 방문했어요.', spending: '총 30,000원을 결제했어요.' } };
const SAFE = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
let sequence = 0;

async function setup(t) {
  jobs.resetMemoryForTests(); usage.resetMemoryForTests(); telemetry.resetMemoryForTests();
  const charged = new Map(), restores = [], observed = { generations: 0, prechecks: 0, stage: null };
  const originalGenerate = engine.generate, originalStage = jobs.stageCompletion;
  t.mock.method(engine, 'generate', (...args) => { observed.generations++; return originalGenerate(...args); });
  t.mock.method(jobs, 'stageCompletion', async (...args) => { const value = await originalStage(...args); observed.stage = value; return value; });
  t.mock.method(billing, 'precheckCredits', async () => { observed.prechecks++; return { plan: 'free' }; });
  t.mock.method(billing, 'commitCreditDeduct', async (uid, needed, op, id, meta, options) => {
    const finish = await options.transactionGuard(null);
    const receipt = charged.get(id) || { applied: true, credits: needed, plan: 'free' };
    charged.set(id, receipt); finish(receipt); return receipt;
  });
  t.mock.method(billing, 'commitCreditRestore', async (uid, needed, op, id, options) => {
    const finish = await options.transactionGuard(null); restores.push(id); charged.delete(id); finish();
    return { restoredCredits: needed };
  });
  installOpenAIStub(t, { writing_engine_v1_result: () => writerResult(SAFE) });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer synthetic-stage-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const prepare = await post('/writing-lab/v2/prepare', INPUT);
  assert.equal(prepare.status, 200);
  const body = { ...INPUT, shortMode: true, assessmentToken: prepare.body.assessmentToken, requestId: 'synthetic_stage_http_' + ++sequence };
  return { post, body, charged, restores, observed, generate: next => post('/writing-lab/v2/generate', next || body) };
}

test('paid staged result survives completion failure and recovers without balance/cap prechecks or another writer call, even with an expired signed assessment', async t => {
  const f = await setup(t), complete = jobs.complete;
  let failOnce = true;
  t.mock.method(jobs, 'complete', async (...args) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error('storage unavailable'), { code: 'WRITING_JOB_PERSIST_UNAVAILABLE', status: 503 }); }
    return complete(...args);
  });
  const first = await f.generate(); assert.equal(first.status, 503); assert.equal(f.charged.size, 1);
  assert.doesNotMatch(first.body.error, /차감하지|사용되지/);
  assert.equal((await jobs.get('synthetic-stage-user', f.body.requestId)).leaseExpired, true);
  t.mock.method(billing, 'precheckCredits', async () => { assert.fail('already paid recovery must not balance-precheck'); });
  t.mock.method(usage, 'successfulCount', async () => { assert.fail('already counted recovery must not cap-precheck'); });
  const expired = signContext(verifyContext(f.body.assessmentToken).context, { ttlMs: -1 });
  const recovered = await f.generate({ ...f.body, assessmentToken: expired });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.draft, SAFE);
  assert.equal(recovered.body.verificationToken, f.observed.stage.payload.verificationToken);
  assert.deepEqual(recovered.body.usage.modelCalls, f.observed.stage.payload.usage.modelCalls);
  assert.equal(recovered.body.usage.daily.duplicate, true);
  assert.equal(f.observed.generations, 1); assert.equal(f.charged.size, 1); assert.equal(f.restores.length, 0);
  const [metrics] = await telemetry.snapshot(1);
  assert.equal(metrics.costs.generate.modelCalls, f.observed.stage.cost.modelCallCount, 'recovery does not count historical provider costs twice');
  const fresh = await f.generate({ ...f.body, requestId: f.body.requestId + '_fresh', assessmentToken: expired });
  assert.equal(fresh.status, 400); assert.equal(fresh.body.code, 'CONTEXT_TOKEN_EXPIRED');
});

test('ambiguous usage commit retains the stage and reconciles without a compensating refund', async t => {
  const f = await setup(t), commit = usage.commitSuccessful; let failOnce = true;
  t.mock.method(usage, 'commitSuccessful', async (...args) => {
    const result = await commit(...args);
    if (failOnce) { failOnce = false; return { unavailable: true }; }
    return result;
  });
  const first = await f.generate(); assert.equal(first.status, 503); assert.equal(first.body.code, 'WRITING_USAGE_UNAVAILABLE');
  assert.equal(f.restores.length, 0); assert.equal((await jobs.get('synthetic-stage-user', f.body.requestId)).hasPendingCompletion, true);
  const second = await f.generate(); assert.equal(second.status, 200); assert.equal(second.body.usage.daily.duplicate, true);
  assert.equal(f.observed.generations, 1); assert.equal(f.charged.size, 1); assert.equal(f.restores.length, 0);
});

test('a vanished stage after skipped prechecks fails closed instead of starting unprechecked generation', async t => {
  const f = await setup(t);
  t.mock.method(billing, 'commitCreditDeduct', async () => { throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 }); });
  assert.equal((await f.generate()).status, 402);
  const begin = jobs.begin;
  t.mock.method(jobs, 'begin', async (...args) => { jobs.resetMemoryForTests(); return begin(...args); });
  const retry = await f.generate(); assert.equal(retry.status, 409); assert.equal(retry.body.code, 'WRITING_RECOVERY_STATE_CHANGED');
  assert.equal(f.observed.generations, 1); assert.equal(f.observed.prechecks, 1);
});

test('unbilled staged result returns 402, stays recoverable within TTL, and uses the same draft after top-up', async t => {
  const f = await setup(t), deduct = billing.commitCreditDeduct; let insufficient = true;
  t.mock.method(billing, 'commitCreditDeduct', async (...args) => {
    if (insufficient) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
    return deduct(...args);
  });
  assert.equal((await f.generate()).status, 402); assert.equal(f.charged.size, 0);
  const saved = await jobs.get('synthetic-stage-user', f.body.requestId);
  assert.equal(saved.hasPendingCompletion, true); assert.equal(saved.leaseExpired, true);
  insufficient = false;
  const response = await f.generate(); assert.equal(response.status, 200); assert.equal(response.body.draft, SAFE);
  assert.equal(f.observed.generations, 1); assert.equal(f.observed.prechecks, 1); assert.equal(f.charged.size, 1);
});

test('confirmed cap refund terminalizes the request and never regenerates or redelivers on the same ID', async t => {
  const f = await setup(t);
  t.mock.method(usage, 'commitSuccessful', async () => ({ committed: false, capReached: true }));
  const first = await f.generate(); assert.equal(first.status, 429); assert.equal(f.restores.length, 1); assert.equal(f.charged.size, 0);
  const failed = await jobs.get('synthetic-stage-user', f.body.requestId);
  assert.equal(failed.state, 'FAILED'); assert.equal(failed.error.code, 'DAILY_CAP');
  const next = await f.generate(); assert.equal(next.status, 429); assert.equal(f.observed.generations, 1); assert.equal(f.restores.length, 1);
});
