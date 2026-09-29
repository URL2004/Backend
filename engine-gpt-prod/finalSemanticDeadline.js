'use strict';

// Match the whole-document semantic audit envelope. Long-document audits may
// keep their existing in-flight requests alive for one extra minute; this does
// not start a retry, increase concurrency or override the overall job deadline.
function finalSemanticDeadline({ source = '', candidate = '', startedAt = Date.now(), jobDeadlineMs = Infinity } = {}) {
  const longDocument = Math.max(String(source).length, String(candidate).length) > 6000;
  const limitMs = longDocument ? 180000 : 120000;
  const jobDeadline = Number.isFinite(Number(jobDeadlineMs)) ? Number(jobDeadlineMs) : Infinity;
  return {
    longDocument,
    limitMs,
    deadlineMs: Math.min(jobDeadline, startedAt + limitMs),
    // The approved extension belongs to an already-running verdict, not an
    // expanded opportunity to start another repair-and-verification cycle.
    postRepairDeadlineMs: Math.min(jobDeadline, startedAt + 120000),
    // Do not spend the extra long-document verification time on an optional
    // repair. Keep the same maximum thirty-second pre-final repair allowance.
    verifyReserveMs: limitMs - 30000
  };
}

module.exports = { finalSemanticDeadline };
