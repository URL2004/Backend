'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
// Each node:test file runs in its own process. All provider, billing, history
// and metrics operations below are local stubs; HTTP stays on loopback.
process.env.DEDUP_WINDOW_MS = '0';
delete process.env.DEV_NO_AUTH;
const billing = require('../lib/usageBilling');
const calibration = require('../lib/detectCalibration');
const runtime = require('../lib/gptRuntimeConfig');
const gpt = require('../routes/analyze-gpt');
const history = require('../lib/historyService');
const stability = require('../lib/detectResultStability');
const localGetOrCompute = stability.getOrCompute;
const cacheInputs = [];
stability.getOrCompute = (input, compute) => { cacheInputs.push(input); return localGetOrCompute(input, compute, { firestore: null, hmacSecret: '' }); };
const metrics = require('../lib/publicMetrics');
let calls = [], charges = 0, saved = 0, calibrationInputs = [], calibrationFailure = false;
billing.precheckCredits = async () => ({ uid: 'detect-contract-test', plan: 'credit' });
billing.commitCreditDeduct = async () => { charges += 1; };
billing.retryAsync = async operation => operation();
runtime.getRuntimeConfig = async () => ({ activeProvider: 'gpt', models: { detect: 'test', detectEscalation: 'test-next' }, reasoning: { detect: 'low', escalation: 'high' } });
runtime.isGptActive = () => true;
gpt.runDetect = async (text, lang, options) => {
  calls.push({ text, lang, referenceContext: options.referenceContext });
  return { probability: 50, summary: '관찰 결과', detail: '본문의 문체 관찰 결과', confidence: 'high', signals: [], signalEvidence: [],
    gptMeta: { engine: gpt.DETECT_VERSION, detectPromptVersion: gpt.DETECT_PROMPT_VERSION, usage: { totalTokens: 7 } } };
};
calibration.applyHistoryCalibration = async ({ probability }) => {
  calibrationInputs.push(probability);
  if (calibrationFailure) throw new Error('history lookup failed');
  const score = calibrationInputs.length === 1 ? 42 : 40;
  return { probability: score, rawProbability: probability, applied: true, meta: { applied: true },
    comparison: { version: 'humanize-comparison-v1', basis: 'history_adjusted_style', sourceProbability: 45, rawProbability: probability,
      probability: score, rawDelta: probability - 45, adjustedDelta: score - 45, adjustment: score - probability, calibrationApplied: true, match: 'exact_normalized', status: 'improved' } };
};
history.saveAnalyzeHistory = async () => { saved += 1; };
metrics.trackDeliveredMetric = () => {};
const router = require('../routes/analyze');

test('analyze caches only raw detector output, scopes context/language, and fails calibration before charging', async t => {
  const previousSalt = process.env.OPENAI_SAFETY_SALT;
  process.env.OPENAI_SAFETY_SALT = 'synthetic-analyze-comparison-proof-key-long-enough';
  t.after(() => { if (previousSalt === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = previousSalt; });
  stability.resetForTests();
  const app = express(); app.use(express.json()); app.use(router);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const text = '지역 도서관에서 안내문을 확인했다. 접수 기간과 준비물을 따로 적었다. 필요한 서류를 준비한 뒤 신청 절차를 진행했다. 확인되지 않은 사항은 담당자에게 다시 문의했다.';
  let sequence = 0;
  const request = async extra => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mode: 'detect', requestId: 'detect-contract-' + (++sequence), ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  const first = await request({}); const second = await request({});
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(cacheInputs[0].payloadFingerprint, stability.payloadFingerprint({ text, lang: 'ko' }));
  assert.equal(first.body.result.probability, 42); assert.equal(second.body.result.probability, 40);
  assert.deepEqual(calibrationInputs, [50, 50], 'adjusted scores must never enter the raw cache');
  assert.equal(calls.length, 1); assert.equal(second.body.result.gptMeta.detectCacheHit, true);
  assert.equal(second.body.result.historyComparison.rawProbability, 50);
  assert.equal(second.body.result.historyComparison.adjustment, -10);
  for (const response of [first, second]) {
    const backup = { ...response.body.result, inputText: text };
    assert.deepEqual(require('../lib/detectHistoryComparison').verifiedBackupHistoryComparison('detect-contract-test', backup), response.body.result.historyComparison);
  }
  await request({ prevContext: '이전 문맥 A이다.' }); await request({ prevContext: '이전 문맥 A이다.' });
  await request({ prevContext: '이전 문맥 B이다.' }); await request({ lang: 'en' });
  assert.equal(calls.length, 4, 'different context/language has a separate raw binding');
  assert(calls.every(call => call.text === text));
  assert.equal(calls[1].referenceContext, '이전 문맥 A이다.');
  const originalSource = text + ' 참고: https://example.test/reference?utm_source=chatgpt.com';
  const normalizedResponse = await request({ text: originalSource });
  assert.equal(normalizedResponse.status, 200);
  assert.notEqual(calls.at(-1).text, originalSource, 'fixture exercises the legacy URL input normalization');
  assert.deepEqual(require('../lib/detectHistoryComparison').verifiedBackupHistoryComparison('detect-contract-test', {
    ...normalizedResponse.body.result, inputText: originalSource
  }), normalizedResponse.body.result.historyComparison, 'backup proof binds the browser request source');
  const chargesBefore = charges, savedBefore = saved;
  calibrationFailure = true;
  const failed = await request({});
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'DETECT_CALIBRATION_UNAVAILABLE');
  assert.equal(failed.body.charged, 0); assert.equal(charges, chargesBefore); assert.equal(saved, savedBefore);
});
