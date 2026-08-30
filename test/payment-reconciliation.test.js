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
const { allocateProviderCancellation } = require('../lib/creditLotAccounting');

function trackedLot(id, paidRemaining, bonusRemaining, createdAt = 1) {
  return {
    id,
    createdAt,
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    paidCredits: 2000,
    eventBonusCredits: 500,
    refundPaidCreditsRemaining: paidRemaining,
    refundEventBonusCreditsRemaining: bonusRemaining
  };
}

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
  assert.equal(creditLedgerDelta({ type: 'admin_adjust', amount: 0, used: 20 }), -20);
  assert.equal(creditLedgerDelta({ type: 'humanize', amount: 0, used: 20 }), -20);
  assert.equal(creditLedgerDelta({ type: 'charge', amount: 110, used: 0 }), 110);
});

test('환불 멱등 키와 원장 ID는 결정적이며 주문 원문 외의 비밀을 포함하지 않는다', () => {
  const operation = refundOperationId('order_1234567890', 0, 2900, 110);
  assert.equal(operation, refundOperationId('order_1234567890', 0, 2900, 110));
  assert.notEqual(operation, refundOperationId('order_1234567890', 0, 2900, 100));
  assert.equal(
    refundOperationId('order_1234567890', 0, 2900, 110, 'request-1'),
    refundOperationId('order_1234567890', 0, 2900, 110, 'request-1')
  );
  assert.notEqual(
    refundOperationId('order_1234567890', 0, 2900, 110, 'request-1'),
    refundOperationId('order_1234567890', 0, 2900, 110, 'request-2')
  );
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

test('신규 이벤트 주문도 공급자 취소 재정산에서 총 지급 크레딧을 회수한다', () => {
  const plan = buildCreditCancellationPlan({
    payment: { status: 'CANCELED', totalAmount: 58000, balanceAmount: 0 },
    order: {
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      safeCredits: 2500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1'
    },
    currentCredits: 2500,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(plan.applicable, true);
  assert.equal(plan.orderStatus, 'refunded');
  assert.equal(plan.refundCreditBasis, 'paid_credits_first');
  assert.equal(plan.targetPaidCredits, 2000);
  assert.equal(plan.bonusRevocationTargetCredits, 500);
  assert.equal(plan.targetCredits, 2500);
  assert.equal(plan.balanceDebit, 2500);
  assert.equal(plan.ledgerCredits, 2500);
  assert.equal(plan.unrecoveredCredits, 0);
});

test('신규 주문의 외부 부분취소는 환불된 기준 크레딧과 남은 이벤트 보너스를 함께 회수한다', () => {
  // 맥스 2,000+500에서 500을 사용하면 기준 크레딧부터 사용한 것으로 본다.
  // 정상 환불액 43,500원은 기준 1,500크레딧에 해당하고, 남은 보너스 500도 함께 회수한다.
  const plan = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 58000, balanceAmount: 14500 },
    order: {
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      safeCredits: 2500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1'
    },
    currentCredits: 2000,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(plan.applicable, true);
  assert.equal(plan.orderStatus, 'partially_refunded');
  assert.equal(plan.canceledAmount, 43500);
  assert.equal(plan.targetPaidCredits, 1500);
  assert.equal(plan.bonusRevocationTargetCredits, 500);
  assert.equal(plan.targetCredits, 2000);
  assert.equal(plan.balanceDebit, 2000);
  assert.equal(plan.unrecoveredCredits, 0);
});

test('이벤트 보너스를 일부 사용해도 외부 취소 회수 목표에서 사라지지 않는다', () => {
  // 총 2,500 중 2,200을 사용: paid-first라서 기준 2,000과 보너스 200이 소진되었다.
  const plan = buildCreditCancellationPlan({
    payment: { status: 'CANCELED', totalAmount: 58000, balanceAmount: 0 },
    order: {
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      safeCredits: 2500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1'
    },
    currentCredits: 300,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(plan.targetPaidCredits, 2000);
  assert.equal(plan.bonusRevocationTargetCredits, 500);
  assert.equal(plan.targetCredits, 2500);
  assert.equal(plan.balanceDebit, 300);
  assert.equal(plan.unrecoveredCredits, 2200);
});

test('공급자 부분취소 목표는 취소 주문 lot 회수와 교차해 기준 1,500+보너스 500으로 정산된다', () => {
  const providerPlan = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 58000, balanceAmount: 14500 },
    order: {
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1'
    },
    currentCredits: 2000,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  const allocation = allocateProviderCancellation({
    targetCredits: providerPlan.targetCredits,
    accountedCredits: providerPlan.accountedCredits,
    globalBalance: 2000,
    trackedBalance: 2000,
    canceledOrderId: 'max',
    // 사용 500은 paid-first로 기록돼 paid 1,500 + bonus 500이 남아 있다.
    canceledLot: trackedLot('max', 1500, 500),
    otherLots: [],
    usesBaseCreditPolicy: providerPlan.refundCreditBasis === 'paid_credits_first'
  });

  assert.equal(providerPlan.canceledAmount, 43500);
  assert.equal(providerPlan.targetPaidCredits, 1500);
  assert.equal(providerPlan.bonusRevocationTargetCredits, 500);
  assert.equal(allocation.balanceDebit, 2000);
  assert.equal(allocation.ownLotCredits, 2000);
  assert.equal(allocation.unrecoveredCredits, 0);
  assert.deepEqual(allocation.allocations[0], {
    orderId: 'max',
    paidCredits: 1500,
    bonusCredits: 500,
    totalCredits: 2000,
    source: 'canceled_order'
  });
});

test('레거시 공급자 취소 계획은 신규 주문 lot 잔액이 섞여 있어도 untracked만 차감한다', () => {
  const providerPlan = buildCreditCancellationPlan({
    payment: { status: 'CANCELED', totalAmount: 2900, balanceAmount: 0 },
    order: { amount: 2900, safeCredits: 110 },
    currentCredits: 2600,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  const allocation = allocateProviderCancellation({
    targetCredits: providerPlan.targetCredits,
    accountedCredits: providerPlan.accountedCredits,
    globalBalance: 2600,
    trackedBalance: 2500,
    canceledOrderId: 'legacy',
    canceledLot: null,
    otherLots: [trackedLot('new-order', 2000, 500)],
    usesBaseCreditPolicy: providerPlan.refundCreditBasis === 'paid_credits_first'
  });

  assert.equal(providerPlan.refundCreditBasis, 'legacy_total_grant');
  assert.equal(allocation.balanceDebit, 100);
  assert.equal(allocation.unrecoveredCredits, 10);
  assert.equal(allocation.trackedCredits, 0);
  assert.deepEqual(allocation.lotUpdates, []);
});

test('신규 주문의 회수 목표는 현재 지갑 잔액이 아니라 누적 취소액과 주문 보너스로만 결정된다', () => {
  const common = {
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 58000, balanceAmount: 29000 },
    order: {
      amount: 58000,
      paidCredits: 2000,
      safeCredits: 2500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1'
    },
    knownRefundLedgerCredits: 0,
    userExists: true
  };
  const funded = buildCreditCancellationPlan({ ...common, currentCredits: 2500 });
  const depleted = buildCreditCancellationPlan({ ...common, currentCredits: 0 });
  assert.equal(funded.targetCredits, 1500);
  assert.equal(depleted.targetCredits, 1500);
  assert.equal(funded.balanceDebit, 1500);
  assert.equal(depleted.balanceDebit, 0);
  assert.equal(depleted.unrecoveredCredits, 1500);
});

test('레거시 주문의 외부 부분취소는 기존 총 지급량 비례 계산을 유지한다', () => {
  const plan = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 8700, balanceAmount: 4700 },
    order: { amount: 8700, safeCredits: 330 },
    currentCredits: 330,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(plan.refundCreditBasis, 'legacy_total_grant');
  assert.equal(plan.canceledAmount, 4000);
  assert.equal(plan.targetCredits, 151);
  assert.equal(plan.balanceDebit, 151);
  assert.equal(plan.unrecoveredCredits, 0);

  const partiallyMigrated = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 8700, balanceAmount: 4700 },
    order: { amount: 8700, safeCredits: 330, totalGrantedCredits: 999 },
    currentCredits: 330,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(partiallyMigrated.refundCreditBasis, 'legacy_total_grant');
  assert.equal(partiallyMigrated.targetCredits, 151, '명시적 v1 표식가 없으면 기존 safeCredits 기준을 유지한다');
});

test('누적 취소 재조회는 이미 회수한 크레딧보다 목표를 낮추지 않는다', () => {
  const plan = buildCreditCancellationPlan({
    payment: { status: 'PARTIAL_CANCELED', totalAmount: 58000, balanceAmount: 29000 },
    order: {
      amount: 58000,
      paidCredits: 2000,
      safeCredits: 2500,
      totalGrantedCredits: 2500,
      refundedCredits: 1500,
      creditGrantPolicyVersion: 'credit-grant-base-v1'
    },
    // 첫 재정산 후 나머지 잔액까지 사용한 경우에도 누적 회수량은 역행하지 않는다.
    currentCredits: 0,
    knownRefundLedgerCredits: 1500,
    userExists: true
  });
  assert.equal(plan.targetCredits, 1500);
  assert.equal(plan.accountedCredits, 1500);
  assert.equal(plan.balanceDebit, 0);
  assert.equal(plan.unrecoveredCredits, 0);
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
  const requestRace = buildCreditCancellationPlan({
    payment: { status: 'CANCELED', totalAmount: 2900, balanceAmount: 0 },
    order: {
      amount: 2900,
      paidCredits: 100,
      totalGrantedCredits: 105,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      // 사용자 요청에서 지갑/lot은 이미 예약 차감됐지만 승인 최종화 전이라
      // refundedCredits/refundedAmount는 아직 기록되지 않은 경합 상태다.
      refundProcessing: {
        operationId: 'request-race-op',
        phase: 'provider_canceling',
        priorRefundedCredits: 0,
        targetRefundedAmount: 2900,
        targetRefundedCredits: 105,
        creditsToDeduct: 105
      }
    },
    // 다른 주문에서 남은 105크레딧을 예약분 대신 다시 차감하면 안 된다.
    currentCredits: 105,
    knownRefundLedgerCredits: 0,
    userExists: true
  });
  assert.equal(requestRace.processingReserved, 105);
  assert.equal(requestRace.accountedCredits, 105);
  assert.equal(requestRace.balanceDebit, 0);
  assert.equal(requestRace.ledgerCredits, 105);
  assert.equal(requestRace.appliedCredits, 105);
  assert.equal(requestRace.unrecoveredCredits, 0);
  assert.equal(requestRace.clearProcessing, true);

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
