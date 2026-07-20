'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const payment = require('../routes/payment');

const {
  REFUND_POLICY_VERSION,
  REFUND_WINDOW_MS,
  refundWindowState,
  calculateCreditPolicyRefund,
  calculateSubscriptionPolicyRefund,
  currentSubscriptionRefundContext
} = payment.refundPolicy;

function timestamp(ms) {
  return { toMillis: () => ms };
}

test('환불 정책은 결제 후 7일까지 허용하고 그 이후를 차단한다', () => {
  const now = Date.UTC(2026, 6, 20, 12);
  assert.equal(REFUND_POLICY_VERSION, '2026-07-20');
  assert.equal(refundWindowState({ createdAt: timestamp(now - REFUND_WINDOW_MS) }, 'order', now).eligible, true);
  assert.equal(refundWindowState({ createdAt: timestamp(now - REFUND_WINDOW_MS - 1) }, 'order', now).eligible, false);
  assert.equal(refundWindowState({}, 'order', now).reason, 'PAYMENT_DATE_MISSING');
});

test('크레딧은 현재 남은 유료분을 결제금액에 비례해 환불한다', () => {
  assert.deepEqual(calculateCreditPolicyRefund({
    orderAmount: 29000,
    purchasedCredits: 1300,
    currentCredits: 1040
  }), {
    refundAmount: 23200,
    refundableCredits: 1040,
    usedCredits: 260,
    purchasedCredits: 1300
  });
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
