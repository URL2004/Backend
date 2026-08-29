'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const payment = require('../routes/payment');

const {
  REFUND_POLICY_VERSION,
  REFUND_WINDOW_MS,
  refundWindowState,
  refundRequestProcessingConflict,
  tossCancellationState,
  creditRefundFinalizeDecision,
  creditRefundGrant,
  calculateCreditPolicyRefund,
  calculateOrderCreditRefund,
  calculateSubscriptionPolicyRefund,
  currentSubscriptionRefundContext,
  activeUpgradeRefundConflict
} = payment.refundPolicy;

test('진행 중인 직접 환불이 있으면 사용자 환불 요청이 같은 주문 상태를 덮지 않는다', () => {
  assert.equal(refundRequestProcessingConflict({ status: 'paid' }), null);
  assert.deepEqual(refundRequestProcessingConflict({
    status: 'paid',
    refundProcessing: { operationId: 'refund-op-1' }
  }), {
    status: 409,
    code: 'REFUND_PROCESSING',
    message: '이미 환불 처리가 진행 중입니다. 잠시 후 상태를 다시 확인해 주세요.'
  });
});

test('활성 업그레이드가 연결된 스타터 주문은 업그레이드 결제를 먼저 환불해야 한다', () => {
  assert.equal(activeUpgradeRefundConflict({ status: 'paid' }), null);
  const conflict = activeUpgradeRefundConflict({ activeUpgradeOrderId: 'order_upgrade_1' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'UPGRADE_REFUND_ORDER_REQUIRED');
  assert.equal(conflict.upgradeOrderId, 'order_upgrade_1');
});

test('상시·이벤트 보너스를 합친 신규 lot도 유료 크레딧 우선 사용 후 전부 회수한다', () => {
  const result = calculateCreditPolicyRefund({
    orderAmount: 58000,
    paidCredits: 2000,
    grantedCredits: 3000,
    currentCredits: 2500,
    remainingPaidCredits: 1500,
    remainingBonusCredits: 1000
  });
  assert.equal(result.refundAmount, 43500);
  assert.equal(result.refundablePaidCredits, 1500);
  assert.equal(result.recoveredBonusCredits, 1000);
  assert.equal(result.refundableCredits, 2500);
});

test('safeCredits가 없는 과거 주문도 credits 총 지급량으로 환불한다', () => {
  assert.deepEqual(creditRefundGrant({ amount: 8700, credits: 330 }), {
    usesBaseCreditPolicy: false,
    usesTrackedLot: false,
    paidCredits: 330,
    totalCredits: 330,
    bonusCredits: 0,
    remainingPaidCredits: null,
    remainingBonusCredits: null,
    refundCreditBasis: 'legacy_total_grant'
  });
});

function processing(operationId, prior = 0, amount = 43500, credits = 2000) {
  return {
    kind: 'credit',
    operationId,
    priorRefundedAmount: prior,
    priorRefundedCredits: 0,
    refundAmount: amount,
    creditsToDeduct: credits,
    targetRefundedAmount: prior + amount,
    targetRefundedCredits: credits
  };
}

test('환불 최종화는 같은 operation만 허용하고 더 큰 누적 환불을 절대 낮추지 않는다', () => {
  const same = creditRefundFinalizeDecision({
    status: 'refund_requested',
    refundedAmount: 43500,
    refundProcessing: processing('op-1')
  }, { operationId: 'op-1', targetRefundedAmount: 43500, orderAmount: 58000 });
  assert.equal(same.ok, true);
  assert.equal(same.finalRefundedAmount, 43500);
  assert.equal(same.fullyRefunded, false);

  const webhookWon = creditRefundFinalizeDecision({
    status: 'refunded',
    refundedAmount: 58000
  }, { operationId: 'op-1', targetRefundedAmount: 43500, orderAmount: 58000 });
  assert.deepEqual(webhookWon, {
    ok: true,
    alreadyFinalized: true,
    finalRefundedAmount: 58000,
    fullyRefunded: true
  });

  assert.equal(creditRefundFinalizeDecision({
    status: 'refund_requested',
    refundedAmount: 0
  }, { operationId: 'op-1', targetRefundedAmount: 43500, orderAmount: 58000 }).reason, 'processing_missing');
  assert.equal(creditRefundFinalizeDecision({
    status: 'refund_requested',
    refundProcessing: processing('op-2')
  }, { operationId: 'op-1', targetRefundedAmount: 43500, orderAmount: 58000 }).reason, 'operation_mismatch');
});

test('환불 응답 유실은 결제사 누적 취소액으로 확정하고 미확정 상태는 재시도로 남긴다', () => {
  const confirmedByLookup = tossCancellationState({
    response: null,
    lookup: {
      response: { ok: true },
      result: { totalAmount: 58000, balanceAmount: 14500 }
    },
    targetRefundedAmount: 43500
  });
  assert.deepEqual(confirmedByLookup, {
    confirmed: true,
    unknown: false,
    lookupCanceledAmount: 43500
  });

  const unknown = tossCancellationState({
    response: null,
    lookup: { response: null, result: {} },
    targetRefundedAmount: 43500
  });
  assert.equal(unknown.confirmed, false);
  assert.equal(unknown.unknown, true);

  const definitiveReject = tossCancellationState({
    response: { ok: false, status: 400 },
    lookup: { response: { ok: true }, result: { totalAmount: 58000, balanceAmount: 58000 } },
    targetRefundedAmount: 43500
  });
  assert.equal(definitiveReject.confirmed, false);
  assert.equal(definitiveReject.unknown, false);
});

function timestamp(ms) {
  return { toMillis: () => ms };
}

test('환불 정책은 결제 후 7일까지 허용하고 그 이후를 차단한다', () => {
  const now = Date.UTC(2026, 6, 20, 12);
  assert.equal(REFUND_POLICY_VERSION, '2026-08-29-base-credit-v1');
  assert.equal(refundWindowState({ createdAt: timestamp(now - REFUND_WINDOW_MS) }, 'order', now).eligible, true);
  assert.equal(refundWindowState({ createdAt: timestamp(now - REFUND_WINDOW_MS - 1) }, 'order', now).eligible, false);
  assert.equal(refundWindowState({}, 'order', now).reason, 'PAYMENT_DATE_MISSING');
});

test('신규 주문은 사용량을 기준 크레딧부터 차감하고 남은 보너스도 함께 회수한다', () => {
  assert.deepEqual(calculateCreditPolicyRefund({
    orderAmount: 58000,
    paidCredits: 2000,
    grantedCredits: 2500,
    currentCredits: 2000
  }), {
    refundAmount: 43500,
    refundableCredits: 2000,
    usedCredits: 500,
    usedPaidCredits: 500,
    refundablePaidCredits: 1500,
    purchasedCredits: 2500,
    grantedCredits: 2500,
    paidCredits: 2000,
    bonusCredits: 500,
    recoveredBonusCredits: 500,
    usesTrackedLot: false
  });
});

test('신규 주문은 미사용 시 전액 환불하고 기준 크레딧을 전부 사용하면 환불액이 0원이다', () => {
  const unused = calculateCreditPolicyRefund({
    orderAmount: 58000,
    paidCredits: 2000,
    grantedCredits: 2500,
    currentCredits: 2500
  });
  assert.equal(unused.refundAmount, 58000);
  assert.equal(unused.refundableCredits, 2500);
  assert.equal(unused.refundablePaidCredits, 2000);
  assert.equal(unused.recoveredBonusCredits, 500);

  // 기준 2,000크레딧을 모두 사용하고 보너스 500만 남은 상태다.
  const paidConsumed = calculateCreditPolicyRefund({
    orderAmount: 58000,
    paidCredits: 2000,
    grantedCredits: 2500,
    currentCredits: 500
  });
  assert.equal(paidConsumed.refundAmount, 0);
  assert.equal(paidConsumed.refundableCredits, 500);
  assert.equal(paidConsumed.usedPaidCredits, 2000);
  assert.equal(paidConsumed.refundablePaidCredits, 0);
});

test('주문별 lot 잔액이 있으면 다른 구매·무료 크레딧과 섞이지 않고 해당 주문만 환불한다', () => {
  const order = {
    amount: 58000,
    paidCredits: 2000,
    eventBonusCredits: 500,
    totalGrantedCredits: 2500,
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    creditLotPolicyVersion: 'credit-lot-v1',
    refundPaidCreditsRemaining: 1500,
    refundEventBonusCreditsRemaining: 500
  };
  const prepared = calculateOrderCreditRefund({
    order,
    user: { credits: 10100, creditLotV1Balance: 2000 }
  });
  assert.equal(prepared.grant.usesTrackedLot, true);
  assert.equal(prepared.calculation.refundAmount, 43500);
  assert.equal(prepared.calculation.refundableCredits, 2000);
  assert.equal(prepared.calculation.recoveredBonusCredits, 500);
});

test('레거시 주문 환불은 신규 주문에 귀속된 tracked 잔액을 사용하지 않는다', () => {
  const prepared = calculateOrderCreditRefund({
    order: { amount: 2900, safeCredits: 100 },
    user: { credits: 2600, creditLotV1Balance: 2500 }
  });
  assert.equal(prepared.grant.usesTrackedLot, false);
  assert.equal(prepared.wallet.untracked, 100);
  assert.equal(prepared.calculation.refundableCredits, 100);
  assert.equal(prepared.calculation.refundAmount, 2900);

  const spentLegacy = calculateOrderCreditRefund({
    order: { amount: 2900, safeCredits: 100 },
    user: { credits: 2500, creditLotV1Balance: 2500 }
  });
  assert.equal(spentLegacy.calculation.refundAmount, 0);
  assert.equal(spentLegacy.calculation.refundableCredits, 0);
});

test('과거 주문은 purchasedCredits 총 지급량 비례 환불 정책을 유지한다', () => {
  const legacy = calculateCreditPolicyRefund({
    orderAmount: 29000,
    purchasedCredits: 1300,
    currentCredits: 1040
  });
  assert.equal(legacy.refundAmount, 23200);
  assert.equal(legacy.refundableCredits, 1040);
  assert.equal(legacy.usedCredits, 260);
  assert.equal(legacy.paidCredits, 1300);
  assert.equal(legacy.bonusCredits, 0);
  assert.equal(calculateCreditPolicyRefund({
    orderAmount: 29000,
    purchasedCredits: 1300,
    currentCredits: 0
  }).refundAmount, 0);
});

test('50회형 구독은 사용 횟수를 공제하고 남은 비율을 환불한다', () => {
  assert.deepEqual(calculateSubscriptionPolicyRefund({
    orderAmount: 54900,
    tier: '5000',
    coupon: { granted: 50, remaining: 45, used: 5 }
  }), {
    refundAmount: 49410,
    usedCount: 5,
    refundableUses: 45,
    settlementUses: 50
  });
});

test('무제한 구독도 환불 정산상 50회를 기준으로 사용분을 공제한다', () => {
  const partial = calculateSubscriptionPolicyRefund({
    orderAmount: 290000,
    tier: 'unlimited',
    coupon: { granted: -1, remaining: -1, used: 2 }
  });
  assert.deepEqual(partial, {
    refundAmount: 278400,
    usedCount: 2,
    refundableUses: 48,
    settlementUses: 50
  });
  assert.equal(calculateSubscriptionPolicyRefund({
    orderAmount: 290000,
    tier: 'unlimited',
    coupon: { granted: -1, remaining: -1, used: 50 }
  }).refundAmount, 0);
});

test('구독 환불은 결제 주문과 현재 쿠폰 주기가 일치해야 한다', () => {
  const paidAtMs = Date.UTC(2026, 6, 20, 12);
  const order = { tier: '5000' };
  const matching = currentSubscriptionRefundContext({
    subscription: { tier: '5000', cycleStartedAt: timestamp(paidAtMs) },
    coupon: { tier: '5000', granted: 50, remaining: 50, used: 0 }
  }, order, paidAtMs);
  assert.equal(matching.sameCycle, true);

  const stale = currentSubscriptionRefundContext({
    subscription: { tier: '5000', cycleStartedAt: timestamp(paidAtMs - 30 * 86400000) },
    coupon: { tier: '5000', granted: 50, remaining: 50, used: 0 }
  }, order, paidAtMs);
  assert.equal(stale.sameCycle, false);
});
