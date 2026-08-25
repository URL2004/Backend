'use strict';

const crypto = require('crypto');

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const PAYMENT_KEY_MAX_LENGTH = 300;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function paymentKeyHash(paymentKey) {
  return sha256(paymentKey);
}

function confirmIdempotencyKey(orderId, paymentKey) {
  return `credit-confirm-${sha256(`${orderId}\u0000${paymentKey}`)}`;
}

function refundOperationId(orderId, priorRefundedAmount, refundAmount, refundCredits) {
  return `credit-refund-${sha256([
    orderId,
    Number(priorRefundedAmount) || 0,
    Number(refundAmount) || 0,
    Number(refundCredits) || 0
  ].join('\u0000'))}`;
}

function refundIdempotencyKey(operationId) {
  return `credit-cancel-${sha256(operationId)}`;
}

function providerCanceledAmount(payment) {
  const value = payment && typeof payment === 'object' ? payment : {};
  const total = Number(value.totalAmount);
  const balance = Number(value.balanceAmount);
  if (Number.isFinite(total) && total >= 0 && Number.isFinite(balance) && balance >= 0 && balance <= total) {
    return Math.floor(total - balance);
  }
  const cancels = Array.isArray(value.cancels) ? value.cancels : [];
  return cancels.reduce((sum, cancel) => {
    const amount = Number(cancel && cancel.cancelAmount);
    return sum + (Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0);
  }, 0);
}

function refundedCreditsForCanceledAmount({ orderAmount, purchasedCredits, canceledAmount }) {
  const amount = Math.max(0, Math.floor(Number(orderAmount) || 0));
  const credits = Math.max(0, Math.floor(Number(purchasedCredits) || 0));
  const canceled = Math.max(0, Math.floor(Number(canceledAmount) || 0));
  if (!amount || !credits || !canceled) return 0;
  if (canceled >= amount) return credits;
  return Math.min(credits, Math.floor((credits * canceled) / amount));
}

function cancellationLedgerId(orderId, canceledAmount) {
  return `provider_refund_${sha256(`${orderId}\u0000${Number(canceledAmount) || 0}`)}`;
}

function buildCreditCancellationPlan({ payment, order, currentCredits, knownRefundLedgerCredits = 0, userExists = true }) {
  const providerStatus = String(payment && payment.status || '');
  if (!['CANCELED', 'PARTIAL_CANCELED'].includes(providerStatus)) {
    return { applicable: false, reason: 'provider_status_not_canceled' };
  }
  const canceledAmount = providerCanceledAmount(payment);
  const orderAmount = Math.max(0, Math.floor(Number(order && order.amount) || 0));
  const purchasedCredits = Math.max(0, Math.floor(Number(order && (order.safeCredits ?? order.credits)) || 0));
  if (!canceledAmount || !orderAmount || !purchasedCredits) {
    return { applicable: false, reason: 'invalid_cancellation_amounts' };
  }

  let targetCredits = refundedCreditsForCanceledAmount({ orderAmount, purchasedCredits, canceledAmount });
  const existingCredits = Math.max(0, Math.floor(Number(order && order.refundedCredits) || 0));
  const knownLedgerCredits = Math.max(0, Math.floor(Number(knownRefundLedgerCredits) || 0));
  const processing = order && order.refundProcessing && typeof order.refundProcessing === 'object'
    ? order.refundProcessing
    : null;
  const processingTarget = Math.max(0, Math.floor(Number(processing && processing.targetRefundedCredits) || 0));
  const processingTargetAmount = Math.max(0, Math.floor(Number(processing && processing.targetRefundedAmount) || 0));
  const processingMatchesProvider = Boolean(
    processing
    && processingTargetAmount > 0
    && processingTargetAmount <= canceledAmount
    && processingTarget <= purchasedCredits
  );
  if (processing && processingTargetAmount > canceledAmount) {
    return { applicable: false, reason: 'pending_refund_not_provider_confirmed' };
  }
  if (processingMatchesProvider) targetCredits = Math.max(targetCredits, processingTarget);
  const accountedCredits = Math.max(existingCredits, knownLedgerCredits);
  const processingReserved = processingMatchesProvider
    ? Math.max(0, Math.floor(Number(processing.creditsToDeduct) || 0))
    : Math.max(0, Math.min(targetCredits, existingCredits) - knownLedgerCredits);
  const unaccountedCredits = Math.max(0, targetCredits - accountedCredits);
  const availableCredits = userExists ? Math.max(0, Math.floor(Number(currentCredits) || 0)) : 0;
  const balanceDebit = Math.min(availableCredits, unaccountedCredits);
  const appliedCredits = accountedCredits + balanceDebit;

  return {
    applicable: true,
    providerStatus,
    orderStatus: canceledAmount >= orderAmount ? 'refunded' : 'partially_refunded',
    canceledAmount,
    targetCredits,
    existingCredits,
    knownLedgerCredits,
    accountedCredits,
    processingReserved,
    balanceDebit,
    ledgerCredits: processingReserved + balanceDebit,
    appliedCredits,
    unrecoveredCredits: Math.max(0, targetCredits - appliedCredits),
    operationId: processing && typeof processing.operationId === 'string' ? processing.operationId : null,
    clearProcessing: processingMatchesProvider
  };
}

function validateConfirmInput({ paymentKey, orderId }) {
  if (typeof paymentKey !== 'string' || !paymentKey.trim() || paymentKey.length > PAYMENT_KEY_MAX_LENGTH) {
    return { ok: false, error: '결제 식별자가 올바르지 않습니다.' };
  }
  if (typeof orderId !== 'string' || !ORDER_ID_PATTERN.test(orderId)) {
    return { ok: false, error: '주문 식별자가 올바르지 않습니다.' };
  }
  return { ok: true };
}

function approvedPaymentValidation(payment, expected) {
  const result = payment && typeof payment === 'object' ? payment : {};
  const reasons = [];
  if (result.orderId !== expected.orderId) reasons.push('order_id_mismatch');
  if (result.paymentKey !== expected.paymentKey) reasons.push('payment_key_mismatch');
  if (Number(result.totalAmount) !== Number(expected.amount)) reasons.push('amount_mismatch');
  if (result.status !== 'DONE') reasons.push('status_not_done');
  return {
    ok: reasons.length === 0,
    reasons,
    status: typeof result.status === 'string' ? result.status : null,
    totalAmount: Number.isFinite(Number(result.totalAmount)) ? Number(result.totalAmount) : null
  };
}

function webhookPaymentValidation(payment, reported) {
  const result = payment && typeof payment === 'object' ? payment : {};
  const payload = reported && typeof reported === 'object' ? reported : {};
  const reasons = [];
  if (!payload.paymentKey || result.paymentKey !== payload.paymentKey) reasons.push('payment_key_mismatch');
  if (payload.orderId && result.orderId !== payload.orderId) reasons.push('order_id_mismatch');
  return {
    ok: reasons.length === 0,
    reasons,
    orderId: typeof result.orderId === 'string' ? result.orderId : null,
    status: typeof result.status === 'string' ? result.status : null
  };
}

function providerResultSummary(result) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    code: typeof value.code === 'string' ? value.code : null,
    message: typeof value.message === 'string' ? value.message.slice(0, 300) : null,
    status: typeof value.status === 'string' ? value.status : null,
    orderId: typeof value.orderId === 'string' ? value.orderId : null,
    totalAmount: Number.isFinite(Number(value.totalAmount)) ? Number(value.totalAmount) : null,
    approvedAt: typeof value.approvedAt === 'string' ? value.approvedAt : null
  };
}

function creditLedgerDelta(row) {
  const amount = Number(row && row.amount);
  const used = Number(row && row.used);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const safeUsed = Number.isFinite(used) ? used : 0;
  // Historical admin debits store the same debit as amount=-N and used=N.
  // The balance changed by -N, not -2N.
  if (row && row.type === 'admin_adjust') return safeAmount;
  return safeAmount - safeUsed;
}

module.exports = {
  ORDER_ID_PATTERN,
  approvedPaymentValidation,
  buildCreditCancellationPlan,
  cancellationLedgerId,
  confirmIdempotencyKey,
  creditLedgerDelta,
  paymentKeyHash,
  providerCanceledAmount,
  providerResultSummary,
  refundedCreditsForCanceledAmount,
  refundIdempotencyKey,
  refundOperationId,
  validateConfirmInput,
  webhookPaymentValidation
};
