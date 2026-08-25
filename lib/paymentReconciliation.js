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
  confirmIdempotencyKey,
  creditLedgerDelta,
  paymentKeyHash,
  providerResultSummary,
  validateConfirmInput,
  webhookPaymentValidation
};
