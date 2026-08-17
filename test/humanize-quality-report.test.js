'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHumanizeQualityReport, summarizeMetric } = require('../lib/humanizeQualityReport');
const paymentRoute = require('../routes/payment');

test('관리자 작업 축약 직렬화는 실험실 표지를 품질 집계까지 전달한다', () => {
  const row = paymentRoute.serializeAdminJobDoc({
    id: 'lab-job',
    data: () => ({
      status: 'done',
      createdAt: 100,
      adminHumanizeLab: true,
      engineVersion: 'gpt-prod-v2.5.0',
      finalGeneratedDedupeApplied: true,
      finalGeneratedDedupeRejected: false,
      finalGeneratedDedupeBlockCount: 1,
      finalGeneratedDedupeSentenceCount: 5,
      postSemanticSubstantiveEditRatio: 0.21,
      finalStageSubstantiveEditRatio: 0.18,
      postSemanticToFinalSubstantiveEditDelta: -0.03,
      depthTugTrigger: 'depth_regression',
      depthTugFinalSide: 'source',
      humanizationDepthRetryRejectionCodes: ['safety_audit_failed'],
      recoveryBudgetSkippedCodes: ['recovery_call_limit_exhausted']
    })
  });
  assert.equal(row.adminHumanizeLab, true);
  assert.equal(row.finalGeneratedDedupeApplied, true);
  assert.equal(row.finalGeneratedDedupeRejected, false);
  assert.equal(row.finalGeneratedDedupeBlockCount, 1);
  assert.equal(row.finalGeneratedDedupeSentenceCount, 5);
  assert.equal(row.postSemanticToFinalSubstantiveEditDelta, -0.03);
  assert.equal(row.depthTugFinalSide, 'source');
  assert.deepEqual(row.humanizationDepthRetryRejectionCodes, ['safety_audit_failed']);
  assert.deepEqual(row.recoveryBudgetSkippedCodes, ['recovery_call_limit_exhausted']);
});

test('휴머나이징 품질 보고서는 교차표·경고·깊이 지표를 원문 없이 집계한다', () => {
  const rows = [
    {
      id: 'a', uid: 'u1', status: 'done', deducted: true, createdAtMs: 200,
      engineVersion: 'gpt-prod-v2.4.6', requestedMode: 'blog', effectiveMode: 'assignment',
      documentProfile: 'resume_application', qualityStatus: 'clean',
      humanizationDeliveryDepthBand: 'target', substantiveEditRatio: 0.31,
      humanizationDepthApplicable: true, humanizationDepthPass: true,
      humanizationTargetDepthMet: true,
      humanizationTargetDepthGap: 0,
      postSemanticSubstantiveEditRatio: 0.33,
      finalStageSubstantiveEditRatio: 0.31,
      postSemanticToFinalSubstantiveEditDelta: -0.02,
      depthTugTrigger: 'depth_regression', depthTugFinalSide: 'source',
      humanizationDepthRetryRejectionCodes: ['safety_audit_failed'],
      recoveryBudgetSkippedCodes: ['recovery_call_limit_exhausted'],
      substantiveCarryoverRatio: 0.22, substantiveCarryoverMaximum: 0.3,
      structuralChangedSentenceRatio: 0.42, rhetoricalRemediationCoverage: 1,
      macroDiscourseApplicable: true, macroDiscourseScore: 0.5,
      macroDiscoursePass: true, macroDiscourseOrderPass: true,
      macroDiscourseSourceParagraphCount: 6, macroDiscourseOutputParagraphCount: 5,
      macroDiscourseRecomposedParagraphCount: 2, macroDiscourseRepeatedEvaluationReduction: 1,
      macroDiscourseRoleOrderRetention: 0.83, macroDiscourseIdeaOrderRetention: 1,
      billingDisposition: 'charged', sectionRecoveryAttemptCount: 2,
      sectionRecoveryTargetOnlyCount: 1,
      sectionRecoveryAppliedCount: 1, sectionRecoveryRejectedAttemptCount: 1,
      sectionRecoveryRejectionCodes: ['not_better'], sectionRecoveryMiniAppliedCount: 1,
      semanticRelationShiftCount: 1, semanticRelationShiftFamilies: ['proof_goal_weakened'],
      targetRegister: 'professional', formalRegisterResidualCount: 1,
      processingDurationMs: 120000,
      humanizationNoEffectRetryAttemptCount: 1,
      fingerprintShadowPositiveCodes: ['review_together'], fingerprintShadowPositiveCount: 1,
      quoteIntegrityPass: true, quoteIntegrityRestoreCount: 1,
      quoteDuplicateReductionBenign: true, quoteDuplicateReductionCount: 1, quoteMissingUniqueCount: 0,
      sourcePreflightChanged: true, sourceArtifactRemovedCount: 1,
      sourcePreflightIssueCodes: ['source_ui_artifact'],
      qualityWarningCodes: [], sourceReviewWarningCodes: ['reflection_formula'],
      koreanRefinementIssueCodes: [], koreanRefinementPass: true, estimatedUsd: 0.03,
      inputText: '응답에 포함되면 안 되는 원문', outputText: '응답에 포함되면 안 되는 결과'
    },
    {
      id: 'b', uid: 'u2', status: 'done', deducted: true, createdAtMs: 100,
      engineVersion: 'gpt-prod-v2.4.6', requestedMode: 'blog', effectiveMode: 'assignment',
      documentProfile: 'resume_application', qualityStatus: 'needs_review',
      humanizationDeliveryDepthBand: 'minimum', substantiveEditRatio: 0.17,
      humanizationDepthApplicable: true, humanizationDepthPass: false,
      humanizationTargetDepthMet: false,
      humanizationTargetDepthGap: 0.04,
      postSemanticSubstantiveEditRatio: 0.15,
      finalStageSubstantiveEditRatio: 0.17,
      postSemanticToFinalSubstantiveEditDelta: 0.02,
      humanizationNoBenefitDelivered: true,
      substantiveCarryoverRatio: 0.36, substantiveCarryoverMaximum: 0.3,
      structuralChangedSentenceRatio: 0.1, rhetoricalRemediationCoverage: 0.5,
      macroDiscourseApplicable: true, macroDiscourseScore: 0,
      macroDiscoursePass: false, macroDiscourseOrderPass: true,
      macroDiscourseSourceParagraphCount: 6, macroDiscourseOutputParagraphCount: 6,
      macroDiscourseRecomposedParagraphCount: 0, macroDiscourseRepeatedEvaluationReduction: 0,
      macroDiscourseRoleOrderRetention: 1, macroDiscourseIdeaOrderRetention: 1,
      billingDisposition: 'waived_quality_shortfall', sectionRecoveryAttemptCount: 1,
      sectionRecoveryAppliedCount: 0, fingerprintPass: false,
      quoteIntegrityPass: false, quoteContentChangedCount: 1,
      endingStylePass: false, resumeCoverageApplicable: true, resumeCoveragePass: false,
      processingDurationMs: 240000,
      qualityWarningCodes: ['rhetorical_remediation_low'],
      sourceReviewWarningCodes: ['reflection_formula'],
      koreanRefinementIssueCodes: ['register_downgrade'], koreanRefinementPass: false,
      naturalnessRiskIncreased: true, estimatedUsd: 0.05
    },
    {
      id: 'c', uid: 'u3', status: 'blocked', deducted: false, createdAtMs: 50,
      engineVersion: 'gpt-prod-v2.4.8', requestedMode: 'formal', effectiveMode: 'assignment',
      documentProfile: 'academic_paper', qualityStatus: '', billingDisposition: ''
    },
    {
      id: 'lab', uid: 'admin', status: 'blocked', deducted: false, createdAtMs: 300,
      adminHumanizeLab: true, engineVersion: 'gpt-prod-v2.5.0', requestedMode: 'formal',
      documentProfile: 'legal_contract', deliveryDecision: 'block_technical'
    }
  ];
  const report = buildHumanizeQualityReport(rows, { hours: 24, sinceMs: 0, generatedAtMs: 1000 });
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.needsReviewCount, 1);
  assert.equal(report.summary.needsReviewRate, 0.5);
  assert.equal(report.summary.koreanRefinementFailureCount, 1);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.summary.depthBelowMinimumRate, 0.5);
  assert.equal(report.summary.targetDepthMetRate, 0.5);
  assert.equal(report.summary.depthTugDocumentCount, 1);
  assert.equal(report.summary.depthTugSourceCount, 1);
  assert.equal(report.summary.depthTugSourceRate, 1);
  assert.equal(report.summary.safetyAuditRecoveryRejectCount, 1);
  assert.equal(report.summary.waivedRate, 0.5);
  assert.equal(report.summary.noBenefitDeliveredCount, 1);
  assert.equal(report.summary.carryoverOverLimitCount, 1);
  assert.equal(report.summary.sectionRecoveryAppliedCount, 1);
  assert.equal(report.summary.targetOnlyRecoveryAttemptedCount, 1);
  assert.equal(report.summary.sectionRecoveryRejectedDocumentCount, 1);
  assert.equal(report.summary.fingerprintIssueCount, 1);
  assert.equal(report.summary.semanticRelationShiftDocumentCount, 1);
  assert.equal(report.summary.formalRegisterResidualDocumentCount, 1);
  assert.equal(report.summary.noEffectSecondRecoveryCount, 1);
  assert.equal(report.summary.fingerprintShadowPositiveDocumentCount, 1);
  assert.equal(report.summary.quoteIntegrityIssueCount, 1);
  assert.equal(report.summary.quoteRestoreDocumentCount, 1);
  assert.equal(report.summary.sourcePreflightChangedCount, 1);
  assert.equal(report.metrics.substantiveCarryoverRatio.median, 0.29);
  assert.equal(report.metrics.humanizationTargetDepthGap.median, 0.02);
  assert.equal(report.metrics.macroDiscourseScore.median, 0.25);
  assert.equal(report.metrics.processingDurationMs.p95, 234000);
  assert.equal(report.window.sinceMs, 0);
  assert.equal(report.window.sourceRowCount, 4);
  assert.equal(report.window.excludedAdminLabCount, 1);
  assert.equal(report.requestedModeDocumentProfileEngineQuality.length, 3);
  assert.deepEqual(report.sourceReviewWarningCounts, [{ code: 'reflection_formula', count: 2 }]);
  assert.deepEqual(report.sourcePreflightIssueCounts, [{ code: 'source_ui_artifact', count: 1 }]);
  assert.deepEqual(report.fingerprintShadowPositiveCounts, [{ code: 'review_together', count: 1 }]);
  assert.deepEqual(report.semanticRelationShiftCounts, [{ code: 'proof_goal_weakened', count: 1 }]);
  assert.deepEqual(report.sectionRecoveryRejectionCounts, [{ code: 'not_better', count: 1 }]);
  assert.deepEqual(report.humanizationDepthRetryRejectionCounts, [{ code: 'safety_audit_failed', count: 1 }]);
  assert.deepEqual(report.recoveryBudgetSkippedCounts, [{ code: 'recovery_call_limit_exhausted', count: 1 }]);
  assert.equal(report.recent[0].targetRegister, 'professional');
  assert.equal(report.recent[0].macroDiscoursePass, true);
  assert.equal(report.recent[0].macroDiscourseRecomposedParagraphCount, 2);
  assert.equal(report.recent[0].quoteDuplicateReductionBenign, true);
  assert.equal(report.metrics.substantiveEditRatio.median, 0.24);
  assert.equal(report.metrics.postSemanticToFinalSubstantiveEditDelta.median, 0);
  assert.equal(report.recent[0].depthTugFinalSide, 'source');
  assert.equal(Object.hasOwn(report.recent[0], 'inputText'), false);
  assert.equal(Object.hasOwn(report.recent[0], 'outputText'), false);
  assert.equal(Object.hasOwn(report.recent[0], 'uid'), false);
  assert.equal(report.latestEngine.engineVersion, 'gpt-prod-v2.4.6');
  assert.equal(report.latestEngine.rowCount, 2);
  assert.equal(report.latestEngine.needsReviewRate, 0.5);
  assert.equal(report.engineCohorts.length, 1);
});

test('품질 수치 요약은 선형 보간 p95와 빈 표본을 안정적으로 처리한다', () => {
  assert.deepEqual(summarizeMetric([], 'value'), {
    count: 0, average: null, median: null, p95: null, min: null, max: null
  });
  const summary = summarizeMetric([{ value: 0 }, { value: 1 }], 'value');
  assert.equal(summary.average, 0.5);
  assert.equal(summary.p95, 0.95);
});

test('완료되지 않은 오류·미측정 행의 0은 완료 품질 평균에 섞지 않는다', () => {
  const report = buildHumanizeQualityReport([
    {
      id: 'done-a',
      status: 'done',
      substantiveEditRatio: 0.12,
      processingDurationMs: 60000,
      effectStatus: 'limited'
    },
    {
      id: 'done-b',
      status: 'done',
      substantiveEditRatio: 0.18,
      processingDurationMs: 120000,
      effectStatus: 'normal'
    },
    {
      id: 'api-error',
      status: 'error',
      substantiveEditRatio: 0,
      processingDurationMs: 0,
      deliveryDecision: 'block_technical'
    },
    {
      id: 'pending-archive',
      status: 'processing',
      substantiveEditRatio: 0,
      processingDurationMs: 0
    }
  ], { hours: 24, sinceMs: 0, generatedAtMs: 1000 });

  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.completedCount, 2);
  assert.equal(report.metrics.substantiveEditRatio.count, 2);
  assert.equal(report.metrics.substantiveEditRatio.average, 0.15);
  assert.equal(report.metrics.processingDurationMs.average, 90000);
  assert.equal(report.summary.deliveredLimitedEffectCount, 1);
  assert.equal(report.summary.technicalBlockedCount, 1);
});
