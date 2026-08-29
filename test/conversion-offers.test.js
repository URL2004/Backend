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
  const env = { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100' };
  const first = firstPurchaseExperiment('same-user', 8700, env);
  const second = firstPurchaseExperiment('same-user', 8700, env);
  assert.deepEqual(first, second);
  assert.equal(first.bonusRate, 8);
  assert.equal(first.variant, 'rate_8');
  // 상품별 상한 30%: 환경변수로도 그 위로는 못 올린다
  assert.equal(firstPurchaseExperiment('u', 8700, { ...env, FIRST_PURCHASE_BONUS_RATE_8700: '99' }).bonusRate, 30);
});

test('첫 구매 보너스는 상위 상품일수록 높은 비율이고 단가 사다리를 뒤집지 않는다', () => {
  // 2026-08-29 사장님 승인: 종전 정액 +10은 스타터(120=24.17원)와 라이트(360=24.17원)의
  // 단가를 동일하게 만들어 첫 구매에서 상위 상품을 고를 이유를 없앴다.
  const env = { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100' };
  const amounts = [2900, 8700, 14500, 29000, 58000];
  const expected = { 2900: 6, 8700: 32, 14500: 70, 29000: 180, 58000: 495 };
  const firstPurchaseUnit = amounts.map((amount) => {
    const grant = resolveFirstPurchaseGrant({ uid: 'buyer', amount, hasPriorPaidOrder: false, conversion: {} }, env);
    assert.equal(grant.bonusCredits, expected[amount], `${amount}원 첫 구매 보너스`);
    return amount / (CREDIT_PRODUCTS[amount].credits + grant.bonusCredits);
  });
  for (let i = 1; i < firstPurchaseUnit.length; i++) {
    assert.ok(firstPurchaseUnit[i] < firstPurchaseUnit[i - 1], `${i}번째 티어의 첫 구매 단가가 이전보다 싸야 한다`);
  }
});

test('체크아웃 컨텍스트는 전 상품의 첫 구매 보너스를 내려보낸다', () => {
  // 화면이 다섯 카드 모두에 보너스를 명시하므로 상품별 지급량이 필요하다(2026-08-29)
  const env = { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100' };
  const eligible = buildCheckoutContext({ uid: 'new', credits: 10, orders: [], conversion: {} }, env);
  assert.equal(eligible.firstPurchaseOffers.length, 5);
  assert.deepEqual(
    eligible.firstPurchaseOffers.map((o) => [o.amount, o.bonusCredits, o.totalCredits]),
    [[2900, 6, 116], [8700, 32, 432], [14500, 70, 770], [29000, 180, 1680], [58000, 495, 3795]]
  );
  const used = buildCheckoutContext({
    uid: 'old', credits: 3, conversion: {},
    orders: [{ amount: 2900, status: 'paid', createdAt: '2026-01-01T00:00:00Z' }]
  }, env);
  assert.ok(used.firstPurchaseOffers.every((o) => o.bonusCredits === 0), '재구매자에겐 보너스 0');
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
  assert.deepEqual(context.lastPackage, { amount: 14500, credits: 700, label: '스탠다드' });
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
  }, { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100' });
  assert.equal(context.eligibleForFirstPurchaseOffer, false);
  assert.equal(context.starterOffer.bonusCredits, 0);
});

test('payment grant uses the same eligibility rule and never repeats the bonus', () => {
  const env = { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100' };
  const at = (extra) => resolveFirstPurchaseGrant({ uid: 'buyer', amount: 2900, ...extra }, env);
  const first = at({ hasPriorPaidOrder: false, conversion: {} });
  const marked = at({ hasPriorPaidOrder: false, conversion: { firstPurchaseOrderId: 'order_1' } });
  const prior = at({ hasPriorPaidOrder: true, conversion: {} });
  assert.deepEqual(first, {
    isFirstPurchase: true,
    experimentKey: 'first_purchase_bonus_v2',
    experimentVariant: 'rate_5',
    bonusRate: 5,
    bonusCredits: 6
  });
  assert.equal(marked.bonusCredits, 0);
  assert.equal(marked.experimentVariant, 'ineligible');
  assert.equal(prior.bonusCredits, 0);
});

test('크레딧 사다리는 같은 금액을 스타터로 나눠 사는 것보다 확실히 유리하다', () => {
  // 2026-08-29 사장님 승인(6~8월 주문 2,517건 실측 기반). 이 값이 지급량의 소스 오브 트루스다.
  // 프론트 PLANS·pricing.html·landing.html과 함께 바꿔야 한다(claims 테스트가 강제).
  assert.equal(CREDIT_PRODUCTS[8700].credits, 400);
  const starter = CREDIT_PRODUCTS[2900].credits;   // 110
  // 같은 금액을 스타터로 쪼개 살 때 대비 이득 — 종전엔 라이트 +6%·스탠다드 +9%로 상위 상품을 살 이유가 없었다
  const minGain = { 8700: 0.20, 14500: 0.25, 29000: 0.35, 58000: 0.45 };
  for (const [amount, floor] of Object.entries(minGain)) {
    const splits = Number(amount) / 2900;
    const gain = CREDIT_PRODUCTS[amount].credits / (starter * splits) - 1;
    assert.ok(gain >= floor, `${amount}원은 스타터 ${splits}회 대비 ${Math.round(floor * 100)}% 이상 유리해야 함(현재 ${Math.round(gain * 100)}%)`);
  }
  const perCredit = [2900, 8700, 14500, 29000, 58000].map(a => a / CREDIT_PRODUCTS[a].credits);
  for (let i = 1; i < perCredit.length; i++) {
    assert.ok(perCredit[i] < perCredit[i - 1], `${i}번째 티어 단가가 이전보다 싸야 한다`);
  }
});
