'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const analyze = require('../routes/analyze');
const transform = require('../routes/transform');
const usageBilling = require('../lib/usageBilling');
const historyService = require('../lib/historyService');
const { evaluateHumanizeRuntime } = require('../lib/runtimeCompatibility');

test('고급 작업은 보존형 폴백으로 다운그레이드하지 않는다', { concurrency: false }, t => {
  const previous = process.env.TRANSFORM_BLOCK_FALLBACK;
  process.env.TRANSFORM_BLOCK_FALLBACK = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSFORM_BLOCK_FALLBACK;
    else process.env.TRANSFORM_BLOCK_FALLBACK = previous;
  });
  assert.equal(transform.preservationFallbackAllowed('blog'), true);
  assert.equal(transform.preservationFallbackAllowed('formal'), false);
  assert.equal(transform.preservationFallbackAllowed('polish'), false);
});

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

test('/transform은 구조 행만 있는 입력을 작업 생성 전에 422로 안내한다', { concurrency: false }, async t => {
  const previousDevNoAuth = process.env.DEV_NO_AUTH;
  process.env.DEV_NO_AUTH = '1';
  t.after(() => {
    if (previousDevNoAuth === undefined) delete process.env.DEV_NO_AUTH;
    else process.env.DEV_NO_AUTH = previousDevNoAuth;
  });

  const app = express();
  app.use(express.json());
  app.use('/', transform);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const tableOnly = Array.from({ length: 10 }, (_, index) =>
    `항목 ${index + 1}\t측정값 ${100 + index}\t비고 ${String.fromCharCode(65 + index)} 구간의 구조 보존 자료`
  ).join('\n');
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/transform`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: tableOnly, mode: 'formal' })
  });
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.code, 'NO_EDITABLE_CONTENT');
  assert.equal(body.editableChunkCount, 0);
  assert.equal(typeof body.documentProfile, 'string');
});

test('transform 완료 과금은 쿠폰과 크레딧을 같은 멱등 job 키로 분기한다', { concurrency: false }, async t => {
  const originals = {
    retryAsync: usageBilling.retryAsync,
    commitCouponUsage: usageBilling.commitCouponUsage,
    commitCreditDeduct: usageBilling.commitCreditDeduct,
    precheckCoupon: usageBilling.precheckCoupon,
    precheckCredits: usageBilling.precheckCredits
  };
  t.after(() => Object.assign(usageBilling, originals));

  usageBilling.retryAsync = async fn => fn();
  const calls = [];
  usageBilling.commitCouponUsage = async (...args) => calls.push({ type: 'coupon', args });
  usageBilling.commitCreditDeduct = async (...args) => calls.push({ type: 'credit', args });

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

  usageBilling.precheckCoupon = async (...args) => {
    calls.push({ type: 'coupon_precheck', args });
    return { uid: 'user-1', tier: '10000', billingMode: 'coupon' };
  };
  usageBilling.precheckCredits = async (...args) => {
    calls.push({ type: 'credit_precheck', args });
    return { uid: 'user-2', plan: 'free' };
  };
  await transform.precheckExistingJobBilling(couponJob, 'coupon-token', 10, 200);
  await transform.precheckExistingJobBilling(creditJob, 'credit-token', 10, 650);
  assert.equal(couponJob.billingTier, '10000');
  assert.deepEqual(calls[2], { type: 'coupon_precheck', args: ['coupon-token', 200] });
  assert.deepEqual(calls[3], { type: 'credit_precheck', args: ['credit-token', 10] });
});

test('저효과·품질 경고가 있는 완료 결과도 정상 과금한다', { concurrency: false }, async t => {
  const originals = {
    retryAsync: usageBilling.retryAsync,
    commitCreditDeduct: usageBilling.commitCreditDeduct
  };
  t.after(() => Object.assign(usageBilling, originals));

  usageBilling.retryAsync = async fn => fn();
  const calls = [];
  usageBilling.commitCreditDeduct = async (...args) => calls.push(args);
  const job = {
    id: 'quality-warning-charged-1', uid: 'user-quality', mode: 'blog',
    billingMode: 'credit', plan: 'free', needed: 18, text: '다'.repeat(900),
    deducted: false, effectExpectation: 'normal'
  };
  const out = {
    qualityStatus: 'needs_review',
    engineMeta: {
      humanizationDepthApplicable: true,
      humanizationDepthPass: false,
      humanizationMinimumEffectPass: false,
      humanizationNoBenefitDelivered: true
    }
  };

  const disposition = await transform.resolveBillingDisposition(job, out);
  assert.equal(disposition, 'charged');
  assert.equal(job.deducted, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'user-quality', 18, 'humanize', 'job_quality-warning-charged-1',
    { mode: 'blog', textLength: 900 }
  ]);
});

test('단일 운영 엔진은 GPT만 정상으로 판정하고 다른 provider는 배포 실패 상태다', () => {
  assert.deepEqual(evaluateHumanizeRuntime({ activeProvider: 'gpt' }), {
    ok: true,
    providerCompatible: true,
    activeProvider: 'gpt'
  });
  const mismatch = evaluateHumanizeRuntime({ activeProvider: 'claude' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.providerCompatible, false);
  assert.equal(mismatch.code, 'HUMANIZE_PROVIDER_MISMATCH');
});

test('transform 아카이브는 원문 없이 종료 시각·게이트·v2 관측 축약값을 보존한다', () => {
  const job = {
    id: 'archive-observability-1',
    status: 'blocked',
    stage: '전달 차단',
    createdAt: 100,
    startedAt: 200,
    uid: 'user-archive',
    mode: 'blog',
    billingDisposition: 'waived_quality_shortfall',
    effectExpectation: 'normal',
    effectNoticeCode: null,
    sourceFingerprint: '저장하면 안 되는 HMAC 지문',
    text: '저장하면 안 되는 원문',
    gates: ['gpt_noop_unchanged', { gate: 'sentence_truncated', detail: '저장 금지 상세' }],
    gateDetail: { raw: '저장 금지' },
    result: {
      outputText: '저장하면 안 되는 결과',
      qualityStatus: 'needs_review',
      qualityWarnings: [{ code: 'paragraph_structure_changed', message: '상세 메시지' }],
      floorReport: { criticals: [{ gate: 'gpt_noop_unchanged', detail: '상세' }], warnings: [] },
      engineMeta: {
        engineVersion: 'gpt-prod-v2.4.1',
        requestedMode: 'blog',
        effectiveMode: 'blog',
        requestStrength: 'basic',
        documentProfile: 'general',
        profileConfidence: 0.81,
        profileDecisionSource: 'user_override',
        detectedDocumentProfile: 'unknown',
        detectedProfileConfidence: 0.61,
        requestedDocumentProfile: 'general',
        profileOverrideApplied: true,
        semanticJudgeRan: true,
        discourseAuditVersion: 1,
        discoursePass: false,
        discourseWarningCodes: ['scope_expansion', '사용자 원문 조각'],
        discourseSignalCount: 1,
        discourseRepairRan: true,
        repairCount: 2,
        modelCallCount: 4,
        humanizeCallCount: 2,
        surfaceRetryCallCount: 1,
        primaryApprovedModelChunkCount: 2,
        approvedModelChunkCount: 3,
        deferredLabelMicroChunkCount: 28,
        deferredPolishMicroChunkCount: 28,
        fallbackCount: 1,
        finalNoopRecoveryCount: 0,
        finalNoopRecoveryAttempted: true,
        finalNoopRecoveryApplied: false,
        finalNoopRecoveryReason: 'no_safe_surface_change',
        humanizationDepthEnabled: true,
        humanizationDepthApplicable: true,
        humanizationDepthPass: false,
        humanizationOverallDepthPass: false,
        humanizationMinimumEffectPass: false,
        humanizationDepthSoftDelivered: false,
        humanizationNoBenefitDelivered: true,
        humanizationPolicyVersion: 'perceived-v2.1',
        humanizationRiskLevel: 'high',
        humanizationMinimumRatio: 0.13,
        humanizationHardMinimumRatio: 0.052,
        humanizationTargetMinRatio: 0.15,
        humanizationTargetMaxRatio: 0.19,
        humanizationRequiredSentenceRatio: 0.5,
        humanizationHardRequiredSentenceCount: 2,
        humanizationMinimumTargetCoverage: 0.75,
        substantiveEditRatio: 0.031,
        substantiveChangedSentenceRatio: 0.2,
        substantiveCarryoverCount: 8,
        substantiveCarryoverRatio: 0.4,
        substantiveCarryoverEligibleSentenceCount: 20,
        substantiveCarryoverMaximum: 0.3,
        humanizationTargetCoverage: 0.6,
        humanizationTargetChangedCount: 3,
        structuralChangedSentenceCount: 2,
        structuralChangedSentenceRatio: 0.4,
        humanizationRequiredStructuralSentenceCount: 3,
        rhetoricalRemediationTargetCount: 4,
        rhetoricalRemediationAchievedCount: 3,
        rhetoricalRemediationCoverage: 0.75,
        macroDiscourseApplicable: true,
        macroDiscourseScore: 0.3,
        macroDiscoursePass: true,
        macroDiscourseOrderPass: true,
        macroDiscourseSourceParagraphCount: 6,
        macroDiscourseOutputParagraphCount: 5,
        macroDiscourseRecomposedParagraphCount: 2,
        macroDiscourseRepeatedEvaluationReduction: 1,
        macroDiscourseRoleOrderRetention: 0.83,
        macroDiscourseIdeaOrderRetention: 1,
        resumeRepetitionAuditVersion: 1,
        resumeRepetitionApplicable: true,
        resumeRepetitionPass: false,
        resumeRepetitionThemeCount: 3,
        resumeRepetitionSourcePairCount: 9,
        resumeRepetitionResidualPairCount: 7,
        resumeRepetitionRequiredReduction: 3,
        resumeRepetitionAchievedReduction: 2,
        resumeRepetitionCoverage: 0.6667,
        lengthRatio: 1.02,
        humanizationTargetDepthMet: false,
        humanizationEditTargetMet: false,
        humanizationTargetDepthGap: 0.119,
        humanizationDeliveryDepthBand: 'below_minimum',
        humanizationDepthRetryCount: 1,
        humanizationNoEffectRetryAttemptCount: 1,
        humanizationRoleRecoveryAttemptCount: 1,
        humanizationDepthRetryApplied: false,
        humanizationDepthRetryTargetSentenceCount: 3,
        humanizationDepthRetryRejectedCount: 2,
        humanizationDepthRetryRejectionCodes: ['candidate_unchanged', 'safety_audit_failed', '사용자 원문 조각'],
        humanizationDepthStages: [
          {
            stage: 'post_semantic', pass: false, minimumEffectPass: true,
            targetDepthMet: false, score: 0.61, substantiveEditRatio: 0.14,
            changedSentenceRatio: 0.5, targetCoverage: 0.7,
            structuralChangedCount: 3, carryoverRatio: 0.25
          },
          {
            stage: 'final', pass: false, minimumEffectPass: false,
            targetDepthMet: false, score: 0.48, substantiveEditRatio: 0.09,
            changedSentenceRatio: 0.35, targetCoverage: 0.55,
            structuralChangedCount: 2, carryoverRatio: 0.35
          },
          { stage: '사용자 원문 조각', substantiveEditRatio: 1 }
        ],
        sectionRecoveryEnabled: true,
        sectionRecoverySelectedCount: 5,
        sectionRecoveryAttemptCount: 3,
        sectionRecoveryTargetOnlyCount: 2,
        sectionRecoveryAppliedCount: 1,
        sectionRecoveryEscalationCount: 1,
        pipelineFixedPoint: {
          safetyPass: true,
          depthHardMinimumPass: false,
          structurePass: true,
          quotePass: true,
          inlineCodePass: true,
          reasonCodes: ['depth_hard_minimum_not_met']
        },
        recoveryBudgetEnabled: true,
        recoveryBudgetEnforced: true,
        recoveryBudgetLimitUsd: 0.45,
        recoveryBudgetSpentUsd: 0.31,
        recoveryBudgetExhausted: false,
        recoveryBudgetAttemptedCallCount: 4,
        recoveryBudgetSkippedCallCount: 1,
        recoveryBudgetSkippedCodes: ['conservative_sentence_recovery'],
        recoveryBudgetStageUsageUsd: { section_depth_recovery: 0.31 },
        depthTugOfWar: {
          trigger: 'depth_regression', rounds: 2, semanticRepairRounds: 1,
          rejudgeCount: 1, finalSide: 'source', usdSpent: 0.03
        },
        fingerprintAuditVersion: 1,
        fingerprintPass: false,
        fingerprintIssueCodes: ['engine_phrase_fingerprint'],
        fingerprintIntroducedCount: 2,
        fingerprintRepairCount: 1,
        unsupportedSpecificityAuditVersion: 1,
        unsupportedSpecificityPass: false,
        unsupportedSpecificityIssueCount: 1,
        unsupportedSpecificityRestorableCount: 0,
        unsupportedSpecificityResidualCount: 1,
        unsupportedSpecificityRestoreCount: 0,
        unsupportedSpecificityRemovalCount: 0,
        unsupportedSpecificityRestoreRejectedCount: 1,
        unsupportedSpecificityRestoreRejectionCodes: ['candidate_integrity_failed', '사용자 원문 조각'],
        fingerprintShadowPositiveCodes: ['review_together', '사용자 원문 조각'],
        fingerprintShadowPositiveCount: 2,
        endingStyleAuditVersion: 1,
        endingStylePass: false,
        endingStyleIssueCount: 1,
        endingStyleIntroducedOtherCount: 2,
        resumeCoverageAuditVersion: 1,
        resumeCoverageApplicable: true,
        resumeCoveragePass: false,
        resumeClaimCount: 4,
        resumeCoveredClaimCount: 3,
        resumeCoverageRatio: 0.75,
        humanizationPlanSignalSource: 'deterministic_targets_input_risk',
        humanizationDepthReasonCodes: ['substantive_edit_ratio_low', '사용자 원문 조각'],
        humanizationDepthBlockingReasonCodes: ['substantive_effect_too_low'],
        chunkFailureCodes: ['novelty', 'network error with user text'],
        chunkPrimaryFailureCodes: ['novelty'],
        chunkResidualFailureCodes: ['pov'],
        chunkFallbackReasonCodes: ['gpt_primary_and_escalation_failed'],
        polishRetryReason: 'evaluative_padding',
        polishEvaluativePaddingCodes: ['efficiency_label', '사용자 원문 조각'],
        polishDeterministicPaddingRestoreCount: 1,
        polishSpeakerRestoreCount: 0,
        koreanRefinementVersion: 1,
        koreanRefinementPass: false,
        koreanRefinementIssueCodes: ['frequency_quantifier_conflict'],
        koreanDeterministicRepairCount: 1,
        koreanRefinementRetryCount: 1,
        quoteIntegrityAuditVersion: 1,
        quoteIntegrityPass: true,
        quoteCountChanged: false,
        quoteDuplicateReductionBenign: true,
        quoteDuplicateReductionCount: 1,
        quoteMissingUniqueCount: 0,
        quoteContentChangedCount: 0,
        quoteIntegrityRestoreCount: 1,
        finalQuoteIntegrityRestoreCount: 1,
        sourcePreflightVersion: 1,
        sourcePreflightChanged: true,
        sourceArtifactRemovedCount: 2,
        sourcePreflightNoticeCount: 1,
        sourcePreflightIssueCodes: ['source_ui_artifact', '사용자 원문 조각'],
        sourceReviewWarningCodes: ['deep_understanding_collocation'],
        sourceReviewWarningCount: 1,
        lineBoundaryPolicy: 'structural'
      },
      humanizeMeta: {
        estimatedUsd: 0.012345,
        dedupeAudit: {
          removedBlockCount: 1,
          removedBlockSentenceCount: 6,
          finalPass: {
            applied: true,
            rejected: false,
            reasonCodes: [],
            removedBlockCount: 1,
            removedBlockSentenceCount: 5
          }
        },
        layoutRepair: {
          paragraphs: {
            policy: 'bounded_source_paragraphs',
            beforeCount: 14,
            afterCount: 6,
            proseSplitCount: 2,
            visualGapRepairCount: 3,
            explicitParagraphCountBefore: 4,
            explicitParagraphCountAfter: 9,
            readability: {
              overlongCount: 0,
              maxBare: 824,
              maxSentences: 9,
              maxBareLimit: 700,
              maxSentenceLimit: 8
            }
          }
        }
      }
    }
  };

  const first = transform.buildArchiveDocument(job, {}, 1000);
  const later = transform.buildArchiveDocument(job, { expiredAtMs: 9000 }, 9000);
  assert.equal(first.archiveSchemaVersion, 2);
  assert.equal(first.terminalAtMs, 1000);
  assert.equal(first.processingDurationMs, 800);
  assert.equal(first.totalDurationMs, 900);
  assert.equal(later.terminalAtMs, 1000, '후속 archive write가 최초 terminal 시각을 덮으면 안 된다');
  assert.deepEqual(first.gates, ['gpt_noop_unchanged', 'sentence_truncated']);
  assert.deepEqual(first.qualityWarningCodes, ['paragraph_structure_changed']);
  assert.equal(first.engineVersion, 'gpt-prod-v2.4.1');
  assert.equal(first.documentProfile, 'general');
  assert.equal(first.detectedDocumentProfile, 'unknown');
  assert.equal(first.requestedDocumentProfile, 'general');
  assert.equal(first.profileOverrideApplied, true);
  assert.equal(first.discourseAuditVersion, 1);
  assert.equal(first.discoursePass, false);
  assert.deepEqual(first.discourseWarningCodes, ['scope_expansion']);
  assert.equal(first.discourseSignalCount, 1);
  assert.equal(first.discourseRepairRan, true);
  assert.equal(first.estimatedUsd, 0.012345);
  assert.equal(first.dedupeRemovedBlockCount, 1);
  assert.equal(first.finalGeneratedDedupeApplied, true);
  assert.equal(first.finalGeneratedDedupeRejected, false);
  assert.equal(first.finalGeneratedDedupeBlockCount, 1);
  assert.equal(first.finalGeneratedDedupeSentenceCount, 5);
  assert.equal(first.paragraphCountBeforeRepair, 14);
  assert.equal(first.paragraphCountAfterRepair, 6);
  assert.equal(first.lineBoundaryPolicy, 'structural');
  assert.equal(first.deferredLabelMicroChunkCount, 28);
  assert.equal(first.deferredPolishMicroChunkCount, 28);
  assert.equal(first.paragraphOverlongCount, 0);
  assert.equal(first.paragraphMaxBare, 824);
  assert.equal(first.paragraphMaxSentences, 9);
  assert.equal(first.paragraphProseSplitCount, 2);
  assert.equal(first.paragraphVisualGapRepairCount, 3);
  assert.equal(first.explicitParagraphCountBefore, 4);
  assert.equal(first.explicitParagraphCountAfter, 9);
  assert.equal(first.paragraphMaxBareLimit, 700);
  assert.equal(first.paragraphMaxSentenceLimit, 8);
  assert.equal(first.finalNoopRecoveryAttempted, true);
  assert.equal(first.finalNoopRecoveryReason, 'no_safe_surface_change');
  assert.equal(first.humanizationDepthEnabled, true);
  assert.equal(first.humanizationDepthApplicable, true);
  assert.equal(first.humanizationDepthPass, false);
  assert.equal(first.humanizationOverallDepthPass, false);
  assert.equal(first.humanizationMinimumEffectPass, false);
  assert.equal(first.humanizationDepthSoftDelivered, false);
  assert.equal(first.humanizationNoBenefitDelivered, true);
  assert.equal(first.humanizationPolicyVersion, 'perceived-v2.1');
  assert.equal(first.humanizationRiskLevel, 'high');
  assert.equal(first.humanizationMinimumRatio, 0.13);
  assert.equal(first.humanizationHardMinimumRatio, 0.052);
  assert.equal(first.humanizationHardRequiredSentenceCount, 2);
  assert.equal(first.humanizationTargetMinRatio, 0.15);
  assert.equal(first.humanizationTargetMaxRatio, 0.19);
  assert.equal(first.humanizationTargetDepthMet, false);
  assert.equal(first.humanizationEditTargetMet, false);
  assert.equal(first.humanizationTargetDepthGap, 0.119);
  assert.equal(first.humanizationDeliveryDepthBand, 'below_minimum');
  assert.equal(first.substantiveEditRatio, 0.031);
  assert.equal(first.substantiveCarryoverRatio, 0.4);
  assert.equal(first.substantiveCarryoverMaximum, 0.3);
  assert.equal(first.humanizationTargetCoverage, 0.6);
  assert.equal(first.structuralChangedSentenceRatio, 0.4);
  assert.equal(first.rhetoricalRemediationCoverage, 0.75);
  assert.equal(first.macroDiscourseApplicable, true);
  assert.equal(first.macroDiscourseScore, 0.3);
  assert.equal(first.macroDiscoursePass, true);
  assert.equal(first.macroDiscourseOrderPass, true);
  assert.equal(first.macroDiscourseRecomposedParagraphCount, 2);
  assert.equal(first.resumeRepetitionApplicable, true);
  assert.equal(first.resumeRepetitionPass, false);
  assert.equal(first.resumeRepetitionCoverage, 0.6667);
  assert.equal(first.lengthRatio, 1.02);
  assert.equal(first.koreanRefinementPass, false);
  assert.deepEqual(first.koreanRefinementIssueCodes, ['frequency_quantifier_conflict']);
  assert.equal(first.unsupportedSpecificityPass, false);
  assert.equal(first.unsupportedSpecificityIssueCount, 1);
  assert.equal(first.unsupportedSpecificityResidualCount, 1);
  assert.deepEqual(first.unsupportedSpecificityRestoreRejectionCodes, ['candidate_integrity_failed']);
  assert.deepEqual(first.sourceReviewWarningCodes, ['deep_understanding_collocation']);
  assert.equal(first.humanizationDepthRetryCount, 1);
  assert.equal(first.humanizationNoEffectRetryAttemptCount, 1);
  assert.equal(first.humanizationRoleRecoveryAttemptCount, 1);
  assert.equal(first.humanizationDepthRetryTargetSentenceCount, 3);
  assert.equal(first.humanizationDepthRetryRejectedCount, 2);
  assert.deepEqual(first.humanizationDepthRetryRejectionCodes, ['candidate_unchanged', 'safety_audit_failed']);
  assert.equal(first.humanizationDepthStages.length, 2);
  assert.equal(first.postSemanticSubstantiveEditRatio, 0.14);
  assert.equal(first.finalStageSubstantiveEditRatio, 0.09);
  assert.equal(first.postSemanticToFinalSubstantiveEditDelta, -0.05);
  assert.equal(first.depthTugTrigger, 'depth_regression');
  assert.equal(first.depthTugFinalSide, 'source');
  assert.equal(first.depthTugOfWar.trigger, 'depth_regression');
  assert.equal(first.primaryApprovedModelChunkCount, 2);
  assert.equal(first.approvedModelChunkCount, 3);
  assert.equal(first.sectionRecoverySelectedCount, 5);
  assert.equal(first.sectionRecoveryAttemptCount, 3);
  assert.equal(first.sectionRecoveryTargetOnlyCount, 2);
  assert.equal(first.sectionRecoveryAppliedCount, 1);
  assert.equal(first.pipelineFixedPoint.safetyPass, true);
  assert.equal(first.pipelineFixedPoint.depthHardMinimumPass, false);
  assert.deepEqual(first.pipelineFixedPoint.reasonCodes, ['depth_hard_minimum_not_met']);
  assert.equal(first.recoveryBudgetEnabled, true);
  assert.equal(first.recoveryBudgetEnforced, true);
  assert.equal(first.recoveryBudgetLimitUsd, 0.45);
  assert.equal(first.recoveryBudgetSpentUsd, 0.31);
  assert.deepEqual(first.recoveryBudgetSkippedCodes, ['conservative_sentence_recovery']);
  assert.deepEqual(first.recoveryBudgetStageUsageUsd, { section_depth_recovery: 0.31 });
  assert.equal(first.fingerprintPass, false);
  assert.deepEqual(first.fingerprintIssueCodes, ['engine_phrase_fingerprint']);
  assert.deepEqual(first.fingerprintShadowPositiveCodes, ['review_together']);
  assert.equal(first.fingerprintShadowPositiveCount, 2);
  assert.equal(first.quoteIntegrityPass, true);
  assert.equal(first.quoteDuplicateReductionBenign, true);
  assert.equal(first.quoteDuplicateReductionCount, 1);
  assert.equal(first.quoteMissingUniqueCount, 0);
  assert.equal(first.quoteIntegrityRestoreCount, 1);
  assert.equal(first.sourcePreflightChanged, true);
  assert.equal(first.sourceArtifactRemovedCount, 2);
  assert.deepEqual(first.sourcePreflightIssueCodes, ['source_ui_artifact']);
  assert.equal(first.endingStylePass, false);
  assert.equal(first.resumeCoverageRatio, 0.75);
  assert.equal(first.billingDisposition, 'waived_quality_shortfall');
  assert.equal(first.effectExpectation, 'normal');
  assert.equal(first.humanizationPlanSignalSource, 'deterministic_targets_input_risk');
  assert.deepEqual(first.humanizationDepthReasonCodes, ['substantive_edit_ratio_low']);
  assert.deepEqual(first.humanizationDepthBlockingReasonCodes, ['substantive_effect_too_low']);
  assert.deepEqual(first.chunkFailureCodes, ['novelty']);
  assert.deepEqual(first.chunkPrimaryFailureCodes, ['novelty']);
  assert.deepEqual(first.chunkResidualFailureCodes, ['pov']);
  assert.deepEqual(first.chunkFallbackReasonCodes, ['gpt_primary_and_escalation_failed']);
  assert.equal(first.polishRetryReason, 'evaluative_padding');
  assert.deepEqual(first.polishEvaluativePaddingCodes, ['efficiency_label']);
  assert.equal(first.polishDeterministicPaddingRestoreCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'result'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'gateDetail'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'sourceFingerprint'), false);

  const blockedWithoutResult = transform.buildArchiveDocument({
    id: 'archive-observability-blocked-without-result',
    status: 'blocked',
    mode: 'blog',
    text: '아카이브에 저장하면 안 되는 원문',
    gates: ['humanization_depth_no_effect'],
    engineMeta: {
      engineVersion: 'gpt-prod-v2.4.1',
      humanizationPolicyVersion: 'perceived-v2.1',
      humanizationDepthPass: false,
      humanizationMinimumEffectPass: false,
      humanizationDepthSoftDelivered: false,
      humanizationMinimumRatio: 0.13,
      humanizationHardMinimumRatio: 0.052,
      substantiveEditRatio: 0.03
    }
  }, {}, 9500);
  assert.equal(blockedWithoutResult.engineVersion, 'gpt-prod-v2.4.1');
  assert.equal(blockedWithoutResult.humanizationPolicyVersion, 'perceived-v2.1');
  assert.equal(blockedWithoutResult.humanizationDepthPass, false);
  assert.equal(blockedWithoutResult.humanizationMinimumEffectPass, false);
  assert.equal(blockedWithoutResult.humanizationHardMinimumRatio, 0.052);
  assert.equal(blockedWithoutResult.substantiveEditRatio, 0.03);
  assert.equal(Object.prototype.hasOwnProperty.call(blockedWithoutResult, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(blockedWithoutResult, 'result'), false);

  job.status = 'running';
  const reopened = transform.buildArchiveDocument(job, {}, 10000);
  assert.equal(reopened.terminalAtMs, null, '차단 job 재처리 시 이전 terminal 시각을 지워야 한다');
  job.status = 'done';
  const completed = transform.buildArchiveDocument(job, {}, 11000);
  assert.equal(completed.terminalAtMs, 11000);
  assert.deepEqual(completed.gates, [], '완료 작업에는 이전 차단 게이트가 남으면 안 된다');
  assert.deepEqual(job.gates, []);
  assert.equal(job.gateDetail, null);

  const fallbackCompleted = transform.buildArchiveDocument({
    id: 'archive-preservation-fallback',
    status: 'done',
    mode: 'blog',
    text: '아카이브에 저장하면 안 되는 폴백 원문',
    gates: ['humanization_depth_no_effect'],
    result: {
      outputText: '저장하면 안 되는 폴백 결과',
      preservationFallback: true,
      qualityStatus: 'needs_review',
      engineMeta: {
        engineVersion: 'gpt-prod-v2.4.3',
        requestedMode: 'blog',
        effectiveMode: 'polish',
        requestStrength: 'polish',
        fallbackFromMode: 'blog'
      }
    }
  }, {}, 12000);
  assert.deepEqual(fallbackCompleted.gates, []);
  assert.equal(fallbackCompleted.preservationFallback, true);
  assert.equal(fallbackCompleted.fallbackFromMode, 'blog');
  assert.equal(fallbackCompleted.requestedMode, 'blog');
  assert.equal(fallbackCompleted.effectiveMode, 'polish');
  assert.equal(fallbackCompleted.engineVersion, 'gpt-prod-v2.4.3');
  assert.equal(Object.prototype.hasOwnProperty.call(fallbackCompleted, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fallbackCompleted, 'result'), false);
});

test('작업 이력과 운영 아카이브는 품질 경고와 floor 경고를 같은 코드 집합으로 저장한다', () => {
  const codes = transform.finalQualityWarningCodes({
    qualityWarnings: [
      { code: 'semantic_omission', message: '원문 대조 필요' },
      { code: 'humanization_depth_below_minimum', message: '강도 확인 필요' }
    ],
    floorReport: {
      warnings: [
        { gate: 'rhetorical_remediation_incomplete' },
        'humanization_depth_below_minimum'
      ]
    }
  });
  assert.deepEqual(codes, [
    'semantic_omission',
    'humanization_depth_below_minimum',
    'rhetorical_remediation_incomplete'
  ]);
});

test('transform 글 종류 입력은 공개 장르와 호환 별칭만 허용한다', () => {
  assert.equal(transform.normalizeDocumentProfileOverride('resume_application'), 'resume_application');
  assert.equal(transform.normalizeDocumentProfileOverride('blog_review'), 'review_blog');
  assert.equal(transform.normalizeDocumentProfileOverride('student_record'), 'student_record_teacher');
  assert.equal(transform.normalizeDocumentProfileOverride(''), '');
  assert.equal(transform.normalizeDocumentProfileOverride('unknown'), null);
  assert.equal(transform.normalizeDocumentProfileOverride('totally_invalid_profile'), null);
});

test('이용 기록 engineMeta는 깊이·장르·한국어 관측값만 축약한다', () => {
  const compact = historyService.compactHistoryEngineMeta({
    engineVersion: 'gpt-prod-v2.4.6', requestedMode: 'blog', documentProfile: 'resume_application',
    detectedDocumentProfile: 'unknown', detectedProfileConfidence: 0.61,
    requestedDocumentProfile: 'resume_application', profileOverrideApplied: true,
    tonePolicy: 'formal', targetRegister: 'professional', targetRegisterSource: 'document_profile',
    substantiveEditRatio: 0.27, structuralChangedSentenceRatio: 0.4,
    materiallyRecastSentenceCount: 5, effectiveStructuralChangedSentenceCount: 5,
    clauseLevelStructuralAlternative: true,
    rhetoricalRemediationCoverage: 0.75, koreanRefinementPass: true,
    macroDiscourseApplicable: true, macroDiscourseScore: 0.3,
    macroDiscoursePass: true, macroDiscourseOrderPass: true,
    macroDiscourseSourceParagraphCount: 6, macroDiscourseOutputParagraphCount: 5,
    macroDiscourseRecomposedParagraphCount: 2, macroDiscourseRepeatedEvaluationReduction: 1,
    macroDiscourseRoleOrderRetention: 0.83, macroDiscourseIdeaOrderRetention: 1,
    substantiveCarryoverCount: 3, substantiveCarryoverRatio: 0.18,
    substantiveCarryoverEligibleSentenceCount: 17, substantiveCarryoverMaximum: 0.25,
    humanizationTargetDepthMet: true,
    humanizationOverallDepthPass: true, humanizationEditTargetMet: true,
    humanizationTargetDepthGap: 0,
    primaryApprovedModelChunkCount: 3, approvedModelChunkCount: 4,
    sectionRecoverySelectedCount: 6, sectionRecoveryAttemptCount: 4,
    sectionRecoveryAppliedCount: 2, sectionRecoveryEscalationCount: 1,
    sectionRecoveryTargetOnlyCount: 2,
    sectionRecoveryRejectedAttemptCount: 3,
    sectionRecoveryRejectionCodes: ['number_changed', 'not_better'],
    sectionRecoveryRejectionCodeCounts: { number_changed: 2, not_better: 1 },
    sectionRecoveryMiniAppliedCount: 1, sectionRecoveryEscalationAppliedCount: 1,
    humanizationNoEffectRetryAttemptCount: 1,
    humanizationRoleRecoveryAttemptCount: 2,
    humanizationDepthRetryRejectedCount: 2,
    humanizationDepthRetryRejectionCodes: ['depth_not_improved', '사용자 원문 조각'],
    fingerprintIntroducedCount: 1, fingerprintRepairCount: 1, fingerprintIssueCodes: [],
    unsupportedSpecificityAuditVersion: 1, unsupportedSpecificityPass: true,
    unsupportedSpecificityIssueCount: 0, unsupportedSpecificityResidualCount: 0,
    unsupportedSpecificityRestoreCount: 1, unsupportedSpecificityRemovalCount: 0,
    unsupportedSpecificityRestoreRejectedCount: 0,
    unsupportedSpecificityRestoreRejectionCodes: [],
    semanticRelationShiftCount: 1, semanticRelationShiftFamilies: ['proof_goal_weakened_to_check'],
    fingerprintShadowPositiveCodes: ['review_together'], fingerprintShadowPositiveCount: 1,
    endingStylePass: true, endingStyleIssueCount: 0, resumeCoverageApplicable: true,
    resumeCoveragePass: true, resumeClaimCount: 4, resumeCoveredClaimCount: 4, resumeCoverageRatio: 1,
    resumeRepetitionAuditVersion: 1, resumeRepetitionApplicable: true, resumeRepetitionPass: false,
    resumeRepetitionThemeCount: 2, resumeRepetitionSourcePairCount: 8,
    resumeRepetitionResidualPairCount: 7, resumeRepetitionRequiredReduction: 2,
    resumeRepetitionAchievedReduction: 1, resumeRepetitionCoverage: 0.5,
    billingDisposition: 'waived_quality_shortfall', effectExpectation: 'normal',
    koreanRefinementIssueCodes: [], formalRegisterResidualCount: 2,
    sourceReviewWarningCodes: ['deep_understanding_collocation'],
    quoteIntegrityPass: true, quoteIntegrityRestoreCount: 1,
    quoteDuplicateReductionBenign: true, quoteDuplicateReductionCount: 1, quoteMissingUniqueCount: 0,
    sourcePreflightChanged: true, sourceArtifactRemovedCount: 1,
    sourcePreflightIssueCodes: ['source_ui_artifact'],
    finalGeneratedDedupeApplied: true, finalGeneratedDedupeRejected: false,
    finalGeneratedDedupeBlockCount: 1, finalGeneratedDedupeSentenceCount: 5,
    finalGeneratedDedupeReasonCodes: [],
    pipelineFixedPoint: {
      safetyPass: true,
      depthHardMinimumPass: true,
      structurePass: true,
      quotePass: true,
      inlineCodePass: true,
      reasonCodes: []
    },
    recoveryBudgetEnabled: true, recoveryBudgetEnforced: true, recoveryBudgetLimitUsd: 0.8,
    recoveryBudgetSpentUsd: 0.42, recoveryBudgetExhausted: false,
    recoveryBudgetAttemptedCallCount: 5, recoveryBudgetSkippedCallCount: 1,
    recoveryBudgetSkippedCodes: ['whole_document_depth_recovery'],
    recoveryBudgetStageUsageUsd: { semantic_judge: 0.42 },
    niklAdvisorVersion: 'nikl-lexical-advisor-v2',
    niklLocalResourceEnabled: true, niklLocalResourceApplied: true,
    niklLocalCandidateCount: 3, niklLocalAppliedCount: 2, niklLocalErrorCount: 0,
    niklExternalApiEnabled: false, niklExternalProviderCount: 0,
    niklExternalCandidateCount: 0, niklExternalLookupCount: 0,
    niklExternalHitCount: 0, niklExternalAppliedCount: 0,
    niklExternalCacheHitCount: 0, niklExternalErrorCount: 0, niklExternalTimeoutCount: 0,
    prompt: '저장 금지', source: '저장 금지', protectedTerms: ['저장 금지']
  });
  assert.equal(compact.requestedDocumentProfile, 'resume_application');
  assert.equal(compact.profileOverrideApplied, true);
  assert.equal(compact.targetRegister, 'professional');
  assert.equal(compact.substantiveEditRatio, 0.27);
  assert.equal(compact.structuralChangedSentenceRatio, 0.4);
  assert.equal(compact.rhetoricalRemediationCoverage, 0.75);
  assert.equal(compact.macroDiscourseApplicable, true);
  assert.equal(compact.macroDiscourseScore, 0.3);
  assert.equal(compact.macroDiscoursePass, true);
  assert.equal(compact.macroDiscourseOrderPass, true);
  assert.equal(compact.macroDiscourseRecomposedParagraphCount, 2);
  assert.equal(compact.substantiveCarryoverRatio, 0.18);
  assert.equal(compact.primaryApprovedModelChunkCount, 3);
  assert.equal(compact.approvedModelChunkCount, 4);
  assert.equal(compact.sectionRecoverySelectedCount, 6);
  assert.equal(compact.sectionRecoveryAppliedCount, 2);
  assert.equal(compact.sectionRecoveryTargetOnlyCount, 2);
  assert.equal(compact.humanizationTargetDepthMet, true);
  assert.equal(compact.humanizationOverallDepthPass, true);
  assert.equal(compact.humanizationEditTargetMet, true);
  assert.equal(compact.humanizationTargetDepthGap, 0);
  assert.equal(compact.sectionRecoveryRejectedAttemptCount, 3);
  assert.deepEqual(compact.sectionRecoveryRejectionCodes, ['number_changed', 'not_better']);
  assert.deepEqual(compact.sectionRecoveryRejectionCodeCounts, { number_changed: 2, not_better: 1 });
  assert.equal(compact.fingerprintRepairCount, 1);
  assert.deepEqual(compact.fingerprintShadowPositiveCodes, ['review_together']);
  assert.equal(compact.unsupportedSpecificityPass, true);
  assert.equal(compact.unsupportedSpecificityRestoreCount, 1);
  assert.equal(compact.unsupportedSpecificityResidualCount, 0);
  assert.equal(compact.humanizationNoEffectRetryAttemptCount, 1);
  assert.equal(compact.humanizationRoleRecoveryAttemptCount, 2);
  assert.equal(compact.humanizationDepthRetryRejectedCount, 2);
  assert.deepEqual(compact.humanizationDepthRetryRejectionCodes, ['depth_not_improved']);
  assert.equal(compact.quoteIntegrityPass, true);
  assert.equal(compact.quoteIntegrityRestoreCount, 1);
  assert.equal(compact.quoteDuplicateReductionBenign, true);
  assert.equal(compact.quoteDuplicateReductionCount, 1);
  assert.equal(compact.quoteMissingUniqueCount, 0);
  assert.equal(compact.sourcePreflightChanged, true);
  assert.deepEqual(compact.sourcePreflightIssueCodes, ['source_ui_artifact']);
  assert.equal(compact.finalGeneratedDedupeApplied, true);
  assert.equal(compact.finalGeneratedDedupeRejected, false);
  assert.equal(compact.finalGeneratedDedupeBlockCount, 1);
  assert.equal(compact.finalGeneratedDedupeSentenceCount, 5);
  assert.equal(compact.endingStylePass, true);
  assert.equal(compact.resumeCoverageRatio, 1);
  assert.equal(compact.resumeRepetitionApplicable, true);
  assert.equal(compact.resumeRepetitionPass, false);
  assert.equal(compact.resumeRepetitionCoverage, 0.5);
  assert.equal(compact.billingDisposition, 'waived_quality_shortfall');
  assert.deepEqual(compact.sourceReviewWarningCodes, ['deep_understanding_collocation']);
  assert.equal(compact.clauseLevelStructuralAlternative, true);
  assert.equal(compact.semanticRelationShiftCount, 1);
  assert.deepEqual(compact.semanticRelationShiftFamilies, ['proof_goal_weakened_to_check']);
  assert.equal(compact.formalRegisterResidualCount, 2);
  assert.equal(compact.niklAdvisorVersion, 'nikl-lexical-advisor-v2');
  assert.equal(compact.niklLocalResourceEnabled, true);
  assert.equal(compact.niklLocalResourceApplied, true);
  assert.equal(compact.niklLocalCandidateCount, 3);
  assert.equal(compact.niklLocalAppliedCount, 2);
  assert.equal(compact.niklExternalApiEnabled, false);
  assert.equal(compact.pipelineFixedPoint.safetyPass, true);
  assert.equal(compact.pipelineFixedPoint.depthHardMinimumPass, true);
  assert.equal(compact.recoveryBudgetLimitUsd, 0.8);
  assert.equal(compact.recoveryBudgetEnforced, true);
  assert.equal(compact.recoveryBudgetSpentUsd, 0.42);
  assert.deepEqual(compact.recoveryBudgetSkippedCodes, ['whole_document_depth_recovery']);
  assert.deepEqual(compact.recoveryBudgetStageUsageUsd, { semantic_judge: 0.42 });
  assert.equal(
    historyService.compactHistoryEngineMeta({ billingDisposition: 'charge_failed' }).billingDisposition,
    'charge_failed'
  );
  assert.equal(Object.hasOwn(compact, 'prompt'), false);
  assert.equal(Object.hasOwn(compact, 'source'), false);
  assert.equal(Object.hasOwn(compact, 'protectedTerms'), false);
});
