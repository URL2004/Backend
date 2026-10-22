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
function cancellationAvailability(current, { nowMs = Date.now(), windowSec = 45 } = {}) {
  const decision = cancellationDecision(current, { uid: current?.uid, nowMs, windowSec });
  const active = ['queued', 'running', 'awaiting_approval', 'awaiting_payment'].includes(current?.status);
  return {
    canCancel: active && decision.ok === true,
    cancelRemainingSec: active && decision.ok && current.status === 'running'
      ? Math.max(0, Math.floor(windowSec - (nowMs - (current.startedAt || current.createdAt || nowMs)) / 1000)) : null,
    cancelReason: active && !decision.ok ? decision.code : null
  };
}
module.exports = { cancellationDecision, cancellationAvailability };
