'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  completeJson,
  extractOutputText,
  safetyIdentifierForUid,
  validateStructuredOutput
} = require('../engine-gpt-prod/openaiClient');

const SIMPLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { value: { type: 'string' } },
  required: ['value']
};

function responseJson(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function completed(value) {
  return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  };
}

test('refusal content는 일반 출력으로 파싱하지 않는다', () => {
  assert.throws(() => extractOutputText({
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: '요청을 처리할 수 없습니다.' }] }]
  }), error => error.code === 'OPENAI_REFUSAL');
});

test('HMAC safety_identifier는 결정론적이고 원본 UID를 포함하지 않는다', () => {
  const first = safetyIdentifierForUid('user-secret-id', 'unit-test-salt');
  const second = safetyIdentifierForUid('user-secret-id', 'unit-test-salt');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first.includes('user-secret-id'), false);
});

test('structured output 계약은 누락·추가 필드를 거부한다', () => {
  assert.equal(validateStructuredOutput({ value: 'ok' }, SIMPLE_SCHEMA), true);
  assert.throws(() => validateStructuredOutput({}, SIMPLE_SCHEMA), error => error.code === 'OPENAI_SCHEMA_VALIDATION');
  assert.throws(() => validateStructuredOutput({ value: 'ok', extra: true }, SIMPLE_SCHEMA), error => error.code === 'OPENAI_SCHEMA_VALIDATION');
});

test('429는 Retry-After를 우선해 재시도하고 웹 검색 비용을 usage에 포함한다', { concurrency: false }, async t => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return responseJson({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' });
    const body = completed({ value: 'ok' });
    body.output.push({ type: 'web_search_call', id: 'search_1' });
    return responseJson(body);
  };
  t.after(() => { global.fetch = originalFetch; process.env.OPENAI_API_KEY = originalKey; });
  const result = await completeJson({
    system: 'test', user: 'test', schema: SIMPLE_SCHEMA, schemaName: 'test_schema',
    model: 'gpt-5.4-mini', reasoningEffort: 'low', maxOutputTokens: 100
  });
  assert.equal(calls, 2);
  assert.equal(result.json.value, 'ok');
  assert.equal(result.usage.webSearchRequests, 1);
  assert.ok(result.usage.estimatedUsd >= 0.01);
});

test('malformed JSON schema 응답은 계약 오류로 실패한다', { concurrency: false }, async t => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => responseJson(completed({ wrong: 'field' }));
  t.after(() => { global.fetch = originalFetch; process.env.OPENAI_API_KEY = originalKey; });
  await assert.rejects(() => completeJson({
    system: 'test', user: 'test', schema: SIMPLE_SCHEMA, schemaName: 'test_schema', model: 'gpt-5.4-mini'
  }), error => error.code === 'OPENAI_SCHEMA_VALIDATION');
});

test('max_output_tokens로 끝난 구조화 응답은 문장 절단으로 차단한다', { concurrency: false }, async t => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => responseJson({
    ...completed({ value: '겉보기에는 완성된 JSON' }),
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' }
  });
  t.after(() => { global.fetch = originalFetch; process.env.OPENAI_API_KEY = originalKey; });
  await assert.rejects(() => completeJson({
    system: 'test', user: 'test', schema: SIMPLE_SCHEMA, schemaName: 'test_schema', model: 'gpt-5.4-mini'
  }), error => error.code === 'OPENAI_TRUNCATED_OUTPUT');
});
