'use strict';

// T1 / Q2 (engine-deep-audit-20261015): body-read transport failures and the
// conservative recovery-budget settlement of failed provider responses.
// Synthetic only: global.fetch is replaced and no network is reached.
const test = require('node:test');
const assert = require('node:assert/strict');
const { completeJson } = require('../engine-gpt-prod/openaiClient');
const callLedger = require('../engine-gpt-prod/callLedger');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');
const { classifyModelFailure, isTransportFailureCode } = require('../engine-gpt-prod/modelFailure');

const SCHEMA = { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] };
const COMPLETED = {
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"value":"ok"}' }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function terminatedBody() {
  const error = new TypeError('terminated');
  error.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  return error;
}

// 200 headers arrive, then the socket closes while the JSON body is read.
function okHeadersThenTerminated() {
  return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => { throw terminatedBody(); } };
}

function withFetch(t, impl) {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = impl;
  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
}

const call = (extra = {}) => completeJson({ system: 'synthetic', user: 'synthetic', schema: SCHEMA, model: 'gpt-6-luna',
  meta: { task: 'detect', phase: 'main' }, ...extra });

test('T1: a body terminated after 200 headers is a transport failure, retried once and kept as unknown usage', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => (++sends === 1 ? okHeadersThenTerminated() : jsonResponse(200, COMPLETED)));
  const result = await call();
  assert.equal(sends, 2);
  assert.equal(result.json.value, 'ok');
  assert.equal(result.retryCounts.network, 1);
  assert.equal(result.httpAttemptCount, 2);
  // The cut response may have been billed: its reservation stays unknown.
  assert.equal(result.unknownUsageCount, 1);
  assert.ok(result.unknownEstimatedUsd > 0);
  assert.equal(result.usage.inputTokens, 10);
});

test('T1: repeated body termination stops after one resend and is classified as a network failure', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => { sends += 1; return okHeadersThenTerminated(); });
  await assert.rejects(call(), error => {
    assert.equal(error.code, 'OPENAI_BODY_TERMINATED');
    assert.equal(error.possiblyBilled, true);
    assert.equal(error.httpAttemptCount, 2);
    assert.equal(error.unknownUsageCount, 2);
    assert.equal(error.retryCounts.network, 1);
    assert.equal(classifyModelFailure(error), 'openai_network_error');
    assert.equal(isTransportFailureCode(classifyModelFailure(error)), true);
    return true;
  });
  assert.equal(sends, 2);
});

test('T1: a raw undici termination is classified as transport, not as a generic model failure', () => {
  assert.equal(classifyModelFailure(terminatedBody()), 'openai_network_error');
  assert.notEqual(classifyModelFailure(new SyntaxError('Unexpected end of JSON input')), 'openai_network_error');
});

test('T1: a protected semantic verdict is not resent after a body cut', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => { sends += 1; return okHeadersThenTerminated(); });
  await assert.rejects(call({ meta: { task: 'judge', phase: 'semantic' } }), error => {
    assert.equal(error.code, 'OPENAI_BODY_TERMINATED');
    assert.equal(error.httpAttemptCount, 1);
    assert.equal(error.unknownUsageCount, 1);
    assert.equal(error.retryCounts.network, 0);
    return true;
  });
  assert.equal(sends, 1);
});

test('T1: connect-time failures keep their existing retry and malformed bodies are not treated as transport', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => {
    sends += 1;
    if (sends === 1) throw new TypeError('fetch failed');
    if (sends === 2) return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } };
    return jsonResponse(200, COMPLETED);
  });
  await assert.rejects(call(), error => error instanceof SyntaxError || error.name === 'SyntaxError');
  assert.equal(sends, 2);
});

test('T1: a body-cut resend never runs past the request deadline', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => { sends += 1; return okHeadersThenTerminated(); });
  await assert.rejects(call({ deadlineMs: Date.now() + 40 }), error => {
    assert.equal(error.code, 'OPENAI_BODY_TERMINATED');
    assert.equal(error.unknownUsageCount, 1);
    return true;
  });
  assert.equal(sends, 1);
});

test('T1: caller cancellation while reading the body stays an abort with unknown usage', { concurrency: false }, async t => {
  const controller = new AbortController();
  withFetch(t, async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
    json: () => new Promise(() => {}) }));
  const pending = call({ signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, error => {
    assert.ok(error.code === 'ABORT_ERR' || error.name === 'AbortError');
    assert.equal(error.unknownUsageCount, 1);
    return true;
  });
});

async function optionalRecoveryCall(budgetUsd, fetchImpl, t, { calls = 1 } = {}) {
  withFetch(t, fetchImpl);
  return callLedger.run(async () => {
    const budget = createRecoveryBudget(budgetUsd, { jobDeadlineMs: Date.now() + 3600000 });
    callLedger.setRecoveryBudget(budget);
    const outcomes = [];
    for (let i = 0; i < calls; i += 1) {
      outcomes.push(await callLedger.withPolicy({ stage: 'style_recovery', optional: true }, () => completeJson({
        system: 's', user: 'u'.repeat(2000), schema: SCHEMA, schemaName: 'probe', model: 'gpt-6.1-sol', maxOutputTokens: 4096,
        meta: { task: 'humanize', phase: 'recovery' }
      })).then(result => ({ ok: true, result }), error => ({ ok: false, error })));
    }
    return { outcomes, budget: budget.snapshot() };
  });
}

test('Q2: a typed 429 rate-limit rejection is settled as zero known usage and leaves optional recovery available', { concurrency: false }, async t => {
  let sends = 0;
  const out = await optionalRecoveryCall(0.15, async () => (++sends <= 3
    ? jsonResponse(429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '0' })
    : jsonResponse(200, COMPLETED)), t, { calls: 1 });
  assert.equal(out.outcomes[0].ok, true);
  assert.equal(sends, 4);
  assert.equal(out.outcomes[0].result.providerRejectedCount, 3);
  assert.equal(out.outcomes[0].result.unknownUsageCount, 0);
  assert.equal(out.budget.unknownUsageUsd, 0);
  assert.equal(out.budget.reservedUsd, 0);
  // Rejected sends still count toward the absolute call cap.
  assert.equal(out.budget.attemptedCallCount, 4);
});

test('Q2: an untyped 429 stays unknown at full reservation and can exhaust optional recovery', { concurrency: false }, async t => {
  let sends = 0;
  const out = await optionalRecoveryCall(0.15, async () => (++sends <= 3
    ? jsonResponse(429, { error: { message: 'Too many requests' } }, { 'retry-after': '0' })
    : jsonResponse(200, COMPLETED)), t, { calls: 2 });
  assert.equal(out.outcomes[0].ok, false);
  assert.equal(out.outcomes[0].error.code, 'RECOVERY_BUDGET_EXHAUSTED');
  assert.equal(out.outcomes[1].ok, false);
  assert.ok(out.budget.unknownUsageUsd > 0.1);
  assert.equal(out.budget.spentUsd, 0);
});

for (const status of [500, 502, 503, 504]) {
  test(`Q2: a ${status} with a parsed error body is never assumed unbilled`, { concurrency: false }, async t => {
    let sends = 0;
    withFetch(t, async () => { sends += 1; return jsonResponse(status, { error: { message: 'upstream', type: 'server_error', code: 'server_error' } }, { 'retry-after': '0' }); });
    const budget = createRecoveryBudget(10, { jobDeadlineMs: Date.now() + 3600000 });
    await assert.rejects(callLedger.run(async () => {
      callLedger.setRecoveryBudget(budget);
      await callLedger.withPolicy({ stage: 'style_recovery', optional: true }, () => call());
    }), error => {
      assert.equal(error.status, status);
      assert.equal(error.providerRejectedCount, 0);
      assert.equal(error.unknownUsageCount, sends);
      return true;
    });
    assert.equal(sends, 3);
    assert.ok(budget.snapshot().unknownUsageUsd > 0);
  });
}

test('Q2: a 400 request rejection is zero-settled and not retried', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => { sends += 1; return jsonResponse(400, { error: { message: 'Invalid schema', type: 'invalid_request_error', code: null } }); });
  const budget = createRecoveryBudget(0.02, { jobDeadlineMs: Date.now() + 3600000 });
  await assert.rejects(callLedger.run(async () => {
    callLedger.setRecoveryBudget(budget);
    await callLedger.withPolicy({ stage: 'style_recovery', optional: true }, () => call());
  }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.providerRejectedCount, 1);
    assert.equal(error.unknownUsageCount, 0);
    assert.equal(error.unknownEstimatedUsd, 0);
    assert.equal(error.callLedger.unknownUsageCount, 0);
    assert.equal(error.callLedger.modelCost.unknownReservedUsd, 0);
    return true;
  });
  assert.equal(sends, 1);
  assert.equal(budget.snapshot().unknownUsageUsd, 0);
});

test('Q2: a typed insufficient-quota 429 is zero-settled, not retried, and keeps the quota code', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => { sends += 1; return jsonResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }); });
  await assert.rejects(call(), error => {
    assert.equal(error.code, 'OPENAI_QUOTA_EXHAUSTED');
    assert.equal(error.providerRejectedCount, 1);
    assert.equal(error.unknownUsageCount, 0);
    return true;
  });
  assert.equal(sends, 1);
});

test('Q2: an error envelope that also carries other fields, or an unreadable error body, stays unknown', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => {
    sends += 1;
    if (sends === 1) return jsonResponse(429, { error: { type: 'requests', code: 'rate_limit_exceeded' }, output: [] }, { 'retry-after': '0' });
    if (sends === 2) return new Response('<html>busy</html>', { status: 429, headers: { 'retry-after': '0' } });
    return jsonResponse(200, COMPLETED);
  });
  const result = await call();
  assert.equal(sends, 3);
  assert.equal(result.providerRejectedCount, 0);
  assert.equal(result.unknownUsageCount, 2);
});

test('Q2: timeouts stay unknown and the mandatory audit exemption still bypasses an exhausted optional budget', { concurrency: false }, async t => {
  let sends = 0;
  withFetch(t, async () => { sends += 1; return jsonResponse(200, COMPLETED); });
  const budget = createRecoveryBudget(0.000001, { jobDeadlineMs: Date.now() + 3600000 });
  const result = await callLedger.run(async () => {
    callLedger.setRecoveryBudget(budget);
    return callLedger.withPolicy({ stage: 'final_semantic_revalidation', optional: false }, () =>
      call({ meta: { task: 'judge', phase: 'semantic' } }));
  });
  assert.equal(result.json.value, 'ok');
  assert.equal(sends, 1);

  let timeoutSends = 0;
  global.fetch = async () => { timeoutSends += 1; throw Object.assign(new Error('provider timed out'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(call({ meta: { task: 'judge', phase: 'semantic' } }), error => {
    assert.equal(error.providerRejectedCount, 0);
    assert.equal(error.unknownUsageCount, 1);
    return true;
  });
  assert.equal(timeoutSends, 1);
});
