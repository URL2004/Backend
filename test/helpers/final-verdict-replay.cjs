'use strict';
// Replays the SCHEDULE of a final semantic verdict audit with a fake judge on a
// virtual clock. No model, no network, no user text: section sizes, latencies
// and outcomes are numbers; every sentence is generated here.
const judge = require('../../engine-gpt-prod/judge');
const alignment = require('../../engine-gpt-prod/reviewAlignment');
const ledger = require('../../engine-gpt-prod/callLedger');
const provenance = require('../../engine-gpt-prod/semanticProvenance');
const { finalSemanticDeadline } = require('../../engine-gpt-prod/finalSemanticDeadline');
const qualityPath = require.resolve('../../engine-gpt-prod/finalQualityV2');

const HEADING = '## 합성절 ';
const sentence = (n, i) => `합성 구역 ${n}의 ${i}번째 문장은 일정 검증을 위해 지어낸 설명이다. `;
function body(n, chars) {
  let text = '';
  for (let i = 1; text.length < chars; i += 1) text += sentence(n, i);
  return text.slice(0, chars);
}
// One section stays a whole document; several become heading-owned sections.
function buildText(windows, side) {
  if (windows.length === 1) return body(1, windows[0][side]);
  return windows.map((w, i) => {
    const head = `${HEADING}${i + 1}\n`;
    return head + body(i + 1, Math.max(10, w[side] - head.length - 2)) + '\n\n';
  }).join('');
}
const splitSections = text => String(text).split(/(?=^## 합성절 )/mu).filter(Boolean);
function headingPairs(source, output) {
  const a = splitSections(source), b = splitSections(output);
  let s = 0, o = 0;
  return a.map((sc, i) => {
    const oc = b[i];
    const pair = { index: i, sourceStart: s, sourceEnd: s + sc.length, outputStart: o, outputEnd: o + oc.length,
      sourceContext: sc, output: oc, alignment: 'shared_unique_heading', repairSafe: true };
    s += sc.length; o += oc.length;
    return pair;
  });
}
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
// Uses the (mocked) global setTimeout; Infinity never resolves by itself.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    if (signal?.aborted) { abort(); return; }
    if (Number.isFinite(ms)) timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
// The request limit openaiClient applies to one semantic verdict attempt
// (test/final-semantic-transport-deadline.test.js pins the real client).
const requestLimitMs = () => Math.max(180000, Math.min(290000, Number(ledger.current()?.policy?.verdictCallLimitMs) || 0));

// windows: [[sourceChars, outputChars], ...]
// latency(index, attempt) -> ms the fake confirming verdict needs (Infinity = hangs)
// verdict(index, attempt) -> 'pass' | 'fail' | 'uncertain'
// shape: 'legacy' = the audit call before F-01 (one deadline fixed at the final
//        stage start, shared by every section); 'policy' = the engine's call now.
async function replayFinalVerdict(t, { windows, shape = 'policy', legacyLimitMs = 120000, preludeMs = 0,
  jobRemainingMs = 3600000, latency = () => 1000, verdict = () => 'pass', abortAfterMs = 0 }) {
  const originalJudge = judge.judgeAndRepair, originalAlign = alignment.alignedReviewPairs, originalTimeout = AbortSignal.timeout;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1760000000000 });
  // AbortSignal.timeout ignores mocked timers; bind the same TimeoutError to them.
  AbortSignal.timeout = ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
    return controller.signal;
  };
  alignment.alignedReviewPairs = headingPairs;
  const attempts = new Map(), calls = [];
  judge.judgeAndRepair = async (src, text, options) => {
    const index = windows.length === 1 ? 0 : Number((/^## 합성절 (\d+)/u.exec(src) || [])[1]) - 1;
    const attempt = (attempts.get(index) || 0) + 1;
    attempts.set(index, attempt);
    const needed = latency(index, attempt), limit = requestLimitMs();
    calls.push({ index, attempt, startedAt: Date.now(), requestLimitMs: limit, maxRounds: options.maxRounds });
    if (needed > limit) {
      await sleep(limit, options.signal);
      throw Object.assign(new Error(`OpenAI Responses API request timed out after ${limit}ms`), { code: 'ETIMEDOUT' });
    }
    await sleep(needed, options.signal);
    const result = verdict(index, attempt);
    return provenance.bindSemanticValidation({ ran: true, outputText: text, rounds: 0, violations: [],
      pass: result === 'pass', uncertain: result === 'uncertain', relationConfirmationFirst: true,
      selectedJudgeModel: 'synthetic-confirming', usage: { estimatedUsd: 0, inputTokens: 0, outputTokens: 0 } }, src, text);
  };
  delete require.cache[qualityPath];
  const restore = () => {
    judge.judgeAndRepair = originalJudge;
    alignment.alignedReviewPairs = originalAlign;
    AbortSignal.timeout = originalTimeout;
    t.mock.timers.reset();
    delete require.cache[qualityPath];
  };
  try {
    const audit = require(qualityPath).runSemanticDocumentAudit;
    const source = buildText(windows, 0), candidate = buildText(windows, 1);
    const config = { models: { judge: 'synthetic-primary', judgeEscalation: 'synthetic-confirming', repair: 'synthetic-repair' },
      reasoning: { judge: 'medium', escalation: 'high', repair: 'medium' } };
    const caller = new AbortController();
    if (abortAfterMs > 0) setTimeout(() => caller.abort(abortError()), abortAfterMs);
    setTimeout(() => caller.abort(new DOMException('Job deadline', 'TimeoutError')), jobRemainingMs);
    const startedAt = Date.now();
    let report, error, settled = false, policy = null;
    ledger.run(async () => {
      const finalAuditStartedAt = Date.now();
      policy = finalSemanticDeadline({ source, candidate, startedAt: finalAuditStartedAt,
        jobDeadlineMs: finalAuditStartedAt + jobRemainingMs });
      // Time the final stage spent before the verdict audit started.
      if (preludeMs > 0) await sleep(preludeMs);
      const options = { source, outputText: candidate, config, mode: 'assignment', allowRepair: false, signal: caller.signal,
        discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] };
      if (shape === 'legacy') {
        const deadlineMs = Math.min(finalAuditStartedAt + jobRemainingMs, finalAuditStartedAt + legacyLimitMs);
        return audit({ ...options, signal: AbortSignal.any([caller.signal, AbortSignal.timeout(Math.max(1, deadlineMs-Date.now()))]), deadlineMs });
      }
      return ledger.withPolicy(policy.verdictPolicy,
        () => audit({ ...options, deadlineMs: policy.verdictDeadlineMs(Date.now()) }));
    }).then(value => { report = value; settled = true; }, e => { error = e; settled = true; });
    for (let virtual = 0; !settled && virtual < 7200000; virtual += 500) {
      t.mock.timers.tick(500);
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!settled) throw new Error('final verdict replay did not settle within two virtual hours');
    if (error) throw error;
    const diagnostics = report.scheduleDiagnostics || {};
    return { report, calls, policy, finalStageMs: Date.now() - startedAt, diagnostics,
      outcomes: (diagnostics.windows || []).map(w => w.outcome) };
  } finally { restore(); }
}

module.exports = { replayFinalVerdict, buildText, sleep };
