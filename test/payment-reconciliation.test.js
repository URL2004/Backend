'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../lib/paymentReconciliation');
const { safeProviderPaymentSnapshot } = require('../lib/paymentCancellation');

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

test('환불 멱등 키와 원장 ID는 결정적이며 주문 원문 외의 비밀을 포함하지 않는다', () => {
  const operation = refundOperationId('order_1234567890', 0, 2900, 110);
  assert.equal(operation, refundOperationId('order_1234567890', 0, 2900, 110));
  assert.notEqual(operation, refundOperationId('order_1234567890', 0, 2900, 100));
  assert.equal(refundIdempotencyKey(operation), refundIdempotencyKey(operation));
  assert.equal(cancellationLedgerId('order_1234567890', 2900), cancellationLedgerId('order_1234567890', 2900));
});

test('토스 취소 누적액은 totalAmount와 balanceAmount를 우선해 계산한다', () => {
  assert.equal(providerCanceledAmount({ totalAmount: 8700, balanceAmount: 4700, cancels: [{ cancelAmount: 1 }] }), 4000);
  assert.equal(providerCanceledAmount({ cancels: [{ cancelAmount: 290 }, { cancelAmount: 2610 }] }), 2900);
  assert.equal(refundedCreditsForCanceledAmount({ orderAmount: 8700, purchasedCredits: 330, canceledAmount: 4000 }), 151);
  assert.equal(refundedCreditsForCanceledAmount({ orderAmount: 2900, purchasedCredits: 110, canceledAmount: 2900 }), 110);
});

test('외부 전액취소는 가용 잔액만 차감하고 회수 불가 크레딧을 명시한다', () => {
  const plan = buildCreditCancellationPlan({
    payment: { status: 'CANCELED', totalAmount: 2900, balanceAmount: 0 },
    order: { amount: 2900, safeCredits: 110 },
    currentCredits: 100,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(plan.applicable, true);
  assert.equal(plan.orderStatus, 'refunded');
  assert.equal(plan.targetCredits, 110);
  assert.equal(plan.balanceDebit, 100);
  assert.equal(plan.ledgerCredits, 100);
  assert.equal(plan.unrecoveredCredits, 10);
});

test('서버 선차감 또는 구형 환불 원장이 있으면 웹훅이 잔액을 이중 차감하지 않는다', () => {
  const payment = { status: 'CANCELED', totalAmount: 2900, balanceAmount: 0 };
  const reserved = buildCreditCancellationPlan({
    payment,
    order: { amount: 2900, safeCredits: 110, refundedCredits: 110 },
    currentCredits: 0,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(reserved.balanceDebit, 0);
  assert.equal(reserved.ledgerCredits, 110);
  assert.equal(reserved.unrecoveredCredits, 0);

  const legacy = buildCreditCancellationPlan({
    payment,
    order: { amount: 2900, safeCredits: 100 },
    currentCredits: 100,
    knownRefundLedgerCredits: 100,
    userExists: true
  });
  assert.equal(legacy.balanceDebit, 0);
  assert.equal(legacy.ledgerCredits, 0);
  assert.equal(legacy.appliedCredits, 100);
});

test('진행 중 환불은 공급자 누적 취소가 확인된 뒤 같은 작업으로 확정한다', () => {
  const confirmed = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 2900, balanceAmount: 264 },
    order: {
      amount: 2900,
      safeCredits: 110,
      refundedCredits: 100,
      refundProcessing: {
        targetRefundedAmount: 2636,
        targetRefundedCredits: 100,
        creditsToDeduct: 100
      }
    },
    currentCredits: 10,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(confirmed.applicable, true);
  assert.equal(confirmed.targetCredits, 100);
  assert.equal(confirmed.balanceDebit, 0);
  assert.equal(confirmed.ledgerCredits, 100);
  assert.equal(confirmed.clearProcessing, true);

  const stillPending = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 2900, balanceAmount: 1450 },
    order: {
      amount: 2900,
      safeCredits: 110,
      refundedCredits: 100,
      refundProcessing: {
        targetRefundedAmount: 2636,
        targetRefundedCredits: 100,
        creditsToDeduct: 100
      }
    },
    currentCredits: 10,
    userExists: true
  });
  assert.deepEqual(stillPending, { applicable: false, reason: 'pending_refund_not_provider_confirmed' });
});

test('웹훅 재처리 스냅샷은 결제키·카드·취소사유를 저장하지 않는다', () => {
  const snapshot = safeProviderPaymentSnapshot({
    orderId: 'order_1234567890',
    paymentKey: 'secret-payment-key',
    status: 'CANCELED',
    totalAmount: 2900,
    balanceAmount: 0,
    card: { number: '1234' },
    cancels: [{ cancelAmount: 2900, canceledAt: '2026-08-26T00:00:00+09:00', cancelStatus: 'DONE', cancelReason: 'private' }]
  });
  assert.equal(Object.hasOwn(snapshot, 'paymentKey'), false);
  assert.equal(Object.hasOwn(snapshot, 'card'), false);
  assert.equal(Object.hasOwn(snapshot.cancels[0], 'cancelReason'), false);
  assert.equal(snapshot.cancels[0].cancelAmount, 2900);
});
