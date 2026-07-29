'use strict';

function normalizedLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0
    ? Math.round(limit * 1000000) / 1000000
    : 0;
}

function createRecoveryBudget(maxEstimatedUsd, { enforced = true } = {}) {
  const limitUsd = normalizedLimit(maxEstimatedUsd);
  let spentUsd = 0;
  let attemptedCallCount = 0;
  let skippedCallCount = 0;
  const skippedCodes = [];
  const stageUsageUsd = {};

  const enabled = enforced === true && limitUsd > 0;
  const canStart = ({ mandatory = false } = {}) => (
    mandatory === true || !enabled || spentUsd < limitUsd
  );
  const recordAttempt = () => {
    attemptedCallCount += 1;
  };
  const recordUsage = (usage, stage = 'unknown') => {
    const usd = Math.max(0, Number(usage?.estimatedUsd) || 0);
    if (!usd) return spentUsd;
    spentUsd = roundedUsd(spentUsd + usd);
    const key = safeStage(stage);
    stageUsageUsd[key] = roundedUsd(Number(stageUsageUsd[key] || 0) + usd);
    return spentUsd;
  };
  const recordSkip = code => {
    skippedCallCount += 1;
    const safeCode = safeStage(code || 'recovery_budget_exhausted');
    if (!skippedCodes.includes(safeCode)) skippedCodes.push(safeCode);
  };
  const snapshot = () => ({
    enabled,
    enforced: enabled,
    limitUsd,
    spentUsd,
    exhausted: enabled && spentUsd >= limitUsd,
    attemptedCallCount,
    skippedCallCount,
    skippedCodes: skippedCodes.slice(),
    stageUsageUsd: { ...stageUsageUsd }
  });

  return {
    canStart,
    recordAttempt,
    recordUsage,
    recordSkip,
    snapshot
  };
}

function roundedUsd(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function safeStage(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .slice(0, 80) || 'unknown';
}

module.exports = {
  createRecoveryBudget,
  normalizedLimit
};
