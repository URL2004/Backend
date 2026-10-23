'use strict';

// Observed execution intervals exclude queueing, approval and reading time.
// An interrupted or truncated trace is a lower bound, never a complete latency.
function executionTiming(lifecycle) {
  const rows = Array.isArray(lifecycle?.attempts) ? lifecycle.attempts : [];
  const valid = rows.filter(row => Number.isFinite(row.startedAtMs)
    && Number.isFinite(row.finishedAtMs) && row.finishedAtMs >= row.startedAtMs);
  const intervals = valid.map(row => [row.startedAtMs, row.finishedAtMs]).sort((a,b) => a[0]-b[0]);
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start,end)); end = Math.max(end,stop); }
  const complete = lifecycle?.observed === true && rows.length > 0
    && valid.length === rows.length && lifecycle.truncated !== true
    && lifecycle.attemptCount === rows.length;
  return {
    executionDurationMs: complete ? total : null,
    observedExecutionDurationMs: valid.length ? total : null,
    executionDurationCoverage: complete ? 'complete' : valid.length ? 'partial' : 'unavailable'
  };
}
// terminalAt is when the result becomes ready, while attempts include durable
// completion. Compare execution and wall time at the SAME observed endpoint.
// Keep the ready time separately; never move the billing/terminal timestamp.
function completionTiming(job, lifecycle = job?.attemptLifecycle) {
  const ready = Number(job?.terminalAtMs);
  if (!Number.isFinite(ready) || ready <= 0) return {};
  const finishes = (lifecycle?.attempts || []).filter(r => Number.isFinite(r.startedAtMs)
    && Number.isFinite(r.finishedAtMs) && r.finishedAtMs >= r.startedAtMs).map(r => r.finishedAtMs);
  const completed = Math.max(ready, ...finishes);
  const created = Number(job.createdAt || job.createdAtMs), started = Number(job.startedAt || created);
  return {
    timingVersion: 'completion-endpoint-v2', timingEndpointAtMs: completed,
    ...(created > 0 ? { totalDurationMs: Math.max(0, completed - created), resultReadyDurationMs: Math.max(0, ready - created) } : {}),
    ...(started > 0 ? { processingDurationMs: Math.max(0, completed - started) } : {}),
    finalizationDurationMs: completed - ready
  };
}
module.exports = { executionTiming, completionTiming };
