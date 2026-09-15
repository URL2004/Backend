'use strict';

function normalizedLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0
    ? Math.round(limit * 1000000) / 1000000
    : 0;
}

function createRecoveryBudget(maxEstimatedUsd, {
  enforced = true,
  maxCalls = Number(process.env.HUMANIZE_RECOVERY_MAX_CALLS) || 16,
  reservedLateCalls = Number(process.env.HUMANIZE_RECOVERY_RESERVED_LATE_CALLS) || 6,
  maxElapsedMs = Number(process.env.HUMANIZE_RECOVERY_MAX_ELAPSED_MS) || 240000,
  jobDeadlineMs = Infinity,
  clock = Date.now
} = {}) {
  const limitUsd = normalizedLimit(maxEstimatedUsd);
  let spentUsd = 0;
  let reservedUsd = 0;
  let unknownUsageUsd = 0;
  let automaticCalls = false;
  let sequence = 0;
  const reservations = new Map();
  let attemptedCallCount = 0;
  let skippedCallCount = 0;
  const skippedCodes = [];
  const stageUsageUsd = {};
  const initialNow = Number(clock());
  const startedAt = Number.isFinite(initialNow) ? initialNow : Date.now();
  const absoluteCallLimit = Math.max(1, Math.min(64, Math.floor(Number(maxCalls) || 16)));
  const lateCallReserve = Math.max(
    0,
    Math.min(absoluteCallLimit - 1, Math.floor(Number(reservedLateCalls) || 0))
  );
  const absoluteElapsedLimitMs = Math.max(30000, Math.min(900000, Math.floor(Number(maxElapsedMs) || 240000)));
  let lastDeniedReason = '';

  const enabled = enforced === true && limitUsd > 0;
  const elapsedMs = () => {
    const current = Number(clock());
    return Math.max(0, (Number.isFinite(current) ? current : Date.now()) - startedAt);
  };
  const denialReason = ({ mandatory = false, priority = 'normal', estimatedUsd = 0 } = {}) => {
    if (attemptedCallCount >= absoluteCallLimit) return 'recovery_call_limit_exhausted';
    if (elapsedMs() >= absoluteElapsedLimitMs) return 'recovery_time_limit_exhausted';
    // Optional work must leave time for both its own response (up to 120s)
    // and the mandatory final verdict (up to 120s). This is admission, not
    // an extension of the existing job deadline or a new delivery gate.
    if (mandatory !== true && enforced === true && Number(clock()) + 240000 > jobDeadlineMs) {
      return 'recovery_final_audit_time_reserved';
    }
    const latePriority = mandatory === true || String(priority || '').toLowerCase() === 'late';
    if (!latePriority && lateCallReserve > 0
        && attemptedCallCount >= absoluteCallLimit - lateCallReserve) {
      return 'recovery_late_call_reserve';
    }
    if (mandatory !== true && enabled && (spentUsd + reservedUsd + unknownUsageUsd >= limitUsd
        || spentUsd + reservedUsd + unknownUsageUsd + Math.max(0, Number(estimatedUsd) || 0) > limitUsd)) return 'recovery_budget_exhausted';
    return '';
  };
  const canStart = options => !denialReason(options);
  const tryStart = (options = {}) => {
    const denied = denialReason(options);
    if (denied) {
      lastDeniedReason = denied;
      return false;
    }
    if (!automaticCalls) attemptedCallCount += 1;
    lastDeniedReason = '';
    return true;
  };
  const recordAttempt = () => {
    attemptedCallCount += 1;
  };
  const recordUsage = (usage, stage = 'unknown', internal = false) => {
    if (automaticCalls && !internal) return spentUsd;
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
    reservedUsd,
    unknownUsageUsd,
    exhausted: enabled && spentUsd + reservedUsd + unknownUsageUsd >= limitUsd,
    absoluteCallLimit,
    lateCallReserve,
    absoluteElapsedLimitMs,
    elapsedMs: elapsedMs(),
    callLimitExhausted: attemptedCallCount >= absoluteCallLimit,
    timeLimitExhausted: elapsedMs() >= absoluteElapsedLimitMs,
    lastDeniedReason,
    attemptedCallCount,
    skippedCallCount,
    skippedCodes: skippedCodes.slice(),
    stageUsageUsd: { ...stageUsageUsd }
  });

  return {
    deadlineMs: () => Math.min(startedAt + absoluteElapsedLimitMs,
      enforced === true ? jobDeadlineMs - 120000 : Infinity),
    enableCallAccounting: () => { automaticCalls = true; },
    reserveCall: (estimatedUsd, options = {}) => {
      const amount = Math.ceil(Math.max(0, Number(estimatedUsd) || 0) * 1000000) / 1000000;
      const denied = denialReason({ ...options, estimatedUsd: amount });
      if (denied) { lastDeniedReason = denied; recordSkip(denied); return null; }
      const id = ++sequence;
      reservations.set(id, { amount, stage: options.stage || 'unknown' });
      reservedUsd = roundedUsd(reservedUsd + amount);
      attemptedCallCount++;
      return id;
    },
    settleCall: (id, usage) => {
      const reservation = reservations.get(id);
      if (!reservation) return false;
      reservations.delete(id);
      reservedUsd = Math.max(0, roundedUsd(reservedUsd - reservation.amount));
      if (usage == null) unknownUsageUsd = roundedUsd(unknownUsageUsd + reservation.amount);
      else recordUsage(usage, reservation.stage, true);
      return true;
    },
    canStart,
    tryStart,
    denialReason,
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
