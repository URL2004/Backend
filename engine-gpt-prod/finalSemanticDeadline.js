'use strict';

const { finalVerdictBudget } = require('./semanticAuditSchedule');

// The final verdict used to get 120s (<= 6,000 chars) or one 180s shared by
// every section. Both are shorter than one confirming verdict needs: on
// 2026-10-09 all eight incomplete results ended at exactly this deadline with
// 89-99.9% of it still available when the audit started, and the job deadline
// had more than an hour left. The limit now follows the verdict schedule
// (semanticAuditSchedule.finalVerdictBudget): each expected section gets its
// own full limit. It never renews or exceeds the job deadline and it starts
// no additional repair cycle.
function finalSemanticDeadline({ source = '', candidate = '', startedAt = Date.now(), jobDeadlineMs = Infinity } = {}) {
  const chars = Math.max(String(source).length, String(candidate).length);
  const longDocument = chars > 6000;
  const budget = finalVerdictBudget(chars);
  const limitMs = budget.limitMs;
  const jobDeadline = Number.isFinite(Number(jobDeadlineMs)) ? Number(jobDeadlineMs) : Infinity;
  return {
    longDocument,
    limitMs,
    deadlineMs: Math.min(jobDeadline, startedAt + limitMs),
    // The approved extension belongs to an already-running verdict, not an
    // expanded opportunity to start another repair-and-verification cycle.
    postRepairDeadlineMs: Math.min(jobDeadline, startedAt + 120000),
    // Do not spend the verification time on an optional repair. Keep the same
    // maximum thirty-second pre-final repair allowance.
    verifyReserveMs: limitMs - 30000,
    sectionLimitMs: budget.sectionLimitMs,
    hardLimitMs: budget.hardLimitMs,
    // callLedger policy for the final verdict audit only.
    verdictPolicy: budget.policy,
    // The verdict clock starts when the audit starts: the pre-final repair and
    // its preparation no longer consume the verdict's time.
    verdictDeadlineMs: (auditStartedAt = Date.now()) => Math.min(jobDeadline, Number(auditStartedAt) + budget.hardLimitMs)
  };
}

module.exports = { finalSemanticDeadline };
