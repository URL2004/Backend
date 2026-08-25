'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  approvedPaymentValidation,
  confirmIdempotencyKey,
  creditLedgerDelta,
  paymentKeyHash,
  providerResultSummary,
  validateConfirmInput,
  webhookPaymentValidation
} = require('../lib/paymentReconciliation');

test('결제 확인 멱등 키는 주문·결제키에 결정적이며 원문 결제키를 노출하지 않는다', () => {
  const paymentKey = 'secret-payment-key-123456';
  const first = confirmIdempotencyKey('order_123456', paymentKey);
  const second = confirmIdempotencyKey('order_123456', paymentKey);

  assert.equal(first, second);
  assert.equal(first.includes(paymentKey), false);
  assert.notEqual(first, confirmIdempotencyKey('order_654321', paymentKey));
  assert.equal(paymentKeyHash(paymentKey).length, 64);
});

test('결제 확인 입력은 Toss 호환 주문 ID와 제한된 결제키만 허용한다', () => {
  assert.deepEqual(validateConfirmInput({ paymentKey: 'pay_1234567890', orderId: 'order_123456' }), { ok: true });
  assert.equal(validateConfirmInput({ paymentKey: '', orderId: 'order_123456' }).ok, false);
  assert.equal(validateConfirmInput({ paymentKey: 'pay_1234567890', orderId: '../bad' }).ok, false);
  assert.equal(validateConfirmInput({ paymentKey: 'x'.repeat(301), orderId: 'order_123456' }).ok, false);
});

test('승인 조회 결과는 결제키·주문·금액·DONE 상태가 모두 맞아야 지급 가능하다', () => {
  const expected = { paymentKey: 'pay_123456', orderId: 'order_123456', amount: 2900 };
  const payment = { ...expected, totalAmount: 2900, status: 'DONE' };

  assert.deepEqual(approvedPaymentValidation(payment, expected), {
    ok: true,
    reasons: [],
    status: 'DONE',
    totalAmount: 2900
  });

  const mismatch = approvedPaymentValidation({
    ...payment,
    paymentKey: 'pay_other',
    totalAmount: 5900,
    status: 'CANCELED'
  }, expected);
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.reasons, ['payment_key_mismatch', 'amount_mismatch', 'status_not_done']);
});

test('결제 제공자 로그 요약에서 결제키와 카드 정보는 제거한다', () => {
  const summary = providerResultSummary({
    code: 'ALREADY_PROCESSED_PAYMENT',
    message: 'already processed',
    paymentKey: 'secret',
    card: { number: '1234' },
    orderId: 'order_123456',
    totalAmount: 2900,
    status: 'DONE'
  });

  assert.equal(Object.hasOwn(summary, 'paymentKey'), false);
  assert.equal(Object.hasOwn(summary, 'card'), false);
  assert.equal(summary.orderId, 'order_123456');
});

test('일반 결제 웹훅은 토스 재조회 결과의 결제키와 주문 ID로 검증한다', () => {
  const provider = { paymentKey: 'pay_123456', orderId: 'sub_user_1234567890', status: 'CANCELED' };
  assert.deepEqual(webhookPaymentValidation(provider, {
    paymentKey: 'pay_123456',
    orderId: 'sub_user_1234567890',
    status: 'DONE'
  }), {
    ok: true,
    reasons: [],
    orderId: 'sub_user_1234567890',
    status: 'CANCELED'
  });
  assert.equal(webhookPaymentValidation(provider, {
    paymentKey: 'pay_forged',
    orderId: 'sub_other_1234567890'
  }).ok, false);
});

test('관리자 음수 조정 원장은 amount와 used를 이중 차감하지 않는다', () => {
  assert.equal(creditLedgerDelta({ type: 'admin_adjust', amount: -20, used: 20 }), -20);
  assert.equal(creditLedgerDelta({ type: 'admin_adjust', amount: 20, used: 0 }), 20);
  assert.equal(creditLedgerDelta({ type: 'humanize', amount: 0, used: 20 }), -20);
  assert.equal(creditLedgerDelta({ type: 'charge', amount: 110, used: 0 }), 110);
});
