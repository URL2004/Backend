'use strict';

// Request-scoped lifecycle for writing-lab model chains (generate / check /
// finalize): one call ledger per request, an absolute deadline propagated to
// every provider call, cancellation reasons the engine can act on, and a
// sanitized cost/call summary that never contains user text or provider
// messages.

const callLedger = require('../engine-gpt-prod/callLedger');

const ABORT_CODES = Object.freeze({
  DEADLINE: 'WRITING_JOB_DEADLINE',
  LEASE_LOST: 'WRITING_JOB_LEASE_LOST',
  CANCELLED: 'WRITING_REQUEST_CANCELLED'
});

function boundedMs(value, fallback, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) && number > 0 ? number : fallback));
}

// Generation must finish (including billing and persistence) before the job
// lease can be taken over; finalize/check are synchronous requests.
const GENERATE_DEADLINE_MS = boundedMs(process.env.WRITING_LAB_GENERATE_DEADLINE_MS, 8 * 60 * 1000, 120000, 9 * 60 * 1000);
const FINALIZE_DEADLINE_MS = boundedMs(process.env.WRITING_LAB_FINALIZE_DEADLINE_MS, 6 * 60 * 1000, 60000, 9 * 60 * 1000);
const CHECK_DEADLINE_MS = boundedMs(process.env.WRITING_LAB_CHECK_DEADLINE_MS, 5 * 60 * 1000, 60000, 9 * 60 * 1000);

function abortError(code, message) {
  return Object.assign(new Error(message || code), { code, name: 'AbortError' });
}

function abortCode(signal) {
  if (!signal?.aborted) return '';
  const code = String(signal.reason?.code || '');
  return Object.values(ABORT_CODES).includes(code) ? code : ABORT_CODES.CANCELLED;
}

/**
 * Runs fn inside a fresh call ledger and absolute deadline. Returns
 * { result, cost } on success; on failure the thrown error carries
 * error.writingCost (sanitized) for telemetry/job storage.
 */
async function runMeasured(kind, fn, { deadlineAtMs } = {}) {
  const startedAt = Date.now();
  let snapshot = null;
  const policy = { ...(Number.isFinite(deadlineAtMs) ? { jobDeadlineMs: deadlineAtMs } : {}) };
  try {
    const result = await callLedger.run(() => callLedger.withPolicy(policy, fn), (_value, value) => { snapshot = value; });
    return { result, cost: costSummary(kind, snapshot, Date.now() - startedAt) };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.writingCost = costSummary(kind, error.callLedger || snapshot, Date.now() - startedAt);
      delete error.callLedger;
    }
    throw error;
  }
}

const COST_KINDS = ['generate', 'check', 'finalize'];
const RETRY_KEYS = ['rateLimit', 'server', 'network', 'timeout', 'schema', 'truncation'];
const round = value => Math.round((Number(value) || 0) * 1e6) / 1e6;
const count = value => Math.max(0, Math.floor(Number(value) || 0));
const code = value => (/^[a-zA-Z0-9_.:-]{1,80}$/u.test(String(value || '')) ? String(value) : 'unknown');

function costSummary(kind, snapshot, elapsedMs = 0) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const retryCounts = Object.fromEntries(RETRY_KEYS.map(key => [key, 0]));
  const phases = new Map();
  for (const entry of entries) {
    for (const key of RETRY_KEYS) retryCounts[key] += count(entry.retryCounts?.[key]);
    const phase = code(entry.phase);
    const row = phases.get(phase) || { phase, calls: 0, httpAttempts: 0, failed: 0, knownUsd: 0, unknownReservedUsd: 0 };
    row.calls += count(entry.httpAttemptCount) > 0 ? 1 : 0;
    row.httpAttempts += count(entry.httpAttemptCount);
    row.failed += entry.outcome === 'failed' || entry.outcome === 'refused' ? 1 : 0;
    row.knownUsd = round(row.knownUsd + Number(entry.usage?.estimatedUsd || 0));
    row.unknownReservedUsd = round(row.unknownReservedUsd + Number(entry.unknownEstimatedUsd || 0));
    phases.set(phase, row);
  }
  const usage = snapshot?.usage || {};
  return {
    version: 'writing-cost-v1',
    kind: COST_KINDS.includes(kind) ? kind : 'unknown',
    elapsedMs: count(elapsedMs),
    logicalCallCount: entries.length,
    modelCallCount: count(snapshot?.modelCallCount),
    notExecutedCallCount: count(snapshot?.notExecutedCallCount),
    failedCallCount: entries.filter(entry => entry.outcome === 'failed' || entry.outcome === 'refused').length,
    httpAttemptCount: count(snapshot?.httpAttemptCount),
    retryCount: RETRY_KEYS.reduce((sum, key) => sum + retryCounts[key], 0),
    retryCounts,
    semanticModelCallCount: count(snapshot?.semanticModelCallCount),
    admissionSkippedCallCount: count(snapshot?.admissionSkippedCallCount),
    // Per physical send: a proven provider rejection settles at zero and is
    // not unknown, unlike the shared snapshot's per-call fallback count.
    unknownUsageCount: entries.reduce((sum, entry) => sum + count(entry.unknownUsageCount), 0),
    knownUsd: round(snapshot?.modelCost?.knownUsd ?? usage.estimatedUsd),
    unknownReservedUsd: round(snapshot?.modelCost?.unknownReservedUsd ?? snapshot?.unknownEstimatedUsd),
    failedEstimatedUsd: round(snapshot?.failedEstimatedUsd),
    tokens: {
      input: count(usage.inputTokens),
      cachedInput: count(usage.cachedInputTokens),
      output: count(usage.outputTokens),
      reasoning: count(usage.reasoningTokens)
    },
    phases: [...phases.values()].slice(0, 40)
  };
}

/**
 * Cancellation for a synchronous request: abort remaining model calls when
 * the client disconnects before the response is written, or at the deadline.
 */
function requestScope(res, { deadlineMs, now = Date.now() } = {}) {
  const controller = new AbortController();
  const deadlineAtMs = now + deadlineMs;
  const timer = setTimeout(() => controller.abort(abortError(ABORT_CODES.DEADLINE, 'Writing request deadline reached')), Math.max(1, deadlineMs));
  timer.unref?.();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(abortError(ABORT_CODES.CANCELLED, 'Client disconnected'));
  };
  res?.on?.('close', onClose);
  return {
    signal: controller.signal,
    deadlineAtMs,
    stop() {
      clearTimeout(timer);
      res?.off?.('close', onClose);
    }
  };
}

const LEASE_HEARTBEAT_MS = 30 * 1000;
// Stop this long before the last confirmed lease expiry so a takeover can
// never overlap a still-running owner, even when renewals cannot be stored.
const LEASE_GUARD_MS = 10 * 1000;
const LEASE_RENEW_TIMEOUT_MS = 10 * 1000;

function leaseLostError() {
  return Object.assign(new Error('WRITING_JOB_LEASE_LOST'), { code: ABORT_CODES.LEASE_LOST, status: 409 });
}

function settleWithin(operation, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('WRITING_STORAGE_TIMEOUT'), {
      code: 'WRITING_STORAGE_TIMEOUT', status: 503
    })), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Keeps a durable generate job's processing lease while its owner works.
 * The returned signal aborts on the absolute deadline (DEADLINE) or when the
 * lease is refused/expires locally (LEASE_LOST). A client disconnect does not
 * cancel: the job is durable and recoverable by requestId.
 */
function createJobLease({
  store, uid, requestId, inputHash, leaseId, leaseExpiresAtMs, deadlineAtMs,
  heartbeatMs = LEASE_HEARTBEAT_MS, guardMs = LEASE_GUARD_MS,
  renewTimeoutMs = LEASE_RENEW_TIMEOUT_MS, clock = Date.now
}) {
  const controller = new AbortController();
  let confirmedUntilMs = Number(leaseExpiresAtMs) || 0;
  let lostReason = '';
  let stopped = false;
  let expiryTimer = null;
  let renewalGeneration = 0;
  let resolveLost;
  const ownershipLost = new Promise(resolve => { resolveLost = resolve; });
  const lose = reason => {
    if (!lostReason) lostReason = reason;
    renewalGeneration += 1;
    resolveLost();
    if (!controller.signal.aborted) controller.abort(abortError(ABORT_CODES.LEASE_LOST, `Writing job lease ${reason}`));
  };
  const armExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => lose('local_expiry'), Math.max(1, confirmedUntilMs - guardMs - clock()));
    expiryTimer.unref?.();
  };
  armExpiry();
  const deadlineTimer = Number.isFinite(deadlineAtMs)
    ? setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(abortError(ABORT_CODES.DEADLINE, 'Writing job deadline reached'));
    }, Math.max(1, deadlineAtMs - clock()))
    : null;
  deadlineTimer?.unref?.();
  let pending = null;
  const renewOnce = async () => {
    if (lostReason || stopped) return { ok: false, reason: lostReason || 'stopped' };
    const generation = ++renewalGeneration;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'RENEW_TIMEOUT' }),
        Math.max(1, Math.min(renewTimeoutMs, confirmedUntilMs - guardMs - clock())));
      timer.unref?.();
    });
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => store.renew(uid, requestId, inputHash, leaseId, clock()))
          .catch(() => ({ ok: false, reason: 'UNAVAILABLE' })),
        timeout,
        ownershipLost.then(() => ({ ok: false, reason: lostReason || 'stopped' }))
      ]);
    } finally { clearTimeout(timer); }
    // A timed-out/stopped renewal may still commit remotely. It can never
    // authorize this local owner again, even if its late response is successful.
    if (stopped || lostReason || generation !== renewalGeneration) return { ok: false, reason: lostReason || 'stopped' };
    if (clock() >= confirmedUntilMs - guardMs) {
      lose('local_expiry');
      return { ok: false, reason: lostReason };
    }
    if (result?.ok) {
      confirmedUntilMs = Number(result.leaseExpiresAtMs) || confirmedUntilMs;
      if (!stopped) armExpiry();
    } else if (result?.reason !== 'UNAVAILABLE') {
      lose(String(result?.reason || 'LEASE_LOST').toLowerCase());
    }
    return result || { ok: false, reason: 'UNAVAILABLE' };
  };
  const renew = () => {
    pending ||= renewOnce().finally(() => { pending = null; });
    return pending;
  };
  const interval = setInterval(() => { if (!stopped) void renew(); }, heartbeatMs);
  interval.unref?.();
  return {
    signal: controller.signal,
    leaseId,
    deadlineAtMs,
    lostReason: () => lostReason,
    // Stop awaiting uncooperative storage/credit RPCs when local ownership
    // ends. Their late effects remain fenced by the durable transaction token.
    async waitFor(operation) {
      if (stopped || lostReason) throw leaseLostError();
      return Promise.race([
        Promise.resolve().then(operation),
        ownershipLost.then(() => { throw leaseLostError(); })
      ]);
    },
    // Fence before a side effect (billing, persistence). An unreachable store
    // is tolerated only while the last confirmed lease is still valid.
    async assertOwned() {
      if (stopped || lostReason) throw leaseLostError();
      const result = await Promise.race([
        renew(),
        ownershipLost.then(() => { throw leaseLostError(); })
      ]);
      if (lostReason || (!result.ok && clock() >= confirmedUntilMs - guardMs)) {
        if (!lostReason) lose('unconfirmed');
        throw leaseLostError();
      }
      return true;
    },
    stop() {
      stopped = true;
      renewalGeneration += 1;
      resolveLost();
      clearInterval(interval);
      clearTimeout(expiryTimer);
      clearTimeout(deadlineTimer);
    }
  };
}

module.exports = {
  LEASE_HEARTBEAT_MS,
  LEASE_GUARD_MS,
  LEASE_RENEW_TIMEOUT_MS,
  settleWithin,
  createJobLease,
  ABORT_CODES,
  GENERATE_DEADLINE_MS,
  FINALIZE_DEADLINE_MS,
  CHECK_DEADLINE_MS,
  abortError,
  abortCode,
  runMeasured,
  costSummary,
  requestScope
};
