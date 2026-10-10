'use strict';

// 2026-10-09 usage replay, successful calls only (reasoning is output too).
// sol judge/rewrite/repair slopes: 19.44/17.54/17.73 ms/token; largest
// residual at 22 ms/token: 15.432s. luna slopes: 8.84/6.81/6.45;
// largest residual at 12 ms/token: 28.343s. Reserve the entire output cap,
// not the observed/expected output. These are measured allowances, not an SLA.
const HTTP_ATTEMPT_CEILING_MS = 290000;
const DEADLINE_GUARD_MS = 1000;

function callTimeBudget({ model = '', maxOutputTokens = 4096, reasoningEffort = 'medium', meta = {} } = {}) {
  const semantic = meta.task === 'judge';
  const rewrite = ['humanize', 'repair'].includes(meta.task);
  const escalation = meta.escalated === true || /escalation/u.test(meta.phase || '');
  const protectedCall = semantic || (rewrite && (escalation || maxOutputTokens >= 10000
    || (['high', 'xhigh', 'max'].includes(reasoningEffort) && meta.task === 'repair')));
  const luna = /^gpt-6-luna(?:-|$)/i.test(model);
  const msPerOutputToken = luna ? 12 : 22;
  const fixedMs = luna ? 30000 : 20000;
  const outputTokens = Math.max(1, Math.ceil(Number(maxOutputTokens) || 4096));
  const requiredMs = Math.max(semantic ? 180000 : 100000, fixedMs + outputTokens * msPerOutputToken);
  return { protectedCall, outputTokens, msPerOutputToken, fixedMs, requiredMs,
    fitsHttpLimit: requiredMs <= HTTP_ATTEMPT_CEILING_MS };
}

// Re-evaluate for EVERY physical send, including transport/schema/truncation
// retries. A denied send has no reservation, HTTP attempt or unknown charge.
function admitCall(plan, deadlines = {}, now = Date.now()) {
  const limits = Object.entries(deadlines).filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a[1] - b[1]);
  const [boundary = 'request_deadline', deadline = Infinity] = limits[0] || [];
  const remainingMs = deadline - now;
  // Windows admit a start; only the absolute job deadline reserves the full
  // output envelope (even when HTTP will cap this attempt at 290 seconds).
  const jobRemaining = (deadlines.job_deadline > 0 ? deadlines.job_deadline : Infinity) - now;
  const reason = jobRemaining < plan.requiredMs + DEADLINE_GUARD_MS ? 'job_deadline'
    : remainingMs <= 0 ? boundary : '';
  const observedRemaining = reason === 'job_deadline' ? jobRemaining : remainingMs;
  return { admitted: !reason, reason, requiredMs: plan.requiredMs,
    remainingMs: Number.isFinite(observedRemaining) ? Math.max(0, Math.floor(observedRemaining)) : null };
}

module.exports = { callTimeBudget, admitCall, HTTP_ATTEMPT_CEILING_MS, DEADLINE_GUARD_MS };
