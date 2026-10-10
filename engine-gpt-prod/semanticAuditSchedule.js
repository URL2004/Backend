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
// Final verdict time policy (F-01, 2026-10-09 production records).
// A confirming verdict is one request whose duration follows its OUTPUT size,
// not the document length: 171 completed confirming calls measured
// 3.9s + 19.4ms per output token (r = 0.99). Its permitted output envelope is
// 10,000-16,000 tokens (semanticReviewEnvelope), i.e. 198-315s, while the final
// audit allowed 120s (<= 6,000 chars) or one 180s shared by every section.
// 36% of confirming calls were still running at 120s and 11% at 180s.
// The limit below is the time ONE section's verdict may take. It stays under
// the HTTP client's 300s response-header limit; nothing about the model,
// effort, prompt, output envelope or verdict tier changes.
const FINAL_VERDICT_SECTION_LIMIT_MS = 270000;
const FINAL_VERDICT_CONCURRENCY = 2;
const FINAL_VERDICT_RETRY_LIMIT = 1;
const FINAL_VERDICT_SLACK_MS = 30000;
const VERDICT_SCHEDULE_VERSION = 'final-verdict-schedule-v1';
// Sections are owned by headings, so the count is only known once the audit
// aligns the text. `expected` sizes the reserve kept for the final audit;
// `upper` sizes the hard ceiling so an unexpected extra section is never
// starved by an estimate.
function estimateVerdictSections(chars) {
  const length = Math.max(0, Math.floor(Number(chars) || 0));
  if (length <= 6000) return { expected: 1, upper: 1 };
  return { expected: Math.max(2, Math.ceil(length / 9000)), upper: Math.max(2, Math.ceil(length / 4500)) };
}
function finalVerdictBudget(chars) {
  const sections = estimateVerdictSections(chars);
  const waves = count => Math.ceil(count / FINAL_VERDICT_CONCURRENCY);
  return {
    sectionLimitMs: FINAL_VERDICT_SECTION_LIMIT_MS,
    expectedSections: sections.expected,
    upperSections: sections.upper,
    // Every expected section gets its own full limit at concurrency 2.
    limitMs: waves(sections.expected) * FINAL_VERDICT_SECTION_LIMIT_MS,
    // Ceiling for the whole final audit: every possible wave, one retry wave
    // and the deterministic alignment work that runs inside the audit.
    hardLimitMs: (waves(sections.upper) + FINAL_VERDICT_RETRY_LIMIT) * FINAL_VERDICT_SECTION_LIMIT_MS
      + FINAL_VERDICT_SLACK_MS,
    policy: {
      // Read by openaiClient for the per-request limit of a semantic verdict.
      verdictCallLimitMs: FINAL_VERDICT_SECTION_LIMIT_MS,
      verdictSchedule: { version: VERDICT_SCHEDULE_VERSION, sectionLimitMs: FINAL_VERDICT_SECTION_LIMIT_MS,
        retryLimit: FINAL_VERDICT_RETRY_LIMIT, retrySections: FINAL_VERDICT_CONCURRENCY }
    }
  };
}
function activeVerdictSchedule(allowRepair, supplied) {
  if (allowRepair !== false) return null;
  let policy = supplied;
  if (policy === undefined) {
    try { policy = require('./callLedger').current()?.policy?.verdictSchedule; } catch { policy = null; }
  }
  const limit = Number(policy?.sectionLimitMs);
  if (!policy || policy.version !== VERDICT_SCHEDULE_VERSION || !Number.isFinite(limit) || limit < 1000) return null;
  const whole = (value, max) => Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
  return { sectionLimitMs: Math.floor(limit), retryLimit: whole(policy.retryLimit, 1),
    retrySections: whole(policy.retrySections, 8) };
}
// Runs the audit's own section worker. Without a verdict schedule (every
// repair-capable audit, and any caller that did not opt in) this is exactly the
// previous mapWithConcurrency call. With one, each section owns its time limit
// instead of the remainder of a shared deadline, and a section that ended
// without a verdict is asked again once; completed sections are never re-run.
async function runSectionSchedule({ schedule = [], concurrency = FINAL_VERDICT_CONCURRENCY, signal, allowRepair = true,
  isUnfinished = () => false, policy = undefined } = {}, worker) {
  const map = require('./concurrency').mapWithConcurrency;
  const active = activeVerdictSchedule(allowRepair, policy);
  if (!active) {
    await map(schedule, concurrency, item => worker(item, signal));
    return { sectionLimitMs: null, retriedSections: 0 };
  }
  const ledger = require('./callLedger');
  const runSection = async item => {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal?.aborted) forward(); else signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Final verdict section limit', 'TimeoutError')),
      active.sectionLimitMs);
    try {
      const outer = Number(ledger.current()?.policy?.deadlineMs);
      const sectionDeadline = Date.now() + active.sectionLimitMs;
      return await ledger.withPolicy({ verdictCallLimitMs: active.sectionLimitMs,
        deadlineMs: Number.isFinite(outer) && outer > 0 ? Math.min(outer, sectionDeadline) : sectionDeadline },
      () => worker(item, controller.signal));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  };
  await map(schedule, concurrency, runSection);
  let retriedSections = 0;
  for (let round = 0; round < active.retryLimit && !signal?.aborted; round += 1) {
    const pending = schedule.filter(item => { try { return isUnfinished(item.index) === true; } catch { return false; } });
    // Most sections failing is an outage, not one slow verdict: do not spend a
    // second full limit per section on it.
    if (!pending.length || pending.length > active.retrySections) break;
    retriedSections += pending.length;
    await map(pending, concurrency, runSection);
  }
  return { sectionLimitMs: active.sectionLimitMs, retriedSections };
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
  let started = 0, overflowWindowCount = 0, minRemainingMsAtStart = null, maxQueuedMs = 0, retriedWindowCount = 0;
  // The per-section limit this audit runs under (verdict-only audits whose
  // caller set a verdict schedule); null = sections share `deadlineMs`.
  const sectionLimitMs = activeVerdictSchedule(allowRepair)?.sectionLimitMs ?? null;
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
      // A second start is the one retry of a section that ended without a
      // verdict. The outcome counters describe each section's LAST attempt;
      // the first is kept on the row.
      const retry = OUTCOMES.has(row.outcome);
      if (retry) {
        counts[row.outcome] = Math.max(0, counts[row.outcome] - 1);
        row.firstOutcome = row.firstOutcome || row.outcome;
        row.firstElapsedMs = row.firstElapsedMs ?? row.elapsedMs ?? 0;
        row.attempts = (row.attempts || 1) + 1;
        retriedWindowCount += 1;
        for (const field of ['outcome', 'errorCode', 'judgeTier', 'judgeModel']) delete row[field];
      }
      row.startedAt = at;
      row.queuedMs = Math.max(0, at - startedAt);
      row.remainingMsAtStart = deadline == null ? null : deadline - at;
      if (!retry) started += 1;
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
        sectionLimitMs,
        retriedWindowCount,
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
    'admittedWindowCount', 'maxQueuedMs', 'overflowWindowCount', 'sectionLimitMs', 'retriedWindowCount']);
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
    outcome: [...OUTCOMES], firstOutcome: [...OUTCOMES], judgeTier: ['primary', 'escalated', 'confirmation_first']
  };
  if (Array.isArray(value.windows)) clean.windows = value.windows.slice(0, MAX_DIAGNOSTIC_WINDOWS)
    .filter(row => row && Number.isSafeInteger(row.index) && row.index >= 0).map(row => {
      const out = {};
      numbers(row, out, ['index', 'order', 'sourceChars', 'outputChars', 'obligationCount', 'hintCount',
        'relationCandidateCount', 'queuedMs', 'elapsedMs', 'verifyCount', 'inputTokens', 'outputTokens', 'reasoningTokens',
        'attempts', 'firstElapsedMs']);
      numbers(row, out, ['remainingMsAtStart'], true);
      for (const [key, options] of Object.entries(enums)) if (options.includes(row[key])) out[key] = row[key];
      return out;
    });
  return clean;
}
module.exports = { scheduleReviewPairs, planVerdictPairs, createScheduleRecorder, outcomeFor, errorOutcome,
  SCHEDULE_DIAGNOSTICS_VERSION, MAX_DIAGNOSTIC_WINDOWS, sanitizeScheduleDiagnostics,
  FINAL_VERDICT_SECTION_LIMIT_MS, FINAL_VERDICT_CONCURRENCY, VERDICT_SCHEDULE_VERSION,
  estimateVerdictSections, finalVerdictBudget, runSectionSchedule };
