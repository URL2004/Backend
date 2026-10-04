'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../engine-gpt-prod/openaiClient');
const failure = require('../engine-gpt-prod/modelFailure');
const ledger = require('../engine-gpt-prod/callLedger');
const cost = require('../engine-gpt-prod/modelCostSummary');
const operator = require('../engine-gpt-prod/semanticOperatorReview');
const obligations = require('../engine-gpt-prod/semanticObligations');
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const completed = value => new Response(JSON.stringify({ status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
{ headers: { 'content-type': 'application/json' } });
function mockFetch(t, fn) {
  const oldFetch = global.fetch, oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key'; global.fetch = fn;
  t.after(() => { global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
}

test('GPT-6 caches the stable developer prefix, keeping dynamic instructions and user data outside', async t => {
  const bodies = [];
  mockFetch(t, async (_url, request) => { bodies.push(JSON.parse(request.body)); return completed({ value: 'ok' }); });
  for (const value of ['first private document', 'second private document']) {
    await client.completeJson({ model: 'gpt-6.1-sol', system: 'stable instructions\nconditional rule',
      cacheableSystem: 'stable instructions', user: value, schema, reasoningEffort: 'high' });
  }
  assert.deepEqual(bodies[0].input[0], bodies[1].input[0]);
  assert.deepEqual(bodies[0].prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assert.equal(Object.hasOwn(bodies[0], 'instructions'), false);
  for (const body of bodies) {
    assert.equal(body.input[0].role, 'developer');
    assert.equal(body.input[0].content[0].text, 'stable instructions');
    assert.deepEqual(body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    assert.deepEqual(body.input[1], { role: 'developer', content: '\nconditional rule' });
    assert.equal(body.input[2].role, 'user');
    assert.equal(body.reasoning.effort, 'high');
    assert.equal(body.text.format.strict, true);
  }
  assert.equal(bodies[0].input[2].content, 'first private document');
  assert.equal(bodies[1].input[2].content, 'second private document');
});

test('schema retry preserves the cached prefix and adds trusted instructions outside it', async t => {
  const bodies = [];
  mockFetch(t, async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return completed(bodies.length === 1 ? { wrong: true } : { value: 'ok' });
  });
  const result = await client.completeJson({ model: 'gpt-6-luna', system: 'stable', user: 'request', schema });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].input[0], bodies[0].input[0]);
  assert.equal(bodies[1].input[1].role, 'developer');
  assert.match(bodies[1].input[1].content, /JSON Schema/u);
  assert.equal(bodies[1].input.at(-1).content, 'request');
  assert.equal(result.usage.totalTokens, 30);
});

test('disabled caching creates no breakpoints and older models retain their wire contract', async t => {
  const bodies = [];
  mockFetch(t, async (_url, request) => { bodies.push(JSON.parse(request.body)); return completed({ value: 'ok' }); });
  for (const model of ['gpt-6-sol', 'gpt-5.6-luna'])
    await client.completeJson({ model, system: 'stable', user: 'request', schema, config: { cache: { enabled: false } } });
  assert.equal(bodies[0].prompt_cache_options.mode, 'explicit');
  assert.doesNotMatch(JSON.stringify(bodies[0]), /prompt_cache_breakpoint/);
  assert.equal(bodies[1].instructions, 'stable');
  assert.equal(bodies[1].input, 'request');
});

test('new no-credit message stops at one physical attempt and never becomes rate-limited', async t => {
  let calls = 0;
  mockFetch(t, async () => { calls++; return new Response(JSON.stringify({ error: {
    message: 'You have no credits remaining. Please add credits to continue.'
  } }), { status: 429, headers: { 'retry-after': '0' } }); });
  await assert.rejects(client.completeJson({ model: 'gpt-6-luna', system: 'stable', user: 'request', schema }), error => {
    assert.equal(error.code, 'OPENAI_QUOTA_EXHAUSTED');
    assert.equal(error.httpAttemptCount, 1);
    assert.equal(error.retryCounts.rateLimit, 0);
    assert.equal(failure.classifyModelFailure(error), 'openai_quota_exhausted');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(failure.classifyModelFailure({ status: 429, message: 'You have no credits remaining' }), 'openai_quota_exhausted');
  assert.equal(failure.classifyModelFailure({ status: 429, message: 'Rate limit reached; try again later' }), 'openai_rate_limited');
});

test('different documents share review schemas; the server still rejects invented extra IDs', () => {
  assert.deepEqual(operator.schema(schema, [{ id: 'a' }]), operator.schema(schema, [{ id: 'b' }, { id: 'c' }]));
  assert.deepEqual(obligations.reviewSchema(schema, [{ id: 'a' }]), obligations.reviewSchema(schema, [{ id: 'b' }, { id: 'c' }]));
  const source = '관측 결과를 보고 곧바로 원인을 확신하지는 않았다.';
  const candidate = '관측 결과를 보고 원인을 확신하지는 않았다.';
  const targets = operator.targets(source, candidate);
  const valid = { ...targets[0], status: 'preserved', detail: '합성 검토는 대응 구절의 한정 범위를 명시적으로 확인했다.' };
  assert.equal(operator.assess(targets, [valid], [], source, candidate).pending.length, 0);
  assert.equal(operator.assess(targets, [valid, { ...valid, id: 'invented' }], [], source, candidate).pending.length, 1);
  const finding = { sourceSpan: source, candidateSpan: '이전의 서로 다른 구절이다.' };
  const os = [{ id: 'known', finding }];
  const review = { id: 'known', status: 'resolved', sourceSpan: source, candidateSpan: candidate,
    detail: '현재 대응 문장의 관계를 명시적으로 검토했다.' };
  assert.equal(obligations.assessReviews(os, [review], source, candidate).pending.length, 0);
  assert.equal(obligations.assessReviews(os, [review, { ...review, id: 'invented' }], source, candidate).pending.length, 1);
});

test('operator instructions select complete rule families and retain the whole-document review rule', () => {
  const base = operator.instructionsFor([{ codes: ['temporal_limit_candidate'] }]);
  assert.match(base, /나머지 문서도 검수/u);
  assert.doesNotMatch(base, /source_suffix_replay_candidate|alias_owner_binding_candidate/);
  const selected = operator.instructionsFor([{ codes: ['alias_owner_binding_candidate', 'source_suffix_replay_candidate'] }]);
  assert.match(selected, /alias_owner_binding_candidate/);
  assert.match(selected, /source_suffix_replay_candidate/);
  assert.ok(base.length < operator.instruction.length);
});

test('whole-job cost includes mandatory audits, failed paid calls and separate unknown reservations', async () => {
  let summary;
  await ledger.run(async () => {
    await ledger.withPolicy({ optional: false, stage: 'semantic_document' }, () =>
      ledger.track({ model: 'test', meta: { task: 'judge' } }, async () => ({ usage: { estimatedUsd: .02 }, httpAttemptCount: 1 })));
    await ledger.withPolicy({ optional: false, stage: 'final_semantic_revalidation' }, () =>
      assert.rejects(ledger.track({ model: 'test', meta: { task: 'judge' } }, async () => {
        throw Object.assign(new Error('synthetic failure'), { usage: { estimatedUsd: .03 }, httpAttemptCount: 2,
          unknownUsageCount: 1, unknownEstimatedUsd: .04 });
      })));
    await ledger.withPolicy({ optional: true, stage: 'section_depth_recovery' }, () =>
      ledger.track({ model: 'test', meta: { task: 'repair' } }, async () => ({ usage: { estimatedUsd: .01 }, httpAttemptCount: 1 })));
  }, (_, value) => { summary = value; });
  assert.equal(summary.modelCost.knownUsd, .06);
  assert.equal(summary.modelCost.mandatoryAuditUsd, .05);
  assert.equal(summary.modelCost.otherUsd, .01);
  assert.equal(summary.modelCost.unknownReservedUsd, .04);
  assert.equal(summary.modelCost.stages.find(r => r.stage === 'final_semantic_revalidation').httpAttempts, 2);
  assert.equal(summary.failedEstimatedUsd, .03);
  const persisted = cost.sanitize({ ...summary.modelCost, privateText: 'secret', stages: [
    ...summary.modelCost.stages, { stage: 'bad private text', knownUsd: Infinity, calls: -1, privateText: 'secret' }] });
  assert.doesNotMatch(JSON.stringify(persisted), /secret|bad private text|Infinity/);
  assert.equal(persisted.stages.at(-1).stage, 'unknown');
  assert.equal(persisted.knownUsd, .06);
  const history = require('../lib/historyService');
  assert.deepEqual(history.compactHistoryEngineMeta({ modelCost: persisted }).modelCost, persisted);
  assert.equal(Object.hasOwn(history.compactHistoryEngineMeta({}), 'modelCost'), false);
});

test('short-chunk batch exhaustion never fans out into individual retries', async () => {
  const { createShortChunkBatch } = require('../engine-gpt-prod/shortChunkBatch');
  let calls = 0;
  const batch = createShortChunkBatch(async () => {
    calls++; throw Object.assign(new Error('You have no credits remaining'), { status: 429,
      code: 'OPENAI_QUOTA_EXHAUSTED', usage: { estimatedUsd: .012, inputTokens: 99 } });
  }, { enabled: true });
  const outcomes = await Promise.allSettled([0, 1, 2].map(chunkIndex => batch.complete({
    system: 'stable', user: 'synthetic', model: 'test', schema, maxOutputTokens: 100,
    meta: { phase: 'primary', chunkIndex }
  }, 30)));
  assert.equal(calls, 1);
  assert.equal(batch.metrics.individualRecoveryCount, 0);
  assert.ok(outcomes.every(row => row.status === 'rejected' && row.reason.code === 'OPENAI_QUOTA_EXHAUSTED'));
  assert.equal(outcomes.reduce((sum, row) => sum + row.reason.usage.inputTokens, 0), 99);
  assert.equal(outcomes.reduce((sum, row) => sum + row.reason.usage.estimatedUsd, 0), .012);
});

test('a missing batch result retains its allocated cost when recovered individually', async () => {
  const { createShortChunkBatch } = require('../engine-gpt-prod/shortChunkBatch');
  let calls = 0;
  const batch = createShortChunkBatch(async options => {
    calls++;
    return options.schemaName === 'gpt_prod_humanize_chunk_batch'
      ? { json: { items: [{ id: '1', result: { value: 'second' } }] }, usage: { estimatedUsd: .010001, inputTokens: 11 } }
      : { json: { value: 'first' }, usage: { estimatedUsd: .004, inputTokens: 7 } };
  }, { enabled: true });
  const rows = await Promise.all([0, 1].map(chunkIndex => batch.complete({ system: 'stable', user: 'synthetic',
    model: 'test', schema, maxOutputTokens: 100, meta: { phase: 'primary', chunkIndex } }, 30)));
  assert.equal(calls, 2);
  assert.equal(rows[0].usage.estimatedUsd, .009001);
  assert.equal(rows[1].usage.estimatedUsd, .005);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.inputTokens, 0), 18);
});

test('legacy Sol estimates use its actual price instead of Terra pricing', () => {
  const { priceFor, estimateUsd } = require('../engine-gpt-prod/usageCost');
  assert.deepEqual(priceFor('gpt-5.6-sol'), { input: 4, cachedInput: .4, cacheWrite: 5, output: 20 });
  assert.equal(estimateUsd('gpt-5.6-sol', { inputTokens: 1000, outputTokens: 1000 }), .024);
});
