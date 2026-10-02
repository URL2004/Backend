'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../engine-gpt-prod/openaiClient');
const { DETECT_SCHEMA } = require('../engine-gpt-prod/schemas');
const base = probability => ({ probability, confidence: 'high', signals: [] });
function install(t, responses) {
  const oldFetch = global.fetch, oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    assert(responses.length, 'no added HTTP calls');
    calls++;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(responses.shift()) }] }],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey; });
  return () => calls;
}
const options = { system: 'synthetic', user: 'synthetic', model: 'gpt-6-sol',
  schema: DETECT_SCHEMA, schemaName: 'gpt_prod_detect_result' };

test('real schema retry retains invalid and valid numeric score attempts without changing cost', async t => {
  const calls = install(t, [base(.43), base(12)]);
  const result = await client.completeJson(options);
  assert.equal(calls(), 2);
  assert.equal(result.usage.totalTokens, 40);
  assert.equal(result.httpAttemptCount, 2);
  assert.equal(result.retryCounts.schema, 1);
  assert.deepEqual(result.detectScoreAttempts, [
    { httpAttempt: 1, providerScore: .43, modelScore: null, scoreContractReason: 'non_integer' },
    { httpAttempt: 2, providerScore: 12, modelScore: 12, scoreContractReason: null }
  ]);
});

test('failed detector schema attempts retain numeric contracts and all billed usage', async t => {
  const calls = install(t, [base(.43), base(.57)]);
  await assert.rejects(client.completeJson(options), error => {
    assert.equal(error.code, 'OPENAI_SCHEMA_VALIDATION');
    assert.equal(error.usage.totalTokens, 40);
    assert.equal(error.httpAttemptCount, 2);
    assert.equal(error.detectScoreAttempts.length, 2);
    assert.deepEqual(error.detectScoreAttempts.map(a => a.providerScore), [.43, .57]);
    assert(error.detectScoreAttempts.every(a => a.modelScore === null && a.scoreContractReason === 'non_integer'));
    return true;
  });
  assert.equal(calls(), 2);
});

test('detector attempt metadata never copies source, string scores or other fields', async t => {
  install(t, [{ ...base('private-sentinel'), extra: 'private-sentinel' }, base(0)]);
  const result = await client.completeJson(options);
  assert.equal(JSON.stringify(result.detectScoreAttempts).includes('private-sentinel'), false);
  assert.equal(result.detectScoreAttempts[0].providerScore, null);
  assert.equal(result.detectScoreAttempts[0].scoreContractReason, 'not_finite_number');
  assert.equal(result.detectScoreAttempts[1].modelScore, 0);
});

test('non-detector schemas keep their existing response shape', async t => {
  install(t, [base(1)]);
  const result = await client.completeJson({ ...options, schemaName: 'other_numeric_schema' });
  assert.equal(Object.hasOwn(result, 'detectScoreAttempts'), false);
});

test('both failed detector phases retain total ledger usage across four real mocked HTTP responses', async t => {
  const calls = install(t, [base(.43), base(.43), base(.57), base(.57)]);
  const engine = require('../engine-gpt-prod');
  await assert.rejects(engine.detect({ text: 'A synthetic sentence is recorded. Another synthetic sentence follows.',
    config: { models: { detect: 'gpt-6-sol', detectEscalation: 'gpt-6-sol' } }, allowLocalFallback: false }), error => {
    assert.equal(error.code, 'OPENAI_SCHEMA_VALIDATION');
    assert.equal(error.callLedger.usage.totalTokens, 80);
    assert.equal(error.callLedger.modelCallCount, 2);
    assert.equal(error.callLedger.httpAttemptCount, 4);
    assert.equal(error.callLedger.entries.length, 2);
    assert.equal(error.usage.totalTokens, 80, 'error and ledger each expose the total, not two additive totals');
    assert.equal(error.httpAttemptCount, 4);
    assert.equal(error.detectDiagnostics.attempts.length, 2);
    assert.deepEqual(error.detectDiagnostics.attempts.map(a => a.providerAttempts.map(p => p.providerScore)), [[.43, .43], [.57, .57]]);
    assert.equal(error.detectDiagnostics.selectedModelScore, null);
    return true;
  });
  assert.equal(calls(), 4);
});

test('failed primary and successful review keep two logical attempts and three HTTP responses', async t => {
  install(t, [base(.43), base(.43), base(12)]);
  const out = await require('../engine-gpt-prod').detect({ text: 'Synthetic first sentence. Synthetic next sentence.',
    config: { models: { detect: 'gpt-6-sol', detectEscalation: 'gpt-6-sol' } }, allowLocalFallback: false });
  assert.equal(out.probability, 12);
  assert.equal(out.gptMeta.usage.totalTokens, 60);
  assert.equal(out.gptMeta.httpAttemptCount, 3);
  assert.equal(out.detectDiagnostics.attempts.length, 2);
  assert.equal(out.detectDiagnostics.attempts[0].failed, true);
  assert.equal(out.detectDiagnostics.attempts[0].signalsAfter, null, 'unknown grounding is not zero evidence');
  assert.deepEqual(out.detectDiagnostics.attempts[0].providerAttempts.map(p => p.providerScore), [.43, .43]);
  assert.equal(out.detectDiagnostics.attempts[1].providerAttempts[0].providerScore, 12);
  const projected = require('../lib/detectResultStability').cleanResult(out);
  assert.deepEqual(projected.detectDiagnostics, out.detectDiagnostics);
});

test('local fallback keeps failed-phase diagnostics and total usage without selecting a failed score', async t => {
  install(t, [base(.43), base(.43), base(.57), base(.57)]);
  const out = await require('../engine-gpt-prod').detect({ text: 'Synthetic first sentence. Synthetic next sentence.',
    config: { models: { detect: 'gpt-6-sol', detectEscalation: 'gpt-6-sol' } }, allowLocalFallback: true });
  assert.equal(out.gptMeta.fallback, true);
  assert.equal(out.gptMeta.usage.totalTokens, 80);
  assert.equal(out.gptMeta.httpAttemptCount, 4);
  assert.equal(out.detectDiagnostics.attempts.length, 2);
  assert.equal(out.detectDiagnostics.selectedModelScore, null);
});

test('valid primary plus failed review keeps the primary candidate and every paid attempt', async t => {
  install(t, [base(65), base(.43), base(.57)]);
  const out = await require('../engine-gpt-prod').detect({ text: 'Synthetic first sentence. Synthetic next sentence.',
    config: { models: { detect: 'primary-test', detectEscalation: 'review-test' } }, allowLocalFallback: false });
  assert.equal(out.modelProbability, 65);
  assert.equal(out.detectDiagnostics.selectedPhase, 'primary');
  assert.equal(out.detectDiagnostics.recheckFailed, true);
  assert.equal(out.gptMeta.usage.totalTokens, 60);
  assert.equal(out.gptMeta.httpAttemptCount, 3);
  assert.deepEqual(out.detectDiagnostics.attempts[1].providerAttempts.map(p => p.providerScore), [.43, .57]);
});

for (const accept of [true, false]) test(`score and grounded evidence stay on the same selected candidate (${accept})`, async t => {
  const source = '협력은 중요한 가치를 실현하는 기반이다. 소통은 새로운 가치를 창출하는 핵심이다.';
  const first = { probability: 34, confidence: 'high', signals: [{ category: 'generic_abstraction',
    strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }] };
  const reviewed = accept ? base(8) : { ...first, probability: 72,
    signals: first.signals.map(s => ({ ...s, category: 'lexical_template' })) };
  install(t, [first, reviewed]);
  const out = await require('../engine-gpt-prod').detect({ text: source,
    config: { models: { detect: 'primary-test', detectEscalation: 'review-test' } }, allowLocalFallback: false });
  assert.equal(out.probability, accept ? 8 : 34);
  assert.deepEqual(out.signalEvidence.map(s => s.category), accept ? [] : ['generic_abstraction']);
  assert.equal(out.detectDiagnostics.selectedPhase, accept ? 'recheck' : 'primary');
  assert.equal(out.gptMeta.usage.totalTokens, 40);
});

for (const abortAt of [1, 2]) test(`abort in phase ${abortAt} retains preceding paid work without another phase`, async t => {
  const oldFetch = global.fetch, oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const controller = new AbortController(); let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === abortAt) { controller.abort(); return new Promise(() => {}); }
    const json = { probability: 65, confidence: 'high', signals: [] };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  await assert.rejects(require('../engine-gpt-prod').detect({ text: 'Synthetic first sentence. Synthetic next sentence.',
    config: { models: { detect: 'primary-test', detectEscalation: 'review-test' } }, signal: controller.signal, allowLocalFallback: false }), error => {
    assert.equal(error.usage.totalTokens, (abortAt - 1) * 20);
    assert.equal(error.callLedger.usage.totalTokens, error.usage.totalTokens);
    assert.equal(error.detectDiagnostics.attempts.length, abortAt);
    assert.equal(error.detectDiagnostics.attempts.at(-1).failed, true);
    assert.equal(error.httpAttemptCount, abortAt);
    return true;
  });
  assert.equal(calls, abortAt);
});
