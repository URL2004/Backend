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

test('transform 아카이브는 원문 없이 종료 시각·게이트·v2 관측 축약값을 보존한다', () => {
  const job = {
    id: 'archive-observability-1',
    status: 'blocked',
    stage: '전달 차단',
    createdAt: 100,
    uid: 'user-archive',
    mode: 'blog',
    text: '저장하면 안 되는 원문',
    gates: ['gpt_noop_unchanged', { gate: 'sentence_truncated', detail: '저장 금지 상세' }],
    gateDetail: { raw: '저장 금지' },
    result: {
      outputText: '저장하면 안 되는 결과',
      qualityStatus: 'needs_review',
      qualityWarnings: [{ code: 'paragraph_structure_changed', message: '상세 메시지' }],
      floorReport: { criticals: [{ gate: 'gpt_noop_unchanged', detail: '상세' }], warnings: [] },
      engineMeta: {
        engineVersion: 'gpt-prod-v2.3',
        requestedMode: 'blog',
        effectiveMode: 'blog',
        requestStrength: 'basic',
        documentProfile: 'general',
        profileConfidence: 0.81,
        semanticJudgeRan: true,
        repairCount: 2,
        modelCallCount: 4,
        humanizeCallCount: 2,
        surfaceRetryCallCount: 1,
        fallbackCount: 1,
        finalNoopRecoveryCount: 0,
        finalNoopRecoveryAttempted: true,
        finalNoopRecoveryApplied: false,
        finalNoopRecoveryReason: 'no_safe_surface_change',
        humanizationDepthEnabled: true,
        humanizationDepthApplicable: true,
        humanizationDepthPass: false,
        humanizationRiskLevel: 'high',
        substantiveEditRatio: 0.031,
        substantiveChangedSentenceRatio: 0.2,
        humanizationDepthRetryCount: 1,
        humanizationDepthRetryApplied: false,
        polishSpeakerRestoreCount: 0
      },
      humanizeMeta: {
        estimatedUsd: 0.012345,
        dedupeAudit: { removedBlockCount: 1, removedBlockSentenceCount: 6 },
        layoutRepair: { paragraphs: { policy: 'bounded_source_paragraphs', beforeCount: 14, afterCount: 6 } }
      }
    }
  };

  const first = transform.buildArchiveDocument(job, {}, 1000);
  const later = transform.buildArchiveDocument(job, { expiredAtMs: 9000 }, 9000);
  assert.equal(first.archiveSchemaVersion, 2);
  assert.equal(first.terminalAtMs, 1000);
  assert.equal(later.terminalAtMs, 1000, '후속 archive write가 최초 terminal 시각을 덮으면 안 된다');
  assert.deepEqual(first.gates, ['gpt_noop_unchanged', 'sentence_truncated']);
  assert.deepEqual(first.qualityWarningCodes, ['paragraph_structure_changed']);
  assert.equal(first.engineVersion, 'gpt-prod-v2.3');
  assert.equal(first.documentProfile, 'general');
  assert.equal(first.estimatedUsd, 0.012345);
  assert.equal(first.dedupeRemovedBlockCount, 1);
  assert.equal(first.paragraphCountBeforeRepair, 14);
  assert.equal(first.paragraphCountAfterRepair, 6);
  assert.equal(first.finalNoopRecoveryAttempted, true);
  assert.equal(first.finalNoopRecoveryReason, 'no_safe_surface_change');
  assert.equal(first.humanizationDepthEnabled, true);
  assert.equal(first.humanizationDepthApplicable, true);
  assert.equal(first.humanizationDepthPass, false);
  assert.equal(first.humanizationRiskLevel, 'high');
  assert.equal(first.substantiveEditRatio, 0.031);
  assert.equal(first.humanizationDepthRetryCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'result'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'gateDetail'), false);

  job.status = 'running';
  const reopened = transform.buildArchiveDocument(job, {}, 10000);
  assert.equal(reopened.terminalAtMs, null, '차단 job 재처리 시 이전 terminal 시각을 지워야 한다');
  job.status = 'done';
  const completed = transform.buildArchiveDocument(job, {}, 11000);
  assert.equal(completed.terminalAtMs, 11000);
});
