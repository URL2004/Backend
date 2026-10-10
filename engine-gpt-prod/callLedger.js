'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { emptyUsage, addUsage } = require('./usageCost');
const storage = new AsyncLocalStorage();
const observers = new AsyncLocalStorage();
function observe(fn, listener, checkpoint) { return observers.run({ listener, checkpoint }, fn); }
function publish(value) { try { observers.getStore()?.listener?.(value); } catch { /* Accounting is observational. */ } }
function observationSink() {
  const listener = observers.getStore()?.listener;
  return value => { try { listener?.(value); } catch { /* Retain the admitting job context across the worker queue. */ } };
}
const safe = value => String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
function createLedger() { return { entries: [], policy: {}, recoveryBudget: null, layoutMetrics: [], layoutCache: new Map(), layoutFeatures: new Map() }; }
function current() { return storage.getStore(); }
function withPolicy(policy, fn) {
  const parent = current();
  const defined = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
  // A nested audit/section can narrow a deadline, never renew its parent's
  // allowance. Keep the absolute job deadline separately for admission.
  for (const key of ['deadlineMs', 'jobDeadlineMs']) {
    const limit = Math.min(Number(parent?.policy?.[key]) || Infinity, Number(defined[key]) || Infinity);
    if (Number.isFinite(limit)) defined[key] = limit;
  }
  return parent ? storage.run({ ...parent, policy: { ...parent.policy, ...defined } }, fn) : fn();
}
async function run(fn, attach) {
  if (current()) return fn();
  const store = createLedger();
  return require('../engine/textAnalysisCache').withTextAnalysisCache(() => storage.run(store, async () => {
    try { const result = await fn(); attach?.(result, snapshot(store)); return result; }
    catch (error) { error.callLedger = snapshot(store); throw error; }
    finally { publish(snapshot(store)); }
  }));
}
async function track(options, fn) {
  const store = current();
  if (!store) return fn(options);
  const started = Date.now();
  const entry = { id: store.entries.length + 1, stage: safe(store.policy.stage || options.meta?.phase),
    task: safe(options.meta?.task), phase: safe(options.meta?.phase),
    model: safe(options.model), outcome: 'pending', elapsedMs: 0, usage: null, httpAttemptCount: 0,
    mandatoryAudit: store.policy.optional === false && options.meta?.task === 'judge',
    retryCounts: {}, usageKnown: false };
  store.entries.push(entry);
  const endMandatoryAudit = store.policy.optional === false && options.meta?.task === 'judge'
    ? store.recoveryBudget?.beginMandatoryAudit?.() : null;
  const deadline = Math.min(Number(options.deadlineMs) || Infinity, Number(store.policy.deadlineMs) || Infinity,
    Number(store.policy.jobDeadlineMs) || Infinity);
  try {
    const result = await fn({ ...options, ...(Number.isFinite(deadline) ? { deadlineMs: deadline } : {}) });
    Object.assign(entry, { outcome: 'success', usage: result.usage ? { ...result.usage } : null, usageKnown: result.usage != null && !result.unknownUsageCount,
      unknownUsageCount: Number(result.unknownUsageCount || 0), unknownEstimatedUsd: Number(result.unknownEstimatedUsd || 0),
      failedEstimatedUsd: Number(result.failedEstimatedUsd || 0),
      retryCounts: { ...result.retryCounts }, httpAttemptCount: result.httpAttemptCount || 0 });
    recordAdmission(entry, result);
    return result;
  } catch (error) {
    Object.assign(entry, { outcome: error.refusal || error.code === 'OPENAI_REFUSAL' ? 'refused' : 'failed', usage: error.usage ? { ...error.usage } : null,
      usageKnown: Number(error.usage?.totalTokens || 0) > 0 && !error.unknownUsageCount,
      unknownUsageCount: Number(error.unknownUsageCount || 0), unknownEstimatedUsd: Number(error.unknownEstimatedUsd || 0),
      failedEstimatedUsd: Number(error.failedEstimatedUsd || 0),
      code: safe(error.code || error.name), retryCounts: { ...error.retryCounts }, httpAttemptCount: error.httpAttemptCount || 0 });
    recordAdmission(entry, error);
    throw error;
  } finally {
    endMandatoryAudit?.(); entry.elapsedMs = Date.now() - started; Object.freeze(entry);
    try { observers.getStore()?.checkpoint?.(snapshot({ ...store, entries: [entry], layoutMetrics: [] })); } catch { /* Worker observation is best effort. */ }
  }
}
function recordAdmission(entry, result) {
  for (const key of ['windowCompletedCallCount', 'windowOverrunMs', 'windowMaxOverrunMs', 'httpCeilingTimeoutCount'])
    entry[key] = Math.max(0, Number(result[key]) || 0);
  if (result.timeBudget?.protectedCall) {
    entry.maxOutputTokens = result.timeBudget.outputTokens;
    entry.requiredAttemptMs = result.timeBudget.requiredMs;
  }
  if (result.admissionSkipped === true) {
    entry.admissionSkipped = true;
    entry.admissionReason = safe(result.admissionReason);
    entry.remainingAttemptMs = result.remainingAttemptMs ?? null;
  }
}
function snapshot(store = current()) {
  const entries = (store?.entries || []).filter(entry => entry.outcome !== 'pending');
  const executed = entries.filter(entry => entry.httpAttemptCount > 0);
  return { version: 1, modelCallCount: executed.length, notExecutedCallCount: entries.length - executed.length,
    windowCompletedCallCount: entries.reduce((n, e) => n + Number(e.windowCompletedCallCount || 0), 0),
    windowOverrunMs: entries.reduce((n, e) => n + Number(e.windowOverrunMs || 0), 0),
    windowMaxOverrunMs: entries.reduce((n, e) => Math.max(n, Number(e.windowMaxOverrunMs || 0)), 0),
    httpCeilingTimeoutCount: entries.reduce((n, e) => n + Number(e.httpCeilingTimeoutCount || 0), 0),
    admissionSkippedCallCount: entries.filter(entry => entry.admissionSkipped).length,
    admissionSkippedReasonCounts: entries.filter(entry => entry.admissionSkipped).reduce((counts, entry) => {
      counts[entry.admissionReason] = (counts[entry.admissionReason] || 0) + 1; return counts;
    }, {}),
    semanticModelCallCount: executed.filter(entry => entry.task === 'judge').length,
    layout: { callCount: store?.layoutMetrics.length || 0,
      elapsedMs: (store?.layoutMetrics || []).reduce((sum, item) => sum + item.elapsedMs, 0),
      fastPath: (store?.layoutMetrics || []).some(item => item.fastPath),
      limitReached: (store?.layoutMetrics || []).some(item => item.limitReached) },
    httpAttemptCount: entries.reduce((sum, entry) => sum + entry.httpAttemptCount, 0),
    unknownUsageCount: executed.reduce((sum, entry) => sum + (entry.unknownUsageCount || (!entry.usageKnown ? 1 : 0)), 0),
    unknownEstimatedUsd: entries.reduce((sum, entry) => sum + Number(entry.unknownEstimatedUsd || 0), 0),
    failedEstimatedUsd: entries.reduce((sum, entry) => sum + (['failed', 'refused'].includes(entry.outcome)
      ? Number(entry.usage?.estimatedUsd || 0) : Number(entry.failedEstimatedUsd || 0)), 0),
    usage: entries.reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage()),
    modelCost: require('./modelCostSummary').summarize(entries),
    entries: entries.map(entry => ({ ...entry })) };
}
function setRecoveryBudget(budget) { const store = current(); if (store) { store.recoveryBudget = budget; budget?.enableCallAccounting(); } }
module.exports = { current, run, track, snapshot, withPolicy, setRecoveryBudget, observe, publish, observationSink };
