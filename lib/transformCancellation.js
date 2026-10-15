'use strict';
const { normalizeCancelledJob } = require('./transformCompletionState');

// Called inside the persistence transaction, after reading the current job.
// The caller's cached state cannot authorize cancellation of a staged result.
function cancellationDecision(current, { uid, nowMs, windowSec }) {
  if (!current || current.uid !== uid) return { ok: false, code: 'TRANSFORM_STATE_CHANGED' };
  if (['done', 'blocked', 'error'].includes(current.status)) return { ok: false, code: 'TRANSFORM_STATE_CHANGED' };
  if (current.deducted || (current.pendingCompletion && !['awaiting_payment', 'cancelled'].includes(current.status))) {
    return { ok: false, code: 'TRANSFORM_COMPLETION_IN_PROGRESS' };
  }
  if (current.status === 'running' && nowMs - (current.startedAt || current.createdAt || nowMs) > windowSec * 1000) {
    return { ok: false, code: 'TRANSFORM_CANCEL_WINDOW_CLOSED' };
  }
  return { ok: true, job: normalizeCancelledJob({ ...current, status: 'cancelled', stage: '중단됨',
    cancelRequestedAtMs: current.cancelRequestedAtMs || nowMs, terminalAtMs: current.terminalAtMs || nowMs }) };
}
module.exports = { cancellationDecision };
