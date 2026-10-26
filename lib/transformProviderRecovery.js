'use strict';
const { DELAY_MESSAGE } = require('./providerAvailability');
const HOLD_MS = 30 * 60 * 1000;
const RECOVERY_CODE = 'SERVICE_TEMPORARILY_UNAVAILABLE';

function defer(job, retryAtMs, now = Date.now()) {
  if (!job || job.pendingCompletion || ['done', 'cancelled', 'awaiting_payment'].includes(job.status)) return false;
  job.providerRecoveryStartedAtMs ||= now;
  job.providerRecoveryCount = (Number(job.providerRecoveryCount) || 0) + 1;
  job.recoverableErrorCode = RECOVERY_CODE;
  job.queueWaitReason = 'provider_recovery';
  job.gates = null; job.gateDetail = null; job.blockOffer = null;
  const billing = job.deducted === true ? '결제 상태와 결과를 확인하고 있어요.' : '크레딧·이용권은 차감되지 않았어요.';
  if (now - job.providerRecoveryStartedAtMs >= HOLD_MS) {
    job.status = 'error'; job.stage = '처리 재개 확인 필요';
    job.error = DELAY_MESSAGE + ' ' + billing + ' 자동 재개 대기를 마쳤어요. 같은 작업에서 다시 처리할 수 있어요.';
    job.retryNotBeforeMs = null;
  } else {
    job.status = 'queued'; job.stage = '처리 재개 대기 중';
    job.error = null;
    job.retryNotBeforeMs = Math.min(job.providerRecoveryStartedAtMs + HOLD_MS,
      Math.max(now + 1000, Number(retryAtMs) || now + 60000));
  }
  return true;
}
function payload(job) {
  if (job?.recoverableErrorCode !== RECOVERY_CODE) return {};
  const waiting = job.status === 'queued' && job.queueWaitReason === 'provider_recovery';
  const retry = job.status === 'error';
  if (!waiting && !retry) return {};
  return { recoveryCode: RECOVERY_CODE, automaticResume: waiting,
    retryAfterSeconds: waiting ? Math.max(1, Math.ceil((job.retryNotBeforeMs - Date.now()) / 1000)) : null,
    billingState: job.deducted === true ? 'committed' : 'not_charged',
    ...(retry ? { blockOffer: { retryOffer: true, fallbackOffer: false, retryCredit: job.needed }, error: job.error } : {}) };
}
const canRetry = job => job?.status === 'error' && job.recoverableErrorCode === RECOVERY_CODE && !job.pendingCompletion;
module.exports = { defer, payload, canRetry, HOLD_MS, RECOVERY_CODE };
