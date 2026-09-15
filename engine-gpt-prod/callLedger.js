'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { emptyUsage, addUsage } = require('./usageCost');
const storage = new AsyncLocalStorage();
const safe = value => String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
function createLedger() { return { entries: [], policy: {}, recoveryBudget: null, layoutMetrics: [], layoutCache: new Map(), layoutFeatures: new Map() }; }
function current() { return storage.getStore(); }
function withPolicy(policy, fn) {
  const parent = current();
  const defined = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
  return parent ? storage.run({ ...parent, policy: { ...parent.policy, ...defined } }, fn) : fn();
}
async function run(fn, attach) {
  if (current()) return fn();
  const store = createLedger();
  return storage.run(store, async () => {
    try { const result = await fn(); attach?.(result, snapshot(store)); return result; }
    catch (error) { error.callLedger = snapshot(store); throw error; }
  });
}
async function track(options, fn) {
  const store = current();
  if (!store) return fn(options);
  const started = Date.now();
  const entry = { id: store.entries.length + 1, stage: safe(store.policy.stage || options.meta?.phase),
    task: safe(options.meta?.task), phase: safe(options.meta?.phase),
    model: safe(options.model), outcome: 'pending', elapsedMs: 0, usage: null, httpAttemptCount: 0,
    retryCounts: {}, usageKnown: false };
  store.entries.push(entry);
  const deadline = Math.min(Number(options.deadlineMs) || Infinity, Number(store.policy.deadlineMs) || Infinity);
  try {
    const result = await fn({ ...options, ...(Number.isFinite(deadline) ? { deadlineMs: deadline } : {}) });
    Object.assign(entry, { outcome: 'success', usage: result.usage ? { ...result.usage } : null, usageKnown: result.usage != null && !result.unknownUsageCount,
      unknownUsageCount: Number(result.unknownUsageCount || 0), unknownEstimatedUsd: Number(result.unknownEstimatedUsd || 0),
      failedEstimatedUsd: Number(result.failedEstimatedUsd || 0),
      retryCounts: { ...result.retryCounts }, httpAttemptCount: result.httpAttemptCount || 0 });
    return result;
  } catch (error) {
    Object.assign(entry, { outcome: error.refusal || error.code === 'OPENAI_REFUSAL' ? 'refused' : 'failed', usage: error.usage ? { ...error.usage } : null,
      usageKnown: Number(error.usage?.totalTokens || 0) > 0 && !error.unknownUsageCount,
      unknownUsageCount: Number(error.unknownUsageCount || 0), unknownEstimatedUsd: Number(error.unknownEstimatedUsd || 0),
      failedEstimatedUsd: Number(error.failedEstimatedUsd || 0),
      code: safe(error.code || error.name), retryCounts: { ...error.retryCounts }, httpAttemptCount: error.httpAttemptCount || 0 });
    throw error;
  } finally { entry.elapsedMs = Date.now() - started; Object.freeze(entry); }
}
function snapshot(store = current()) {
  const entries = (store?.entries || []).filter(entry => entry.outcome !== 'pending');
  const executed = entries.filter(entry => entry.httpAttemptCount > 0);
  return { version: 1, modelCallCount: executed.length, notExecutedCallCount: entries.length - executed.length,
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
    entries: entries.map(entry => ({ ...entry })) };
}
function setRecoveryBudget(budget) { const store = current(); if (store) { store.recoveryBudget = budget; budget?.enableCallAccounting(); } }
module.exports = { current, run, track, snapshot, withPolicy, setRecoveryBudget };
