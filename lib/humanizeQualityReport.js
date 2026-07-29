'use strict';

const METRIC_FIELDS = Object.freeze([
  'substantiveEditRatio',
  'substantiveChangedSentenceRatio',
  'substantiveCarryoverRatio',
  'humanizationTargetCoverage',
  'humanizationTargetDepthGap',
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
  'deliveryDecision'
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
    'humanizationNoEffectRetryAttemptCount',
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
  out.sourceReviewWarningCodes = uniqueCodes(row?.sourceReviewWarningCodes);
  out.koreanRefinementIssueCodes = uniqueCodes(row?.koreanRefinementIssueCodes);
  out.humanizationDepthReasonCodes = uniqueCodes(row?.humanizationDepthReasonCodes);
  out.fingerprintIssueCodes = uniqueCodes(row?.fingerprintIssueCodes);
  out.semanticRelationShiftFamilies = uniqueCodes(row?.semanticRelationShiftFamilies);
  out.fingerprintShadowPositiveCodes = uniqueCodes(row?.fingerprintShadowPositiveCodes);
  out.lexicalTransitionCodes = uniqueCodes(row?.lexicalTransitionCodes);
  out.sectionRecoveryRejectionCodes = uniqueCodes(row?.sectionRecoveryRejectionCodes);
  out.sourcePreflightIssueCodes = uniqueCodes(row?.sourcePreflightIssueCodes);
  return out;
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
  const qualityWaivedCount = completedRows.filter(row => row.billingDisposition === 'waived_quality_shortfall').length;
  const repeatWaivedCount = completedRows.filter(row => row.billingDisposition === 'waived_repeat_low_benefit').length;
  const waivedCount = qualityWaivedCount + repeatWaivedCount;
  const metrics = Object.fromEntries(METRIC_FIELDS.map(field => [field, summarizeMetric(safeRows, field)]));
  const dimensions = Object.fromEntries(DIMENSION_FIELDS.map(field => [field, countRows(safeRows, field)]));

  return {
    schemaVersion: 3,
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
