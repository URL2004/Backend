'use strict';

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_approval', 'awaiting_payment'];

function isPaymentRequired(error) {
  return ['INSUFFICIENT_CREDITS', 'NO_COUPON'].includes(error?.code || error?.message);
}

function normalizeCancelledJob(job) {
  if (job?.status === 'cancelled') {
    job.pendingCompletion = null;
    job.pendingRefinement = null;
    job.retryNotBeforeMs = null;
    job._restartRecoveryPending = false;
  }
  return job;
}

function canResumeCompletion(job) {
  return !!job?.pendingCompletion && !['cancelled', 'awaiting_payment'].includes(job.status);
}

function paymentRequiredPayload(job) {
  return {
    code: job.billingMode === 'coupon' ? 'NO_COUPON' : 'INSUFFICIENT_CREDITS',
    error: job.billingMode === 'coupon'
      ? '사용 가능한 쿠폰이 없어 결과 전달을 기다리고 있어요. 쿠폰을 확인한 뒤 결과 받기를 눌러 주세요.'
      : '크레딧이 부족해 결과 전달을 기다리고 있어요. 충전한 뒤 결과 받기를 눌러 주세요.',
    needed: job.pendingCompletion?.creditAmount ?? job.needed,
    billingMode: job.billingMode === 'coupon' ? 'coupon' : 'credit'
  };
}

module.exports = { ACTIVE_STATUSES, isPaymentRequired, normalizeCancelledJob, canResumeCompletion, paymentRequiredPayload };
