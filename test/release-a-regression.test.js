'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const analyze = require('../routes/analyze');
const transform = require('../routes/transform');
const { evaluateHumanizeRuntime } = require('../lib/runtimeCompatibility');

test('/analyze는 감지만 허용하고 휴머나이징 구형 호출에 이동 계약을 반환한다', async t => {
  const app = express();
  app.use(express.json());
  app.use('/', analyze);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '한국어 테스트 문장입니다.', mode: 'blog' })
  });
  const body = await response.json();

  assert.equal(response.status, 410);
  assert.equal(body.code, 'HUMANIZE_MOVED');
  assert.equal(body.route, '/transform');
  assert.deepEqual(body.allowedModes, ['blog', 'polish', 'formal']);

  const form = new FormData();
  form.append('mode', 'detect');
  form.append('pdf', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'test.pdf');
  const pdfResponse = await fetch(`http://127.0.0.1:${address.port}/analyze-pdf`, {
    method: 'POST',
    body: form
  });
  assert.equal(pdfResponse.status, 410);
  assert.match((await pdfResponse.json()).error, /PDF 직접 분석 API는 종료/u);
});

test('transform 완료 과금은 쿠폰과 크레딧을 같은 멱등 job 키로 분기한다', { concurrency: false }, async t => {
  const originals = {
    retryAsync: analyze.retryAsync,
    commitCouponUsage: analyze.commitCouponUsage,
    commitCreditDeduct: analyze.commitCreditDeduct,
    precheckCoupon: analyze.precheckCoupon,
    precheckCredits: analyze.precheckCredits
  };
  t.after(() => Object.assign(analyze, originals));

  analyze.retryAsync = async fn => fn();
  const calls = [];
  analyze.commitCouponUsage = async (...args) => calls.push({ type: 'coupon', args });
  analyze.commitCreditDeduct = async (...args) => calls.push({ type: 'credit', args });

  const couponJob = {
    id: 'coupon-1', uid: 'user-1', mode: 'formal', billingMode: 'coupon',
    billingTier: 'pro', plan: 'subscription:pro', needed: 1, text: '가'.repeat(200)
  };
  const couponCommitted = await transform.commitJobBilling(couponJob, {
    creditAmount: 200, operation: 'restructure', mode: 'formal', textLength: 200
  });
  assert.equal(couponCommitted, true);
  assert.equal(couponJob.deducted, true);
  assert.deepEqual(calls[0], {
    type: 'coupon',
    args: ['user-1', 'pro', 'formal', 200, 'job_coupon-1']
  });

  const creditJob = {
    id: 'credit-1', uid: 'user-2', mode: 'blog', billingMode: 'credit',
    plan: 'free', needed: 14, text: '나'.repeat(650)
  };
  const creditCommitted = await transform.commitJobBilling(creditJob, {
    creditAmount: 14, operation: 'humanize', mode: 'blog', textLength: 650
  });
  assert.equal(creditCommitted, true);
  assert.equal(creditJob.deducted, true);
  assert.deepEqual(calls[1], {
    type: 'credit',
    args: ['user-2', 14, 'humanize', 'job_credit-1', { mode: 'blog', textLength: 650 }]
  });

  analyze.precheckCoupon = async (...args) => {
    calls.push({ type: 'coupon_precheck', args });
    return { uid: 'user-1', tier: '10000', billingMode: 'coupon' };
  };
  analyze.precheckCredits = async (...args) => {
    calls.push({ type: 'credit_precheck', args });
    return { uid: 'user-2', plan: 'free' };
  };
  await transform.precheckExistingJobBilling(couponJob, 'coupon-token', 10, 200);
  await transform.precheckExistingJobBilling(creditJob, 'credit-token', 10, 650);
  assert.equal(couponJob.billingTier, '10000');
  assert.deepEqual(calls[2], { type: 'coupon_precheck', args: ['coupon-token', 200] });
  assert.deepEqual(calls[3], { type: 'credit_precheck', args: ['credit-token', 10] });
});

test('v2 운영 상태는 GPT만 정상으로 판정하고 다른 provider는 배포 실패 상태다', () => {
  assert.deepEqual(evaluateHumanizeRuntime({ humanizeEngineV2: true, activeProvider: 'gpt' }), {
    ok: true,
    providerCompatible: true,
    activeProvider: 'gpt'
  });
  const mismatch = evaluateHumanizeRuntime({ humanizeEngineV2: true, activeProvider: 'claude' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.providerCompatible, false);
  assert.equal(mismatch.code, 'HUMANIZE_V2_PROVIDER_MISMATCH');
});
