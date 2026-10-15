'use strict';

// engine-deep-audit-20261015 Q3: a non-admin generate owner that lost its
// processing lease must not charge credits. Synthetic user, stubbed auth and
// billing (no Firebase), stubbed provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.WRITING_LAB_CONTEXT_SECRET ||= 'writing-lab-test-secret-with-enough-entropy';
delete process.env.DEV_NO_AUTH;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const { logger } = require('../lib/logger');
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

// The router destructures verifyToken at load time; patch before requiring it.
const config = require('../config');
config.verifyToken = async token => (token === 'synthetic-user-token' ? 'synthetic-billing-user' : null);
const usageBilling = require('../lib/usageBilling');
const charges = [];
usageBilling.precheckCredits = async () => ({ plan: 'credits' });
usageBilling.commitCreditDeduct = async (uid, needed, opType, requestId, _meta, options) => {
  const finish = await options.transactionGuard(null);
  charges.push({ uid, needed, opType, requestId });
  const receipt = { applied: true, credits: needed, plan: 'credits' };
  finish(receipt);
  return receipt;
};
usageBilling.commitCreditRestore = async () => ({ ok: true });

const jobs = require('../engine-writing-v1/jobStore');
const router = require('../routes/writinglab');
const { installOpenAIStub, writerResult } = require('./helpers/writing-openai-stub.cjs');

const SAFE = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
const INPUT = {
  genre: 'review_blog', subtype: 'place_visit', targetChars: 800, charLimitMode: 'with_space', tone: 'friendly',
  answers: { subject: '원종동의 카페를 방문했어요.', spending: '총 30,000원을 결제했어요.' }
};

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-user-token' },
    body: JSON.stringify(body)
  });
}

async function generateBody(post, requestId) {
  const prepared = await (await post('/writing-lab/v2/prepare', INPUT)).json();
  assert.ok(prepared.assessmentToken, 'non-admin prepare succeeded');
  return { ...INPUT, shortMode: true, assessmentToken: prepared.assessmentToken, requestId };
}

test('Q3: a non-admin owner is charged once on success', async t => {
  jobs.resetMemoryForTests();
  charges.length = 0;
  installOpenAIStub(t, { writing_engine_v1_result: () => writerResult(SAFE) });
  const post = await startServer(t);
  const id = 'wlv2_billing_success_0001';
  const response = await post('/writing-lab/v2/generate', await generateBody(post, id));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.billing.applied, true);
  assert.deepEqual(charges.map(row => row.requestId), [id]);
});

test('Q3: a non-admin owner whose lease was taken over during generation never reaches billing', async t => {
  jobs.resetMemoryForTests();
  charges.length = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const writerStarted = new Promise(resolve => { started = resolve; });
  installOpenAIStub(t, { writing_engine_v1_result: async () => { started(); await gate; return writerResult(SAFE); } });
  const post = await startServer(t);
  const id = 'wlv2_billing_fenced_00001';
  const pending = post('/writing-lab/v2/generate', await generateBody(post, id));
  await writerStarted;
  const current = await jobs.get('synthetic-billing-user', id);
  assert.equal(current.state, 'PROCESSING');
  const takeover = await jobs.begin('synthetic-billing-user', id, current.inputHash, Date.now() + 10 * 60 * 1000);
  assert.equal(takeover.state, 'NEW');
  release();
  const response = await pending;
  assert.equal(response.status, 202);
  assert.equal(charges.length, 0, 'the fenced owner did not charge');
  assert.equal((await jobs.get('synthetic-billing-user', id)).state, 'PROCESSING');
});
