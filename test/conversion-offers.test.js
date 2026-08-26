const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CREDIT_PRODUCTS,
  buildCheckoutContext,
  firstPurchaseExperiment,
  isRetainedPaidOrder,
  resolveFirstPurchaseGrant
} = require('../lib/conversionOffers');

test('first-purchase experiment assignment is stable and bounded', () => {
  const env = {
    FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100',
    FIRST_PURCHASE_BONUS_CREDITS: '50'
  };
  const first = firstPurchaseExperiment('same-user', env);
  const second = firstPurchaseExperiment('same-user', env);
  assert.deepEqual(first, second);
  assert.equal(first.bonusCredits, 20);
  assert.equal(first.variant, 'bonus_20');
});

test('unused trial and engaged trial users get distinct segments', () => {
  const controlEnv = { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '0' };
  const unused = buildCheckoutContext({ uid: 'u1', credits: 10, orders: [], conversion: {} }, controlEnv);
  const engaged = buildCheckoutContext({ uid: 'u2', credits: 4, orders: [], conversion: {} }, controlEnv);
  assert.equal(unused.segment, 'trial_unused');
  assert.equal(engaged.segment, 'trial_engaged');
  assert.equal(unused.starterOffer.totalCredits, 110);
});

test('returning low-balance users receive their latest recognized package', () => {
  const context = buildCheckoutContext({
    uid: 'payer',
    credits: 3,
    conversion: {},
    orders: [
      { amount: 2900, status: 'paid', createdAt: '2026-01-01T00:00:00Z' },
      { amount: 14500, status: 'partially_refunded', refundedAmount: 1000, createdAt: '2026-02-01T00:00:00Z' }
    ]
  });
  assert.equal(context.segment, 'returning_low_balance');
  assert.equal(context.paidOrderCount, 2);
  assert.deepEqual(context.lastPackage, { amount: 14500, credits: 600, label: '스탠다드' });
  assert.equal(context.eligibleForFirstPurchaseOffer, false);
});

test('fully refunded and refunded-status orders do not count as retained purchases', () => {
  assert.equal(isRetainedPaidOrder({ amount: 2900, status: 'refunded' }), false);
  assert.equal(isRetainedPaidOrder({ amount: 2900, refundedAmount: 2900, status: 'partially_refunded' }), false);
  assert.equal(isRetainedPaidOrder({ amount: 2900, refundedAmount: 1000, status: 'partially_refunded' }), true);
});

test('recorded first purchase prevents a later bonus even without an order snapshot', () => {
  const context = buildCheckoutContext({
    uid: 'marked',
    credits: 0,
    orders: [],
    conversion: { firstPurchaseOrderId: 'order_old' }
  }, {
    FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100',
    FIRST_PURCHASE_BONUS_CREDITS: '10'
  });
  assert.equal(context.eligibleForFirstPurchaseOffer, false);
  assert.equal(context.starterOffer.bonusCredits, 0);
});

test('payment grant uses the same eligibility rule and never repeats the bonus', () => {
  const env = {
    FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100',
    FIRST_PURCHASE_BONUS_CREDITS: '10'
  };
  const first = resolveFirstPurchaseGrant({ uid: 'buyer', hasPriorPaidOrder: false, conversion: {} }, env);
  const marked = resolveFirstPurchaseGrant({ uid: 'buyer', hasPriorPaidOrder: false, conversion: { firstPurchaseOrderId: 'order_1' } }, env);
  const prior = resolveFirstPurchaseGrant({ uid: 'buyer', hasPriorPaidOrder: true, conversion: {} }, env);
  assert.deepEqual(first, {
    isFirstPurchase: true,
    experimentKey: 'first_purchase_bonus_v1',
    experimentVariant: 'bonus_10',
    bonusCredits: 10
  });
  assert.equal(marked.bonusCredits, 0);
  assert.equal(marked.experimentVariant, 'ineligible');
  assert.equal(prior.bonusCredits, 0);
});

test('크레딧 사다리는 라이트 350을 포함해 단가가 단조 감소한다', () => {
  // 2026-08-26 사장님 승인: 라이트 330→350 — 스타터 3회(=330)와 동일하던 죽은 티어 수리.
  // 이 값은 지급량의 소스 오브 트루스다(프론트 표기는 참고용). 프론트 PLANS와 함께 바꿔야 한다.
  assert.equal(CREDIT_PRODUCTS[8700].credits, 350);
  const perCredit = [2900, 8700, 14500, 29000, 58000].map(a => a / CREDIT_PRODUCTS[a].credits);
  for (let i = 1; i < perCredit.length; i++) {
    assert.ok(perCredit[i] < perCredit[i - 1], `${i}번째 티어 단가가 이전보다 싸야 한다`);
  }
});
