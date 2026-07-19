'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHumanizeQualityReport, summarizeMetric } = require('../lib/humanizeQualityReport');

test('휴머나이징 품질 보고서는 교차표·경고·깊이 지표를 원문 없이 집계한다', () => {
  const rows = [
    {
      id: 'a', uid: 'u1', status: 'done', deducted: true, createdAtMs: 200,
      engineVersion: 'gpt-prod-v2.4.6', requestedMode: 'blog', effectiveMode: 'assignment',
      documentProfile: 'resume_application', qualityStatus: 'clean',
      humanizationDeliveryDepthBand: 'target', substantiveEditRatio: 0.31,
      humanizationDepthApplicable: true, humanizationDepthPass: true,
      substantiveCarryoverRatio: 0.22, substantiveCarryoverMaximum: 0.3,
      structuralChangedSentenceRatio: 0.42, rhetoricalRemediationCoverage: 1,
      billingDisposition: 'charged', sectionRecoveryAttemptCount: 2,
      sectionRecoveryAppliedCount: 1, processingDurationMs: 120000,
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
      humanizationNoBenefitDelivered: true,
      substantiveCarryoverRatio: 0.36, substantiveCarryoverMaximum: 0.3,
      structuralChangedSentenceRatio: 0.1, rhetoricalRemediationCoverage: 0.5,
      billingDisposition: 'waived_quality_shortfall', sectionRecoveryAttemptCount: 1,
      sectionRecoveryAppliedCount: 0, fingerprintPass: false,
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
    }
  ];
  const report = buildHumanizeQualityReport(rows, { hours: 24, sinceMs: 0, generatedAtMs: 1000 });
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.needsReviewCount, 1);
  assert.equal(report.summary.needsReviewRate, 0.5);
  assert.equal(report.summary.koreanRefinementFailureCount, 1);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.summary.depthBelowMinimumRate, 0.5);
  assert.equal(report.summary.waivedRate, 0.5);
  assert.equal(report.summary.noBenefitDeliveredCount, 1);
  assert.equal(report.summary.carryoverOverLimitCount, 1);
  assert.equal(report.summary.sectionRecoveryAppliedCount, 1);
  assert.equal(report.summary.fingerprintIssueCount, 1);
  assert.equal(report.metrics.substantiveCarryoverRatio.median, 0.29);
  assert.equal(report.metrics.processingDurationMs.p95, 234000);
  assert.equal(report.window.sinceMs, 0);
  assert.equal(report.requestedModeDocumentProfileEngineQuality.length, 3);
  assert.deepEqual(report.sourceReviewWarningCounts, [{ code: 'reflection_formula', count: 2 }]);
  assert.equal(report.metrics.substantiveEditRatio.median, 0.24);
  assert.equal(Object.hasOwn(report.recent[0], 'inputText'), false);
  assert.equal(Object.hasOwn(report.recent[0], 'outputText'), false);
  assert.equal(Object.hasOwn(report.recent[0], 'uid'), false);
});

test('품질 수치 요약은 선형 보간 p95와 빈 표본을 안정적으로 처리한다', () => {
  assert.deepEqual(summarizeMetric([], 'value'), {
    count: 0, average: null, median: null, p95: null, min: null, max: null
  });
  const summary = summarizeMetric([{ value: 0 }, { value: 1 }], 'value');
  assert.equal(summary.average, 0.5);
  assert.equal(summary.p95, 0.95);
});
