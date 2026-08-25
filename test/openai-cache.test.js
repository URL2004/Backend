'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeUsage,
  promptCacheDiagnostics,
  promptCacheKey
} = require('../engine-gpt-prod/openaiClient');
const { addUsage, emptyUsage, priceFor, estimateUsd } = require('../engine-gpt-prod/usageCost');

const CACHE_ENV_KEYS = [
  'OPENAI_PROMPT_CACHE_KEY_PREFIX',
  'OPENAI_PROMPT_CACHE_KEY_INCLUDE_MODE',
  'OPENAI_PROMPT_CACHE_KEY_INCLUDE_PHASE'
];

function withCacheEnv(values, fn) {
  const before = Object.fromEntries(CACHE_ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of CACHE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values || {})) {
      if (value != null) process.env[key] = String(value);
    }
    return fn();
  } finally {
    for (const key of CACHE_ENV_KEYS) {
      if (before[key] == null) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

function cacheMeta(overrides = {}) {
  return {
    model: 'gpt-5.6-luna',
    task: 'humanize',
    mode: 'assignment',
    profile: 'gpt_prod_v1',
    schemaName: 'gpt_prod_humanize_result',
    phase: 'main',
    ...overrides
  };
}

test('prompt cache key reuses the same route across modes by default', () => {
  withCacheEnv({}, () => {
    const assignment = promptCacheKey({}, cacheMeta({ mode: 'assignment' }));
    const blog = promptCacheKey({}, cacheMeta({ mode: 'blog' }));
    assert.equal(assignment, blog);
    assert.ok(assignment.length <= 64);
  });
});

test('prompt cache key can opt back into mode and phase isolation', () => {
  withCacheEnv({
    OPENAI_PROMPT_CACHE_KEY_INCLUDE_MODE: '1',
    OPENAI_PROMPT_CACHE_KEY_INCLUDE_PHASE: 'true'
  }, () => {
    const main = promptCacheKey({}, cacheMeta({ mode: 'assignment', phase: 'main' }));
    const blog = promptCacheKey({}, cacheMeta({ mode: 'blog', phase: 'main' }));
    const repair = promptCacheKey({}, cacheMeta({ mode: 'assignment', phase: 'repair' }));
    assert.notEqual(main, blog);
    assert.notEqual(main, repair);
  });
});

test('prompt cache key keeps distinct prompt families and schemas isolated', () => {
  withCacheEnv({}, () => {
    const base = promptCacheKey({}, cacheMeta());
    const profile = promptCacheKey({}, cacheMeta({ profile: 'gpt_compat' }));
    const schema = promptCacheKey({}, cacheMeta({ schemaName: 'gpt_prod_detect_result' }));
    assert.notEqual(base, profile);
    assert.notEqual(base, schema);
  });
});

test('prompt cache key respects cache disable and sanitizes long prefixes', () => {
  withCacheEnv({
    OPENAI_PROMPT_CACHE_KEY_PREFIX: 'very long cache prefix with spaces and unsafe chars !@#$%^&*() repeated'
  }, () => {
    assert.equal(promptCacheKey({ cache: { enabled: false } }, cacheMeta()), undefined);
    const key = promptCacheKey({}, cacheMeta());
    assert.match(key, /^[\w.:-]+$/);
    assert.ok(key.length <= 64);
  });
});

test('normalizeUsage records cache reads and writes from Responses usage', () => {
  const usage = normalizeUsage({
    input_tokens: 2006,
    output_tokens: 300,
    total_tokens: 2306,
    input_tokens_details: {
      cached_tokens: 1920,
      cache_write_tokens: 0
    },
    output_tokens_details: {
      reasoning_tokens: 120
    }
  }, 'gpt-5.6-luna');

  assert.equal(usage.inputTokens, 2006);
  assert.equal(usage.cachedInputTokens, 1920);
  assert.equal(usage.cacheWriteTokens, 0);
  assert.equal(usage.outputTokens, 300);
  assert.equal(usage.reasoningTokens, 120);
});

test('normalizeUsage supports Chat Completions token field names', () => {
  const usage = normalizeUsage({
    prompt_tokens: 1600,
    completion_tokens: 200,
    total_tokens: 1800,
    prompt_tokens_details: {
      cached_tokens: 1024,
      cache_write_tokens: 128
    }
  }, 'gpt-5.6-luna');

  assert.equal(usage.inputTokens, 1600);
  assert.equal(usage.cachedInputTokens, 1024);
  assert.equal(usage.cacheWriteTokens, 128);
  assert.equal(usage.outputTokens, 200);
});

test('prompt cache diagnostics distinguish reads from sized misses', () => {
  const hit = promptCacheDiagnostics({
    inputTokens: 2048,
    cachedInputTokens: 1024,
    cacheWriteTokens: 0
  }, 'cache-key');
  assert.deepEqual(hit, {
    enabled: true,
    sizeEligible: true,
    read: true,
    sizedMiss: false,
    hitRatio: 0.5,
    cachedInputTokens: 1024,
    cacheWriteTokens: 0,
    uncachedInputTokens: 1024
  });

  const miss = promptCacheDiagnostics({
    inputTokens: 1400,
    cachedInputTokens: 0,
    cacheWriteTokens: 0
  }, 'cache-key');
  assert.equal(miss.sizeEligible, true);
  assert.equal(miss.read, false);
  assert.equal(miss.sizedMiss, true);

  const short = promptCacheDiagnostics({
    inputTokens: 900,
    cachedInputTokens: 0,
    cacheWriteTokens: 0
  }, 'cache-key');
  assert.equal(short.sizeEligible, false);
  assert.equal(short.sizedMiss, false);
});

test('chunk usage aggregation preserves cache write tokens', () => {
  const total = addUsage(emptyUsage(), {
    inputTokens: 2000,
    cachedInputTokens: 1000,
    cacheWriteTokens: 256,
    outputTokens: 300,
    reasoningTokens: 100,
    totalTokens: 2300,
    estimatedUsd: 0.01
  });
  addUsage(total, {
    inputTokens: 1200,
    cachedInputTokens: 0,
    cacheWriteTokens: 128,
    outputTokens: 200,
    reasoningTokens: 50,
    totalTokens: 1400,
    estimatedUsd: 0.005
  });

  assert.equal(total.cacheWriteTokens, 384);
  assert.equal(total.cachedInputTokens, 1000);
  assert.equal(total.inputTokens, 3200);
});

test('GPT-5.6 role prices use the current Luna and Terra API rates', () => {
  assert.deepEqual(priceFor('gpt-5.6-luna'), {
    input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 6
  });
  assert.deepEqual(priceFor('gpt-5.6-terra'), {
    input: 2.5, cachedInput: 0.25, cacheWriteInput: 3.125, output: 15
  });
});

test('GPT-5.6 cache writes use the 1.25x input rate', () => {
  const usd = estimateUsd('gpt-5.6-luna', {
    inputTokens: 1000000,
    cachedInputTokens: 200000,
    cacheWriteTokens: 300000,
    outputTokens: 100000
  });
  assert.equal(usd, 1.495);
});
