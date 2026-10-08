'use strict';

// Operational evidence only. Never used to decide billing, score, retries or delivery.
const { sanitize } = require('../engine-gpt-prod/modelCostSummary');
const TERMINAL = new Set(['done', 'blocked', 'error', 'cancelled']);
const STATUSES = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_payment', ...TERMINAL]);
const code = value => /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value || '') ? value : 'unknown';
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;

function traceOf(job) {
  if (job.attemptTrace?.version !== 1) job.attemptTrace = { version: 1, sequence: 0, attempts: [], transitions: [] };
  return job.attemptTrace;
}
function observeStatus(job, now = Date.now()) {
  const trace = traceOf(job);
  const status = STATUSES.has(job.status) ? job.status : 'unknown';
  if (trace.lastStatus !== status) {
    trace.transitions = [...trace.transitions, { status, atMs: now, attempt: trace.sequence }].slice(-64);
    trace.lastStatus = status;
  }
  trace.userCharge = {
    state: job.deducted === true ? 'committed' : TERMINAL.has(status) ? 'not_committed' : 'pending',
    unit: job.billingMode === 'coupon' ? 'coupon' : 'credit',
    // Do not claim a refund/cost offset by converting credits into USD.
    disposition: code(job.billingDisposition || job.result?.billingDisposition || 'unknown')
  };
  return trace;
}
function begin(job, feature = 'main', now = Date.now()) {
  const trace = observeStatus(job, now);
  const id = ++trace.sequence;
  const queued = [...trace.transitions].reverse().find(item => item.status === 'queued');
  const queuedAtMs = queued?.atMs ?? finite(job.queuedAt);
  const row = { id, feature: code(feature), event: id === 1 ? 'start' : 'resume', startedAtMs: now,
    queuedAtMs, queueWaitMs: queuedAtMs === null ? null : Math.max(0, now - queuedAtMs),
    outcome: 'running', providerAbort: 'not_observed', costCoverage: 'unknown',
    modelCost: { knownUsd: 0, unknownReservedUsd: 0, mandatoryAuditUsd: 0, stages: [] } };
  trace.attempts = [...trace.attempts, row].slice(-32);
  return id;
}
function capture(job, id, ledger) {
  const row = traceOf(job).attempts.find(item => item.id === id);
  if (!row || !ledger) return;
  const modelCost = sanitize(ledger.modelCost);
  if (modelCost) {
    const round = n => Math.round(n * 1e6) / 1e6;
    const trace = traceOf(job);
    trace.observedLedgers = (trace.observedLedgers || 0) + 1;
    for (const key of ['knownUsd', 'unknownReservedUsd', 'mandatoryAuditUsd']) {
      row.modelCost[key] = round(row.modelCost[key] + modelCost[key]);
      trace[key] = round((trace[key] || 0) + modelCost[key]);
    }
    for (const stage of modelCost.stages) {
      const key = row.modelCost.stages.some(item => item.stage === stage.stage) || row.modelCost.stages.length < 39 ? stage.stage : 'other_stages';
      let target = row.modelCost.stages.find(item => item.stage === key);
      if (!target) { target = { stage: key, calls: 0, httpAttempts: 0, knownUsd: 0, unknownReservedUsd: 0 }; row.modelCost.stages.push(target); }
      for (const field of ['calls', 'httpAttempts', 'knownUsd', 'unknownReservedUsd']) target[field] = round(target[field] + stage[field]);
    }
  }
  row.costCoverage = 'observed_ledgers_only';
  row.logicalCalls = (row.logicalCalls || 0) + Math.max(0, Number(ledger.modelCallCount) || 0);
  row.httpAttempts = (row.httpAttempts || 0) + Math.max(0, Number(ledger.httpAttemptCount) || 0);
  if ((ledger.entries || []).some(entry => /abort|cancel/i.test(entry.code || ''))) row.providerAbort = 'client_abort_observed';
}
function finish(job, id, { aborted = false, reason = null, now = Date.now() } = {}) {
  const trace = observeStatus(job, now);
  const row = trace.attempts.find(item => item.id === id);
  if (!row) return;
  row.finishedAtMs = now;
  row.executionWallMs = Math.max(0, now - row.startedAtMs);
  row.outcome = trace.lastStatus;
  row.abortRequested = aborted;
  if (aborted) row.abortReason = code(reason);
  // An AbortSignal proves a request, not that a provider stopped charging.
}
function summary(job) {
  const trace = job.attemptTrace;
  if (!trace || trace.version !== 1) return { version: 1, observed: false, outcome: outcome(job) };
  const round = n => Math.round(n * 1e6) / 1e6;
  const observedCost = trace.observedLedgers > 0;
  const knownUsd = observedCost ? round(trace.knownUsd || 0) : null;
  return { version: 1, observed: true, outcome: outcome(job), attemptCount: trace.sequence,
    retainedAttemptCount: trace.attempts.length, truncated: trace.sequence > trace.attempts.length,
    userCharge: trace.userCharge || null, knownUsd, unknownReservedUsd: observedCost ? round(trace.unknownReservedUsd || 0) : null,
    mandatoryAuditUsd: observedCost ? round(trace.mandatoryAuditUsd || 0) : null,
    costCoverage: observedCost ? 'observed_ledgers_only' : 'unknown',
    // Company-paid model cost on an uncharged terminal job, not profit/loss or credit refunds.
    unchargedKnownUsd: TERMINAL.has(job.status) && job.deducted !== true ? knownUsd : null,
    attempts: trace.attempts, transitions: trace.transitions };
}
function outcome(job) {
  if (job.status === 'done') return job.structurePreview === true ? 'preview_completed' : 'transform_completed';
  return TERMINAL.has(job.status) ? job.status : 'unfinished';
}
module.exports = { begin, capture, finish, observeStatus, summary };
