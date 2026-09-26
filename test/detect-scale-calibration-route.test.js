'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
// Own process per node:test file. Provider, billing, history and metrics are local stubs; HTTP stays on loopback.
process.env.DEDUP_WINDOW_MS = '0';
delete process.env.DEV_NO_AUTH;
delete process.env.DETECT_SCALE_CALIBRATION_ENABLED;
delete process.env.DETECT_SCALE_CALIBRATION_RULES;
const billing = require('../lib/usageBilling');
const calibration = require('../lib/detectCalibration');
const runtime = require('../lib/gptRuntimeConfig');
const gpt = require('../routes/analyze-gpt');
const history = require('../lib/historyService');
const stability = require('../lib/detectResultStability');
const localGetOrCompute = stability.getOrCompute;
stability.getOrCompute = (input, compute) => localGetOrCompute(input, compute, { firestore: null, hmacSecret: '' });
const metrics = require('../lib/publicMetrics');
let modelProbability = 18, saved = [];
billing.precheckCredits = async () => ({ uid: 'scale-route-test', plan: 'credit' });
billing.commitCreditDeduct = async () => {};
billing.retryAsync = async operation => operation();
runtime.getRuntimeConfig = async () => ({ activeProvider: 'gpt', models: { detect: 'test', detectEscalation: 'test-next' }, reasoning: { detect: 'low', escalation: 'high' } });
runtime.isGptActive = () => true;
gpt.runDetect = async () => ({ probability: modelProbability, summary: '관찰 결과', detail: '본문의 문체 관찰 결과', confidence: 'medium', signals: [], signalEvidence: [],
  gptMeta: { engine: gpt.DETECT_VERSION, detectPromptVersion: gpt.DETECT_PROMPT_VERSION, usage: { totalTokens: 7 } } });
calibration.applyHistoryCalibration = async ({ probability }) => ({ probability, rawProbability: probability, applied: false, meta: null });
history.saveAnalyzeHistory = async entry => { saved.push(entry); };
metrics.trackDeliveredMetric = () => {};
const router = require('../routes/analyze');

const shortText = '이 제품은 배송이 빨랐다. 포장은 단단했고 설명서도 들어 있었다. 다만 색이 사진보다 조금 어두웠다. 가격을 생각하면 만족한다.';
const longText = Array.from({ length: 12 }, (_, i) => `${i + 1}번째 문단에서는 자료실 안내문을 검토한 과정을 적었다. 이용자의 의견을 기록하고 안내 순서를 관찰한 뒤 배치를 수정했다.`).join(' ');

test('display-scale calibration applies only when enabled, only inside scope, and keeps the engine score visible', async t => {
  stability.resetForTests();
  const app = express(); app.use(express.json()); app.use(router);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => { server.close(); delete process.env.DETECT_SCALE_CALIBRATION_ENABLED; delete process.env.DETECT_SCALE_CALIBRATION_RULES; });
  let sequence = 0;
  const request = async (text, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mode: 'detect', requestId: 'scale-route-' + (++sequence), ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  assert.ok(shortText.length < 300 && longText.length >= 300);

  // 1) default OFF: engine score is displayed unchanged
  const off = await request(shortText);
  assert.equal(off.status, 200);
  assert.equal(off.body.result.probability, 18);
  assert.equal(off.body.result.scaleCalibration, undefined);

  // 2) ON with the short rule: 18 -> 50, engine score kept as rawProbability, cache still holds the raw result
  process.env.DETECT_SCALE_CALIBRATION_ENABLED = '1';
  process.env.DETECT_SCALE_CALIBRATION_RULES = 'short_review_scale';
  const on = await request(shortText);
  assert.equal(on.status, 200);
  assert.equal(on.body.result.probability, 50);
  assert.equal(on.body.result.rawProbability, 18);
  assert.equal(on.body.result.scaleCalibration.rule, 'short_review_scale');
  assert.equal(on.body.result.scaleCalibration.before, 18);
  assert.equal(on.body.result.scaleCalibration.after, 50);
  assert.equal(on.body.result.riskLevel, 'high', 'narrative follows the displayed band');
  assert.equal(on.body.result.gptMeta.detectCacheHit, true, 'same raw cache entry as the OFF request: the mapping is never cached');
  assert.match(on.body.result.riskLabel, /높은 구간/u);
  assert.equal(saved.at(-1).result.scaleCalibration.rule, 'short_review_scale', 'history keeps the closed meta');

  // 3) ON but out of scope (long text): unchanged
  modelProbability = 40;
  const long = await request(longText);
  assert.equal(long.status, 200);
  assert.equal(long.body.result.probability, 40);
  assert.equal(long.body.result.scaleCalibration, undefined);

  // 4) ON with only the rejected rule id: unchanged even for short text
  process.env.DETECT_SCALE_CALIBRATION_RULES = 'long_prose_boundary_40';
  modelProbability = 18;
  const rejected = await request(shortText, { prevContext: '다른 문맥' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.result.probability, 18);
  assert.equal(rejected.body.result.scaleCalibration, undefined);
});
