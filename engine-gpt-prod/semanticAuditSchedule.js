'use strict';
function planVerdictPairs(source, output, pairs, allowRepair = true) {
  if (allowRepair !== false || pairs.length <= 2
      || Math.max(source.length, output.length) > 12000
      || !pairs.every(p => p.alignment === 'shared_unique_heading')) return pairs;
  // A three-section queue leaves its last request only the remainder of the
  // same final deadline. Two complete heading-owned windows can start together.
  // Never invent a cut, cross uncertain ownership or exceed the ordinary
  // 6,000-character whole-document envelope already used by the audit.
  const balanced = require('./reviewAlignment').alignedReviewPairs(source, output, 6000);
  return balanced.length === 2
    && balanced.every(p => p.alignment === 'shared_unique_heading'
      && Math.max(p.sourceContext.length, p.output.length) <= 6000)
    && balanced.map(p => p.sourceContext).join('') === source
    && balanced.map(p => p.output).join('') === output ? balanced : pairs;
}
function scheduleReviewPairs(pairs, allowRepair = true) {
  const rows = pairs.map((pair, index) => ({ pair, index }));
  return allowRepair === false ? rows.sort((a, b) =>
    (b.pair.sourceContext.length + b.pair.output.length)
      - (a.pair.sourceContext.length + a.pair.output.length) || a.index - b.index) : rows;
}
// Scheduling diagnostics: numbers and fixed codes only. It never holds text,
// findings, prompts or model output, and it never changes a verdict. Its use is
// to show where a section audit's deadline went: queueing, request size,
// receipt misses or an abort.
const SCHEDULE_DIAGNOSTICS_VERSION = 'semantic-schedule-diagnostics-v1';
const PLAN_KINDS = new Set(['single', 'base_heading', 'balanced_heading', 'receipt_base', 'whole_fallback']);
const OUTCOMES = new Set(['receipt_reused', 'cancelled_before_start', 'pass', 'fail', 'uncertain',
  'deadline_timeout', 'cancelled', 'error']);
// Bounded metadata: per-window rows up to this cap, then aggregate counters only.
const MAX_DIAGNOSTIC_WINDOWS = 32;
function safeCode(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(text) ? text : (text ? 'other' : '');
}
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function planKind({ basePairs, plannedPairs, finalPairs }) {
  if (!Array.isArray(finalPairs) || finalPairs.length <= 1)
    return Array.isArray(basePairs) && basePairs.length > 1 ? 'whole_fallback' : 'single';
  if (finalPairs === plannedPairs) return plannedPairs === basePairs ? 'base_heading' : 'balanced_heading';
  return finalPairs === basePairs ? 'receipt_base' : 'base_heading';
}
function signalCounts(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const structured = list.filter(code => typeof code === 'string' && code.startsWith('{')).length;
  return { hintCount: list.length - structured, relationCandidateCount: structured };
}
function createScheduleRecorder({ basePairs = [], plannedPairs = [], finalPairs = [], allowRepair = true,
  concurrency = 2, deadlineMs, now = Date.now } = {}) {
  const startedAt = now();
  const deadline = Number(deadlineMs) > 0 ? Number(deadlineMs) : null;
  const kind = planKind({ basePairs, plannedPairs, finalPairs });
  const windows = new Map();
  const counts = Object.fromEntries([...OUTCOMES].map(outcome => [outcome, 0]));
  let started = 0, overflowWindowCount = 0, minRemainingMsAtStart = null, maxQueuedMs = 0;
  const scratch = {};
  const window = index => {
    if (!windows.has(index)) {
      if (windows.size >= MAX_DIAGNOSTIC_WINDOWS) { scratch[index] ||= { index }; return scratch[index]; }
      windows.set(index, { index, order: windows.size });
    }
    return windows.get(index);
  };
  return {
    describe(index, { pair, obligationCount, signals, route } = {}) {
      const row = window(index);
      row.sourceChars = count(pair?.sourceContext?.length);
      row.outputChars = count(pair?.output?.length);
      row.alignment = safeCode(pair?.alignment || 'whole_document');
      row.obligationCount = count(obligationCount);
      if (signals) Object.assign(row, signalCounts(signals));
      if (route) row.route = safeCode(route);
    },
    receipt(index, status) { window(index).receipt = safeCode(status); },
    start(index) {
      const row = window(index), at = now();
      row.startedAt = at;
      row.queuedMs = Math.max(0, at - startedAt);
      row.remainingMsAtStart = deadline == null ? null : deadline - at;
      started += 1;
      maxQueuedMs = Math.max(maxQueuedMs, row.queuedMs);
      if (row.remainingMsAtStart != null)
        minRemainingMsAtStart = minRemainingMsAtStart == null ? row.remainingMsAtStart
          : Math.min(minRemainingMsAtStart, row.remainingMsAtStart);
    },
    finish(index, { outcome, report, error, verifyCount = 0 } = {}) {
      const row = window(index), at = now();
      // A section cancelled before its request did no model work at all.
      row.elapsedMs = row.startedAt == null || outcome === 'cancelled_before_start' ? 0 : Math.max(0, at - row.startedAt);
      delete row.startedAt;
      row.outcome = OUTCOMES.has(outcome) ? outcome : 'error';
      counts[row.outcome] += 1;
      if (!windows.has(index)) { overflowWindowCount += 1; delete scratch[index]; return; }
      if (error) row.errorCode = safeCode(error.code || error.name || 'error');
      row.judgeTier = report ? (report.relationConfirmationFirst === true ? 'confirmation_first'
        : report.escalated === true ? 'escalated' : 'primary') : '';
      row.judgeModel = safeCode(report?.selectedJudgeModel || '');
      row.verifyCount = count(verifyCount) || 0;
      const usage = report?.usage || error?.usage || null;
      row.inputTokens = count(usage?.inputTokens);
      row.outputTokens = count(usage?.outputTokens);
      row.reasoningTokens = count(usage?.reasoningTokens);
    },
    result({ signal } = {}) {
      const rows = [...windows.values()].sort((a, b) => a.index - b.index)
        .map(row => { const { startedAt: _ignored, ...rest } = row; return rest; });
      return {
        version: SCHEDULE_DIAGNOSTICS_VERSION,
        planKind: PLAN_KINDS.has(kind) ? kind : 'single',
        basePairCount: Array.isArray(basePairs) ? basePairs.length : 0,
        plannedPairCount: Array.isArray(plannedPairs) ? plannedPairs.length : 0,
        finalPairCount: Array.isArray(finalPairs) ? finalPairs.length : 0,
        allowRepair: allowRepair !== false,
        concurrency,
        budgetMsAtStart: deadline == null ? null : deadline - startedAt,
        totalElapsedMs: Math.max(0, now() - startedAt),
        aborted: signal?.aborted === true,
        deadlineExceeded: signal?.aborted === true && signal.reason?.name === 'TimeoutError',
        // Admitted = the section reached a lookup/model decision; the outcome
        // counters include windows beyond the per-row cap.
        admittedWindowCount: started,
        maxQueuedMs,
        minRemainingMsAtStart,
        outcomeCounts: counts,
        overflowWindowCount,
        windows: rows
      };
    }
  };
}
function outcomeFor(report) {
  if (!report) return 'error';
  if (report.receiptReused === true) return 'receipt_reused';
  if (report.pass === true && !report.uncertain && !report.skipped) return 'pass';
  if (report.uncertain || report.skipped || report.verificationCompleted === false) return 'uncertain';
  return 'fail';
}
function errorOutcome(signal) {
  if (!signal?.aborted) return 'error';
  return signal.reason?.name === 'TimeoutError' ? 'deadline_timeout' : 'cancelled';
}

// Persistence/export projection: no prompt, model prose, arbitrary strings or
// error messages. Missing legacy diagnostics stay absent rather than zeroed.
function sanitizeScheduleDiagnostics(value) {
  if (!value || value.version !== SCHEDULE_DIAGNOSTICS_VERSION || !PLAN_KINDS.has(value.planKind)) return null;
  const clean = { version: SCHEDULE_DIAGNOSTICS_VERSION, planKind: value.planKind };
  const numbers = (source, target, fields, signed = false) => {
    for (const field of fields) {
      const n = source?.[field];
      if (n === null) target[field] = null;
      else if (Number.isSafeInteger(n) && (signed || n >= 0)) target[field] = Math.max(signed ? -1000000000 : 0, Math.min(1000000000, n));
    }
  };
  numbers(value, clean, ['basePairCount', 'plannedPairCount', 'finalPairCount', 'concurrency', 'totalElapsedMs',
    'admittedWindowCount', 'maxQueuedMs', 'overflowWindowCount']);
  numbers(value, clean, ['budgetMsAtStart', 'minRemainingMsAtStart'], true);
  for (const key of ['allowRepair', 'aborted', 'deadlineExceeded']) {
    if (typeof value[key] === 'boolean') clean[key] = value[key];
  }
  if (value.outcomeCounts && typeof value.outcomeCounts === 'object') {
    clean.outcomeCounts = {};
    numbers(value.outcomeCounts, clean.outcomeCounts, [...OUTCOMES]);
  }
  const enums = {
    alignment: ['whole_document', 'whole_document_uncertain', 'shared_monotonic_sentence', 'shared_unique_heading'],
    route: ['primary_first', 'confirmation_first'], receipt: ['disabled', 'key_error', 'hit', 'miss'],
    outcome: [...OUTCOMES], judgeTier: ['primary', 'escalated', 'confirmation_first']
  };
  if (Array.isArray(value.windows)) clean.windows = value.windows.slice(0, MAX_DIAGNOSTIC_WINDOWS)
    .filter(row => row && Number.isSafeInteger(row.index) && row.index >= 0).map(row => {
      const out = {};
      numbers(row, out, ['index', 'order', 'sourceChars', 'outputChars', 'obligationCount', 'hintCount',
        'relationCandidateCount', 'queuedMs', 'elapsedMs', 'verifyCount', 'inputTokens', 'outputTokens', 'reasoningTokens']);
      numbers(row, out, ['remainingMsAtStart'], true);
      for (const [key, options] of Object.entries(enums)) if (options.includes(row[key])) out[key] = row[key];
      return out;
    });
  return clean;
}
module.exports = { scheduleReviewPairs, planVerdictPairs, createScheduleRecorder, outcomeFor, errorOutcome,
  SCHEDULE_DIAGNOSTICS_VERSION, MAX_DIAGNOSTIC_WINDOWS, sanitizeScheduleDiagnostics };
