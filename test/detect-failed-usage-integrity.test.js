'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../engine-gpt-prod/openaiClient');
const original = client.completeJson;
let steps = [];
client.completeJson = async options => {
  const step = steps.shift();
  assert.ok(step, 'unexpected additional call');
  if (step.error) throw Object.assign(new Error('mock billed schema failure'), { code: 'OPENAI_SCHEMA_INVALID', usage: step.usage });
  return { model: options.model, json: step.json, usage: step.usage };
};
const engine = require('../engine-gpt-prod');
const config = { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } };
const text = '지역 도서관 안내문을 읽었다. 준비물 설명의 위치를 확인했다. 신청 방법도 살펴보았다. 안내에 따라 서류를 작성했다.';
const usage = estimatedUsd => ({ inputTokens: 20, outputTokens: 10, totalTokens: 30, estimatedUsd });
test('detect includes billed failure in both primary and escalation branches', async t => {
  t.after(() => { client.completeJson = original; });
  for (const plan of [
    [{ error: true, usage: usage(.03) }, { json: { probability: 12, confidence: 'high', signals: [] }, usage: usage(.01) }],
    [{ json: { probability: 65, confidence: 'high', signals: [{ category: 'formulaic_transition', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }] }, usage: usage(.01) }, { error: true, usage: usage(.03) }]
  ]) {
    steps = plan.slice();
    const out = await engine.detect({ text, config, allowLocalFallback: false });
    assert.equal(steps.length, 0);
    assert.equal(out.gptMeta.usage.estimatedUsd, .04);
  }
});
