'use strict';
const test = require('node:test'), assert = require('node:assert/strict');

test('post-assist conflicts get at most one review within the same deadline; unsupported uplift is rejected', async t => {
  const client = require('../engine-gpt-prod/openaiClient'), assist = require('../lib/detectStatisticalAssist');
  const original = client.completeJson, apply = assist.applyAssist;
  let responses = [], calls = [];
  client.completeJson = async options => {
    calls.push(options); const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'must not issue a third model call');
    return { json: next, model: options.model, usage: {} };
  };
  delete require.cache[require.resolve('../engine-gpt-prod')];
  const engine = require('../engine-gpt-prod'); client.completeJson = original;
  assist.applyAssist = out => ({ ...out, probability: 54 });
  t.after(() => { assist.applyAssist = apply; client.completeJson = original; });
  const text = '도서관에서 필요한 자료를 찾아 읽었다. 책의 앞부분에 표시된 참고 사항을 확인했다. 나머지 내용은 따로 기록해 다음 모임에서 이야기하기로 했다.';
  const config = { models: { detect: 'test-primary', detectEscalation: 'test-review' }, reasoning: { detect: 'low', escalation: 'low' } };
  const primary = { probability: 18, confidence: 'high', signals: [] };
  responses = [primary, { ...primary, probability: 16 }];
  const out = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(calls.length, 2); assert.equal(responses.length, 0);
  assert.equal(calls[0].deadlineMs, calls[1].deadlineMs);
  assert.equal(out.detectDiagnostics.recheckReason, 'post_assist_conflict');
  assert.equal(out.detectDiagnostics.statisticalScore, 54); assert.equal(out.probability, 16);
  assert.equal(out.detectDiagnostics.statisticalAssistRejected, true);
  assert.equal(out.detectDiagnostics.finalCandidateConsistency.status, 'consistent');
  assert.equal(out.statisticalSupport, undefined);
  responses = [primary, Object.assign(new Error('synthetic timeout'), { code: 'OPENAI_TIMEOUT' })]; calls = [];
  const failed = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(calls.length, 2); assert.equal(failed.probability, 18);
  assert.equal(failed.detectDiagnostics.recheckFailed, true);
  assert.equal(failed.detectDiagnostics.finalCandidateConsistency.status, 'consistent');
});
