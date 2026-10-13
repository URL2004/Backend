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
module.exports = { executionTiming };
