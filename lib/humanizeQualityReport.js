'use strict';

const METRIC_FIELDS = Object.freeze([
  'substantiveEditRatio',
  'substantiveChangedSentenceRatio',
  'substantiveCarryoverRatio',
  'humanizationTargetCoverage',
  'humanizationTargetDepthGap',
  'postSemanticSubstantiveEditRatio',
  'finalStageSubstantiveEditRatio',
  'postSemanticToFinalSubstantiveEditDelta',
  'structuralChangedSentenceRatio',
  'rhetoricalRemediationCoverage',
  'sectionRecoveryAttemptCount',
  'sectionRecoveryTargetOnlyCount',
  'sectionRecoveryAppliedCount',
  'sectionRecoveryEscalationCount',
  'sectionRecoveryRejectedAttemptCount',
  'sectionRecoveryMiniAppliedCount',
  'sectionRecoveryEscalationAppliedCount',
  'humanizationNoEffectRetryAttemptCount',
  'conservativeSentenceRetryAttemptCount',
  'conservativeSentenceRetryModelCallCount',
  'conservativeSentenceRetryAppliedCount',
  'fingerprintIntroducedCount',
  'semanticRelationShiftCount',
  'fingerprintRepairCount',
  'fingerprintShadowPositiveCount',
  'lexicalTransitionCount',
  'quoteContentChangedCount',
  'quoteIntegrityRestoreCount',
  'sourceArtifactRemovedCount',
  'sourcePreflightNoticeCount',
  'formalRegisterResidualCount',
  'studentRecordFragmentCount',
  'functionalGreetingDuplicationCount',
  'adjacentSemanticRepetitionCount',
  'directionalGrowthCollocationCount',
  'signatureLineCount',
  'clinicalStructureSignalCount',
  'endingStyleIntroducedOtherCount',
  'resumeCoverageRatio',
  'editableChunkCount',
  'approvedModelChunkCount',
  'modelFailureChunkCount',
  'sectionPathErrorCount',
  'chunkConcurrency',
  'naturalnessOverallRiskDelta',
  'rhythmUniformityDelta',
  'lengthRatio',
  'estimatedUsd',
  'processingDurationMs',
  'totalDurationMs'
]);

const DIMENSION_FIELDS = Object.freeze([
  'engineVersion',
  'requestedMode',
  'effectiveMode',
  'documentProfile',
  'profileDecisionSource',
  'targetRegister',
  'qualityStatus',
  'humanizationDeliveryDepthBand',
  'billingDisposition',
  'effectExpectation',
  'effectStatus',
  'deliveryDecision',
  'depthTugTrigger',
  'depthTugFinalSide'
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeKey(value, fallback = 'unknown') {
  const text = String(value || '').trim();
  return text || fallback;
}

function uniqueCodes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(value => /^[a-z][a-z0-9_.:-]{1,79}$/u.test(value)))]
    .slice(0, 30);
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function countRows(rows, field) {
  const counts = new Map();
  for (const row of rows) increment(counts, safeKey(row?.[field]));
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function quantile(sorted, ratio) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const fraction = index - low;
  return sorted[low] + (sorted[high] - sorted[low]) * fraction;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeMetric(rows, field) {
  const values = rows.map(row => finite(row?.[field])).filter(value => value !== null).sort((a, b) => a - b);
  if (!values.length) return { count: 0, average: null, median: null, p95: null, min: null, max: null };
  return {
    count: values.length,
    average: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: round(quantile(values, 0.5)),
    p95: round(quantile(values, 0.95)),
    min: round(values[0]),
    max: round(values[values.length - 1])
  };
}

function countCodes(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    for (const code of uniqueCodes(row?.[field])) increment(counts, code);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function buildCrossTable(rows) {
  const counts = new Map();
  for (const row of rows) {
    const values = [
      safeKey(row?.requestedMode),
      safeKey(row?.documentProfile),
      safeKey(row?.engineVersion),
      safeKey(row?.qualityStatus)
    ];
    increment(counts, JSON.stringify(values));
  }
  return [...counts.entries()]
    .map(([serialized, count]) => {
      const [requestedMode, documentProfile, engineVersion, qualityStatus] = JSON.parse(serialized);
      return { requestedMode, documentProfile, engineVersion, qualityStatus, count };
    })
    .sort((a, b) => b.count - a.count
      || a.requestedMode.localeCompare(b.requestedMode)
      || a.documentProfile.localeCompare(b.documentProfile)
      || a.engineVersion.localeCompare(b.engineVersion)
      || a.qualityStatus.localeCompare(b.qualityStatus));
}

function publicRecentRow(row) {
  const fields = [
    'id', 'status', 'stage', 'mode', 'createdAtMs', 'updatedAtMs', 'deducted',
    'billingDisposition', 'effectExpectation', 'effectNoticeCode', 'effectStatus',
    'processingDurationMs', 'totalDurationMs',
    'textLength', 'resultLength', 'engineVersion', 'requestedMode', 'effectiveMode',
    'requestStrength', 'documentProfile', 'profileConfidence', 'profileDecisionSource',
    'profileGroup', 'profileGroupMargin',
    'detectedDocumentProfile', 'detectedProfileConfidence', 'requestedDocumentProfile',
    'profileOverrideApplied', 'profileOverrideIgnoredReason',
    'tonePolicy', 'targetRegister', 'targetRegisterSource',
    'qualityStatus', 'deliveryDecision', 'editableChunkCount', 'approvedModelChunkCount',
    'modelFailureChunkCount', 'chunkConcurrency', 'structureSignaturePass', 'sectionPathErrorCount',
    'humanizationDepthApplicable', 'humanizationDepthPass', 'humanizationTargetDepthMet',
    'humanizationMinimumEffectPass', 'humanizationNoBenefitDelivered', 'humanizationDeliveryDepthBand', 'substantiveEditRatio',
    'postSemanticSubstantiveEditRatio', 'finalStageSubstantiveEditRatio',
    'postSemanticToFinalSubstantiveEditDelta', 'depthTugTrigger', 'depthTugFinalSide',
    'humanizationNoEffectRetryAttemptCount',
    'conservativeSentenceRetryAttemptCount', 'conservativeSentenceRetryModelCallCount',
    'conservativeSentenceRetryAppliedCount',
    'substantiveChangedSentenceRatio', 'humanizationTargetCoverage', 'humanizationTargetDepthGap',
    'substantiveCarryoverCount', 'substantiveCarryoverRatio',
    'substantiveCarryoverEligibleSentenceCount', 'substantiveCarryoverMaximum',
    'structuralChangedSentenceCount', 'structuralChangedSentenceRatio',
    'materiallyRecastSentenceCount', 'effectiveStructuralChangedSentenceCount',
    'clauseLevelStructuralAlternative', 'rhetoricalRemediationCoverage',
    'sourceRedundancyApplicable', 'sourceRedundancyPass',
    'sourceRedundancySourceSentenceCount', 'sourceRedundancyOutputSentenceCount',
    'sourceRedundancyRequiredReduction', 'sourceRedundancyAchievedReduction',
    'sectionRecoveryEnabled', 'sectionRecoveryAttemptCount', 'sectionRecoveryTargetOnlyCount', 'sectionRecoveryAppliedCount',
    'sectionRecoveryEscalationCount', 'sectionRecoveryRejectedAttemptCount',
    'sectionRecoveryMiniAppliedCount', 'sectionRecoveryEscalationAppliedCount',
    'fingerprintPass', 'fingerprintIntroducedCount', 'semanticRelationShiftCount',
    'fingerprintRepairCount', 'fingerprintShadowPositiveCount', 'lexicalTransitionCount', 'endingStylePass', 'endingStyleIssueCount',
    'endingStyleIntroducedOtherCount', 'resumeCoverageApplicable', 'resumeCoveragePass',
    'resumeClaimCount', 'resumeCoveredClaimCount', 'resumeCoverageRatio',
    'koreanRefinementPass', 'formalRegisterResidualCount', 'studentRecordFragmentCount',
    'functionalGreetingDuplicationCount', 'adjacentSemanticRepetitionCount',
    'directionalGrowthCollocationCount', 'signatureLineCount', 'clinicalStructureSignalCount',
    'niklAdvisorVersion', 'niklLocalResourceEnabled', 'niklLocalResourceApplied',
    'niklLocalCandidateCount', 'niklLocalAppliedCount', 'niklLocalErrorCount', 'niklExternalProviderCount',
    'niklExternalApiEnabled',
    'niklExternalCandidateCount', 'niklExternalLookupCount', 'niklExternalHitCount',
    'niklExternalAppliedCount', 'niklExternalCacheHitCount', 'niklExternalErrorCount',
    'niklExternalTimeoutCount',
    'quoteIntegrityPass', 'quoteCountChanged', 'quoteContentChangedCount',
    'quoteIntegrityRestoreCount', 'sourcePreflightChanged', 'sourceArtifactRemovedCount',
    'sourcePreflightNoticeCount', 'naturalnessRiskIncreased', 'naturalnessOverallRiskDelta',
    'rhythmUniformityDelta', 'lengthRatio', 'estimatedUsd'
  ];
  const out = {};
  for (const field of fields) {
    if (row?.[field] !== undefined && row[field] !== null) out[field] = row[field];
  }
  out.qualityWarningCodes = uniqueCodes(row?.qualityWarningCodes);
  out.effectNoticeCodes = uniqueCodes(row?.effectNoticeCodes);
  out.deliveryReasonCodes = uniqueCodes(row?.deliveryReasonCodes);
  out.conservativeSentenceRetryRejectionCodes = uniqueCodes(row?.conservativeSentenceRetryRejectionCodes);
  out.sourceReviewWarningCodes = uniqueCodes(row?.sourceReviewWarningCodes);
  out.koreanRefinementIssueCodes = uniqueCodes(row?.koreanRefinementIssueCodes);
  out.humanizationDepthReasonCodes = uniqueCodes(row?.humanizationDepthReasonCodes);
  out.humanizationDepthRetryRejectionCodes = uniqueCodes(row?.humanizationDepthRetryRejectionCodes);
  out.recoveryBudgetSkippedCodes = uniqueCodes(row?.recoveryBudgetSkippedCodes);
  out.fingerprintIssueCodes = uniqueCodes(row?.fingerprintIssueCodes);
  out.semanticRelationShiftFamilies = uniqueCodes(row?.semanticRelationShiftFamilies);
  out.fingerprintShadowPositiveCodes = uniqueCodes(row?.fingerprintShadowPositiveCodes);
  out.lexicalTransitionCodes = uniqueCodes(row?.lexicalTransitionCodes);
  out.sectionRecoveryRejectionCodes = uniqueCodes(row?.sectionRecoveryRejectionCodes);
  out.sourcePreflightIssueCodes = uniqueCodes(row?.sourcePreflightIssueCodes);
  return out;
}

function buildEngineCohorts(completedRows) {
  const byVersion = new Map();
  for (const row of completedRows || []) {
    const version = safeKey(row?.engineVersion, 'legacy_unknown');
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(row);
  }
  return [...byVersion.entries()]
    .map(([engineVersion, rows]) => {
      const qualityStatuses = Object.fromEntries(countRows(rows, 'qualityStatus').map(item => [item.key, item.count]));
      const needsReviewCount = qualityStatuses.needs_review || 0;
      const denominator = Math.max(1, rows.length);
      const newestCreatedAtMs = rows.reduce((latest, row) => Math.max(latest, finite(row?.createdAtMs) || 0), 0);
      return {
        engineVersion,
        rowCount: rows.length,
        completedCount: rows.length,
        newestCreatedAtMs,
        needsReviewCount,
        needsReviewRate: round(needsReviewCount / denominator),
        structureSignatureFailureCount: rows.filter(row => row.structureSignaturePass === false).length,
        koreanRefinementFailureCount: rows.filter(row => row.koreanRefinementPass === false).length,
        naturalnessRiskIncreaseCount: rows.filter(row => row.naturalnessRiskIncreased === true).length,
        rhythmRiskIncreaseCount: rows.filter(row => (finite(row.rhythmUniformityDelta) || 0) > 0).length,
        warningCounts: countCodes(rows, 'qualityWarningCodes'),
        metrics: Object.fromEntries(METRIC_FIELDS.map(field => [field, summarizeMetric(rows, field)]))
      };
    })
    .sort((left, right) => right.newestCreatedAtMs - left.newestCreatedAtMs
      || right.rowCount - left.rowCount
      || left.engineVersion.localeCompare(right.engineVersion));
}

function buildHumanizeQualityReport(rows, options = {}) {
  const inputRows = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object');
  // 관리자 실험실 호출은 배포 검증용 합성 트래픽이다. 사용자 운영 품질과
  // 차단률·장르 분포를 오염시키지 않도록 보고서 모수에서 분리한다.
  const safeRows = inputRows.filter(row => row.adminHumanizeLab !== true);
  const excludedAdminLabCount = inputRows.length - safeRows.length;
  const requestedGeneratedAtMs = finite(options.generatedAtMs);
  const generatedAtMs = requestedGeneratedAtMs === null ? Date.now() : requestedGeneratedAtMs;
  const hours = Math.min(Math.max(Math.trunc(finite(options.hours) || 24), 1), 2160);
  const requestedSinceMs = finite(options.sinceMs);
  const sinceMs = requestedSinceMs === null ? (generatedAtMs - hours * 3600 * 1000) : requestedSinceMs;
  const statuses = Object.fromEntries(countRows(safeRows, 'status').map(item => [item.key, item.count]));
  const qualityStatuses = Object.fromEntries(countRows(safeRows, 'qualityStatus').map(item => [item.key, item.count]));
  const billingDispositions = Object.fromEntries(countRows(safeRows, 'billingDisposition').map(item => [item.key, item.count]));
  const denominator = Math.max(1, safeRows.length);
  const completedRows = safeRows.filter(row => row.status === 'done');
  const completedDenominator = Math.max(1, completedRows.length);
  const depthApplicableRows = completedRows.filter(row => row.humanizationDepthApplicable === true);
  const depthDenominator = Math.max(1, depthApplicableRows.length);
  const depthBelowMinimumCount = depthApplicableRows.filter(row => row.humanizationDepthPass === false).length;
  const targetDepthMetCount = depthApplicableRows.filter(row => row.humanizationTargetDepthMet === true).length;
  const depthTugRows = completedRows.filter(row => safeKey(row.depthTugTrigger, '') !== '');
  const depthTugSourceCount = depthTugRows.filter(row => row.depthTugFinalSide === 'source').length;
  const safetyAuditRecoveryRejectCount = completedRows.filter(row => (
    uniqueCodes(row.humanizationDepthRetryRejectionCodes).includes('safety_audit_failed')
  )).length;
  const qualityWaivedCount = completedRows.filter(row => row.billingDisposition === 'waived_quality_shortfall').length;
  const repeatWaivedCount = completedRows.filter(row => row.billingDisposition === 'waived_repeat_low_benefit').length;
  const waivedCount = qualityWaivedCount + repeatWaivedCount;
  // 실질 편집률·리듬·비용·처리시간은 사용자에게 결과가 전달된 완료 작업의
  // 품질 지표다. API 오류나 아직 미측정인 archive 행에 기록된 0을 섞으면
  // 운영 평균이 실제 완료 결과보다 과도하게 낮아진다. 기술 실패는 아래
  // blocked/model-failure 집계에서 별도로 관측한다.
  const metrics = Object.fromEntries(METRIC_FIELDS.map(field => [field, summarizeMetric(completedRows, field)]));
  const dimensions = Object.fromEntries(DIMENSION_FIELDS.map(field => [field, countRows(safeRows, field)]));
  const engineCohorts = buildEngineCohorts(completedRows);

  return {
    schemaVersion: 4,
    generatedAtMs,
    window: {
      hours,
      sinceMs,
      rowCount: safeRows.length,
      sourceRowCount: inputRows.length,
      excludedAdminLabCount
    },
    summary: {
      total: safeRows.length,
      completedCount: completedRows.length,
      chargedCount: safeRows.filter(row => row.deducted === true).length,
      qualityWaivedCount,
      repeatWaivedCount,
      waivedCount,
      waivedRate: round(waivedCount / completedDenominator),
      limitedEffectCount: completedRows.filter(row => row.effectExpectation === 'limited').length,
      deliveredLimitedEffectCount: completedRows.filter(row => row.effectStatus === 'limited').length,
      technicalBlockedCount: safeRows.filter(row => row.deliveryDecision === 'block_technical').length,
      allModelFailureCount: safeRows.filter(row => Number(row.editableChunkCount) > 0
        && Number(row.modelFailureChunkCount) >= Number(row.editableChunkCount)).length,
      zeroApprovedChargedCount: completedRows.filter(row => Number(row.approvedModelChunkCount) === 0
        && row.deducted === true).length,
      structureSignatureFailureCount: completedRows.filter(row => row.structureSignaturePass === false).length,
      sectionPathErrorDocumentCount: completedRows.filter(row => Number(row.sectionPathErrorCount) > 0).length,
      depthApplicableCount: depthApplicableRows.length,
      depthBelowMinimumCount,
      depthBelowMinimumRate: round(depthBelowMinimumCount / depthDenominator),
      targetDepthMetCount,
      targetDepthMetRate: round(targetDepthMetCount / depthDenominator),
      depthTugDocumentCount: depthTugRows.length,
      depthTugSourceCount,
      depthTugSourceRate: round(depthTugSourceCount / Math.max(1, depthTugRows.length)),
      safetyAuditRecoveryRejectCount,
      carryoverOverLimitCount: completedRows.filter(row => Number.isFinite(Number(row.substantiveCarryoverRatio))
        && Number.isFinite(Number(row.substantiveCarryoverMaximum))
        && Number(row.substantiveCarryoverRatio) > Number(row.substantiveCarryoverMaximum)).length,
      sectionRecoveryAttemptedCount: completedRows.filter(row => Number(row.sectionRecoveryAttemptCount) > 0).length,
      targetOnlyRecoveryAttemptedCount: completedRows.filter(row => Number(row.sectionRecoveryTargetOnlyCount) > 0).length,
      sectionRecoveryAppliedCount: completedRows.filter(row => Number(row.sectionRecoveryAppliedCount) > 0).length,
      sectionRecoveryRejectedDocumentCount: completedRows.filter(row => Number(row.sectionRecoveryRejectedAttemptCount) > 0).length,
      noEffectSecondRecoveryCount: completedRows.filter(row => Number(row.humanizationNoEffectRetryAttemptCount) > 0).length,
      fingerprintIssueCount: completedRows.filter(row => row.fingerprintPass === false).length,
      semanticRelationShiftDocumentCount: completedRows.filter(row => Number(row.semanticRelationShiftCount) > 0).length,
      fingerprintShadowPositiveDocumentCount: completedRows.filter(row => Number(row.fingerprintShadowPositiveCount) > 0).length,
      lexicalTransitionDocumentCount: completedRows.filter(row => Number(row.lexicalTransitionCount) > 0).length,
      quoteIntegrityIssueCount: completedRows.filter(row => row.quoteIntegrityPass === false).length,
      quoteRestoreDocumentCount: completedRows.filter(row => Number(row.quoteIntegrityRestoreCount) > 0).length,
      sourcePreflightChangedCount: completedRows.filter(row => row.sourcePreflightChanged === true).length,
      endingStyleIssueCount: completedRows.filter(row => row.endingStylePass === false).length,
      resumeCoverageIssueCount: completedRows.filter(row => row.resumeCoverageApplicable === true && row.resumeCoveragePass === false).length,
      cleanCount: qualityStatuses.clean || 0,
      needsReviewCount: qualityStatuses.needs_review || 0,
      needsReviewRate: round((qualityStatuses.needs_review || 0) / completedDenominator),
      blockedCount: statuses.blocked || 0,
      blockedRate: round((statuses.blocked || 0) / denominator),
      koreanRefinementFailureCount: safeRows.filter(row => row.koreanRefinementPass === false).length,
      formalRegisterResidualDocumentCount: completedRows.filter(row => Number(row.formalRegisterResidualCount) > 0).length,
      studentRecordFragmentDocumentCount: completedRows.filter(row => Number(row.studentRecordFragmentCount) > 0).length,
      functionalGreetingDuplicationDocumentCount: completedRows.filter(row => Number(row.functionalGreetingDuplicationCount) > 0).length,
      adjacentSemanticRepetitionDocumentCount: completedRows.filter(row => Number(row.adjacentSemanticRepetitionCount) > 0).length,
      naturalnessRiskIncreaseCount: safeRows.filter(row => row.naturalnessRiskIncreased === true).length,
      depthSoftDeliveredCount: safeRows.filter(row => row.humanizationDepthSoftDelivered === true).length,
      noBenefitDeliveredCount: completedRows.filter(row => row.humanizationNoBenefitDelivered === true).length,
      statuses,
      qualityStatuses,
      billingDispositions
    },
    dimensions,
    latestEngine: engineCohorts[0] || null,
    engineCohorts,
    requestedModeDocumentProfileEngineQuality: buildCrossTable(safeRows),
    warningCounts: countCodes(safeRows, 'qualityWarningCodes'),
    effectNoticeCounts: countCodes(safeRows, 'effectNoticeCodes'),
    deliveryReasonCounts: countCodes(safeRows, 'deliveryReasonCodes'),
    sourceReviewWarningCounts: countCodes(safeRows, 'sourceReviewWarningCodes'),
    sourcePreflightIssueCounts: countCodes(safeRows, 'sourcePreflightIssueCodes'),
    fingerprintShadowPositiveCounts: countCodes(safeRows, 'fingerprintShadowPositiveCodes'),
    lexicalTransitionCounts: countCodes(safeRows, 'lexicalTransitionCodes'),
    semanticRelationShiftCounts: countCodes(safeRows, 'semanticRelationShiftFamilies'),
    sectionRecoveryRejectionCounts: countCodes(safeRows, 'sectionRecoveryRejectionCodes'),
    koreanRefinementIssueCounts: countCodes(safeRows, 'koreanRefinementIssueCodes'),
    depthReasonCounts: countCodes(safeRows, 'humanizationDepthReasonCodes'),
    humanizationDepthRetryRejectionCounts: countCodes(safeRows, 'humanizationDepthRetryRejectionCodes'),
    recoveryBudgetSkippedCounts: countCodes(safeRows, 'recoveryBudgetSkippedCodes'),
    metrics,
    recent: safeRows
      .slice()
      .sort((a, b) => (finite(b.createdAtMs) || 0) - (finite(a.createdAtMs) || 0))
      .slice(0, Math.min(Math.max(Math.trunc(finite(options.recentLimit) || 100), 1), 200))
      .map(publicRecentRow)
  };
}

module.exports = {
  METRIC_FIELDS,
  DIMENSION_FIELDS,
  buildHumanizeQualityReport,
  summarizeMetric,
  uniqueCodes
};
