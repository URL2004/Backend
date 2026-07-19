'use strict';

const METRIC_FIELDS = Object.freeze([
  'substantiveEditRatio',
  'substantiveChangedSentenceRatio',
  'substantiveCarryoverRatio',
  'humanizationTargetCoverage',
  'structuralChangedSentenceRatio',
  'rhetoricalRemediationCoverage',
  'sectionRecoveryAttemptCount',
  'sectionRecoveryAppliedCount',
  'sectionRecoveryEscalationCount',
  'fingerprintIntroducedCount',
  'fingerprintRepairCount',
  'endingStyleIntroducedOtherCount',
  'resumeCoverageRatio',
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
  'qualityStatus',
  'humanizationDeliveryDepthBand',
  'billingDisposition',
  'effectExpectation'
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
    'billingDisposition', 'effectExpectation', 'effectNoticeCode',
    'processingDurationMs', 'totalDurationMs',
    'textLength', 'resultLength', 'engineVersion', 'requestedMode', 'effectiveMode',
    'requestStrength', 'documentProfile', 'profileConfidence', 'profileDecisionSource',
    'detectedDocumentProfile', 'detectedProfileConfidence', 'requestedDocumentProfile',
    'profileOverrideApplied', 'profileOverrideIgnoredReason',
    'qualityStatus', 'humanizationDepthApplicable', 'humanizationDepthPass',
    'humanizationMinimumEffectPass', 'humanizationDeliveryDepthBand', 'substantiveEditRatio',
    'substantiveChangedSentenceRatio', 'humanizationTargetCoverage',
    'substantiveCarryoverCount', 'substantiveCarryoverRatio',
    'substantiveCarryoverEligibleSentenceCount', 'substantiveCarryoverMaximum',
    'structuralChangedSentenceRatio', 'rhetoricalRemediationCoverage',
    'sectionRecoveryEnabled', 'sectionRecoveryAttemptCount', 'sectionRecoveryAppliedCount',
    'sectionRecoveryEscalationCount', 'fingerprintPass', 'fingerprintIntroducedCount',
    'fingerprintRepairCount', 'endingStylePass', 'endingStyleIssueCount',
    'endingStyleIntroducedOtherCount', 'resumeCoverageApplicable', 'resumeCoveragePass',
    'resumeClaimCount', 'resumeCoveredClaimCount', 'resumeCoverageRatio',
    'koreanRefinementPass', 'naturalnessRiskIncreased', 'naturalnessOverallRiskDelta',
    'rhythmUniformityDelta', 'lengthRatio', 'estimatedUsd'
  ];
  const out = {};
  for (const field of fields) {
    if (row?.[field] !== undefined && row[field] !== null) out[field] = row[field];
  }
  out.qualityWarningCodes = uniqueCodes(row?.qualityWarningCodes);
  out.sourceReviewWarningCodes = uniqueCodes(row?.sourceReviewWarningCodes);
  out.koreanRefinementIssueCodes = uniqueCodes(row?.koreanRefinementIssueCodes);
  out.humanizationDepthReasonCodes = uniqueCodes(row?.humanizationDepthReasonCodes);
  out.fingerprintIssueCodes = uniqueCodes(row?.fingerprintIssueCodes);
  return out;
}

function buildHumanizeQualityReport(rows, options = {}) {
  const safeRows = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object');
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
  const qualityWaivedCount = completedRows.filter(row => row.billingDisposition === 'waived_quality_shortfall').length;
  const repeatWaivedCount = completedRows.filter(row => row.billingDisposition === 'waived_repeat_low_benefit').length;
  const waivedCount = qualityWaivedCount + repeatWaivedCount;
  const metrics = Object.fromEntries(METRIC_FIELDS.map(field => [field, summarizeMetric(safeRows, field)]));
  const dimensions = Object.fromEntries(DIMENSION_FIELDS.map(field => [field, countRows(safeRows, field)]));

  return {
    schemaVersion: 2,
    generatedAtMs,
    window: { hours, sinceMs, rowCount: safeRows.length },
    summary: {
      total: safeRows.length,
      completedCount: completedRows.length,
      chargedCount: safeRows.filter(row => row.deducted === true).length,
      qualityWaivedCount,
      repeatWaivedCount,
      waivedCount,
      waivedRate: round(waivedCount / completedDenominator),
      limitedEffectCount: completedRows.filter(row => row.effectExpectation === 'limited').length,
      depthApplicableCount: depthApplicableRows.length,
      depthBelowMinimumCount,
      depthBelowMinimumRate: round(depthBelowMinimumCount / depthDenominator),
      carryoverOverLimitCount: completedRows.filter(row => Number.isFinite(Number(row.substantiveCarryoverRatio))
        && Number.isFinite(Number(row.substantiveCarryoverMaximum))
        && Number(row.substantiveCarryoverRatio) > Number(row.substantiveCarryoverMaximum)).length,
      sectionRecoveryAttemptedCount: completedRows.filter(row => Number(row.sectionRecoveryAttemptCount) > 0).length,
      sectionRecoveryAppliedCount: completedRows.filter(row => Number(row.sectionRecoveryAppliedCount) > 0).length,
      fingerprintIssueCount: completedRows.filter(row => row.fingerprintPass === false).length,
      endingStyleIssueCount: completedRows.filter(row => row.endingStylePass === false).length,
      resumeCoverageIssueCount: completedRows.filter(row => row.resumeCoverageApplicable === true && row.resumeCoveragePass === false).length,
      cleanCount: qualityStatuses.clean || 0,
      needsReviewCount: qualityStatuses.needs_review || 0,
      needsReviewRate: round((qualityStatuses.needs_review || 0) / completedDenominator),
      blockedCount: statuses.blocked || 0,
      blockedRate: round((statuses.blocked || 0) / denominator),
      koreanRefinementFailureCount: safeRows.filter(row => row.koreanRefinementPass === false).length,
      naturalnessRiskIncreaseCount: safeRows.filter(row => row.naturalnessRiskIncreased === true).length,
      depthSoftDeliveredCount: safeRows.filter(row => row.humanizationDepthSoftDelivered === true).length,
      statuses,
      qualityStatuses,
      billingDispositions
    },
    dimensions,
    requestedModeDocumentProfileEngineQuality: buildCrossTable(safeRows),
    warningCounts: countCodes(safeRows, 'qualityWarningCodes'),
    sourceReviewWarningCounts: countCodes(safeRows, 'sourceReviewWarningCodes'),
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
