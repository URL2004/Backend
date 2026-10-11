'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../lib/gptRuntimeConfig');
const { completeJson } = require('../engine-gpt-prod/openaiClient');
const { priceFor, estimateUsd } = require('../engine-gpt-prod/usageCost');

test('stored Sol roles migrate to 6.1 without changing Luna, efforts or routing policy', async () => {
  const stored = structuredClone(runtime.DEFAULT_CONFIG);
  for (const key of Object.keys(stored.models)) {
    if (stored.models[key] === 'gpt-6.1-sol') stored.models[key] = 'gpt-6-sol';
  }
  stored.models.judgeEscalation = 'gpt-6-sol-2026-09-22';
  stored.reasoning.escalation = 'xhigh';
  stored.cache.keyPrefix = 'preserve-existing-key';
  stored.escalation.longTextChars = 12000;
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => stored }) }) }) };
  const actual = await runtime.getRuntimeConfig({ db, force: true });
  assert.deepEqual(actual.models, runtime.DEFAULT_CONFIG.models);
  // 저장된 강도는 그대로다. 저장 설정에 없는 확인 판정 강도와 짧은 글 규칙만
  // 운영 기본값(medium, 4,000자)을 받는다.
  assert.deepEqual(actual.reasoning, { ...stored.reasoning, judgeEscalation: 'medium', rewriteEscalationShort: 'medium' });
  assert.deepEqual(actual.cache, stored.cache);
  assert.deepEqual(actual.escalation, { ...stored.escalation, shortRewriteChars: 4000 });
  const old = process.env.OPENAI_MODEL_MAIN;
  try {
    process.env.OPENAI_MODEL_MAIN = 'gpt-6-sol';
    assert.equal(runtime.envConfig().models.humanizeEscalation, 'gpt-6.1-sol');
  } finally {
    if (old === undefined) delete process.env.OPENAI_MODEL_MAIN;
    else process.env.OPENAI_MODEL_MAIN = old;
    runtime.clearRuntimeConfigCache();
  }
});

test('6.1 uses its discounted cached input price without changing historical Sol accounting', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-sol-2026-09-29']) {
    assert.deepEqual(priceFor(model), { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 });
    assert.equal(estimateUsd(model, { inputTokens: 1000, cachedInputTokens: 100, cacheWriteTokens: 200, outputTokens: 50 }), 0.00241);
  }
  assert.equal(priceFor('gpt-6-sol').cachedInput, 0.2);
});

test('6.1 Responses requests preserve supported efforts and replace legacy retention with 30m TTL', async t => {
  const oldFetch = global.fetch, oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.match(String(url), /\/responses$/);
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.equal(body.prompt_cache_retention, undefined);
    assert.ok(['low', 'medium', 'high'].includes(body.reasoning.effort));
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  };
  t.after(() => { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  for (const reasoningEffort of ['low', 'medium', 'high']) {
    await completeJson({ model: 'gpt-6.1-sol', reasoningEffort, system: 'test', user: 'test',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      config: { cache: { enabled: true, retention: '24h' } } });
  }
});
