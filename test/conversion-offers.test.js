'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CREDIT_PRODUCT_BASES,
  CREDIT_PRODUCTS,
  EXTRA_CREDIT_EVENT,
  buildCheckoutContext,
  extraCreditEventActive,
  firstPurchaseBonusCredits,
  firstPurchaseBonusRate,
  firstPurchaseExperiment,
  getCreditProduct,
  isRetainedPaidOrder,
  resolveFirstPurchaseGrant
} = require('../lib/conversionOffers');

const DURING_EVENT_MS = Date.parse('2026-09-15T12:00:00+09:00');
const EVENT_LAST_MS = Date.parse('2026-09-30T23:59:59.999+09:00');
const EVENT_END_MS = Date.parse('2026-10-01T00:00:00+09:00');
const AMOUNTS = [2900, 8700, 14500, 29000, 58000];

test('추가 크레딧 이벤트는 상품별 5·10·15·20·25%를 정확히 지급한다', () => {
  const expected = [
    { amount: 2900, baseCredits: 100, eventBonusRate: 5, eventBonusCredits: 5, totalCredits: 105 },
    { amount: 8700, baseCredits: 300, eventBonusRate: 10, eventBonusCredits: 30, totalCredits: 330 },
    { amount: 14500, baseCredits: 500, eventBonusRate: 15, eventBonusCredits: 75, totalCredits: 575 },
    { amount: 29000, baseCredits: 1000, eventBonusRate: 20, eventBonusCredits: 200, totalCredits: 1200 },
    { amount: 58000, baseCredits: 2000, eventBonusRate: 25, eventBonusCredits: 500, totalCredits: 2500 }
  ];

  assert.deepEqual(Object.values(CREDIT_PRODUCT_BASES).map(({ amount, baseCredits }) => ({ amount, baseCredits })),
    expected.map(({ amount, baseCredits }) => ({ amount, baseCredits })));
  assert.deepEqual(AMOUNTS.map((amount) => {
    const product = getCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} });
    return {
      amount: product.amount,
      baseCredits: product.baseCredits,
      eventBonusRate: product.eventBonusRate,
      eventBonusCredits: product.eventBonusCredits,
      totalCredits: product.totalCredits
    };
  }), expected);

  // 정적 카탈로그도 현재 이벤트 표시와 동일해야 한다.
  assert.deepEqual(AMOUNTS.map((amount) => CREDIT_PRODUCTS[amount].credits), [105, 330, 575, 1200, 2500]);
});

test('이벤트는 2026-09-30 KST 끝까지 포함하고 10월 1일 0시에 종료한다', () => {
  assert.equal(EXTRA_CREDIT_EVENT.displayEndsOn, '2026-09-30');
  assert.equal(EXTRA_CREDIT_EVENT.endsAtMs, EVENT_END_MS);
  assert.equal(extraCreditEventActive(EVENT_LAST_MS, {}), true);
  assert.equal(extraCreditEventActive(EVENT_END_MS, {}), false);
  assert.equal(extraCreditEventActive(DURING_EVENT_MS, { EXTRA_CREDIT_EVENT_ENABLED: '0' }), false);

  const atDeadline = getCreditProduct(58000, { nowMs: EVENT_LAST_MS, env: {} });
  assert.equal(atDeadline.eventBonusCredits, 500);
  assert.equal(atDeadline.totalCredits, 2500);

  const afterDeadline = getCreditProduct(58000, { nowMs: EVENT_END_MS, env: {} });
  assert.equal(afterDeadline.eventActive, false);
  assert.equal(afterDeadline.eventBonusRate, 0);
  assert.equal(afterDeadline.eventBonusCredits, 0);
  assert.equal(afterDeadline.totalCredits, 2000);
});

test('첫 구매 보너스는 폐지되어 이벤트 보너스와 중복되지 않는다', () => {
  const experiment = firstPurchaseExperiment('same-user', 58000, {
    FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100',
    FIRST_PURCHASE_BONUS_RATE_58000: '99'
  });
  assert.equal(experiment.variant, 'retired');
  assert.equal(experiment.bonusRate, 0);
  assert.equal(firstPurchaseBonusRate(58000), 0);
  assert.equal(firstPurchaseBonusCredits(2500, 25), 0);
  assert.deepEqual(resolveFirstPurchaseGrant({
    uid: 'new-buyer', amount: 58000, hasPriorPaidOrder: false, conversion: {}
  }), {
    isFirstPurchase: false,
    experimentKey: 'first_purchase_bonus_retired_20260829',
    experimentVariant: 'retired',
    bonusRate: 0,
    bonusCredits: 0
  });

  const context = buildCheckoutContext(
    { uid: 'new-buyer', credits: 10, orders: [], conversion: {} },
    { FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT: '100' },
    DURING_EVENT_MS
  );
  assert.equal(context.eligibleForFirstPurchaseOffer, false);
  assert.ok(context.firstPurchaseOffers.every((offer) => offer.bonusRate === 0 && offer.bonusCredits === 0));
  assert.deepEqual(context.firstPurchaseOffers.map((offer) => offer.totalCredits), [105, 330, 575, 1200, 2500]);
});

test('체크아웃 컨텍스트는 이벤트 기간과 기준·보너스·총 지급량을 분리해 내려보낸다', () => {
  const context = buildCheckoutContext(
    { uid: 'new', credits: 10, orders: [], conversion: {} },
    {},
    DURING_EVENT_MS
  );
  assert.deepEqual(context.creditEvent, {
    id: 'extra-credit-2026-09',
    active: true,
    displayEndsOn: '2026-09-30',
    endsAtMs: EVENT_END_MS
  });
  assert.deepEqual(context.creditOffers.map((offer) => [
    offer.amount,
    offer.baseCredits,
    offer.eventBonusRate,
    offer.eventBonusCredits,
    offer.totalCredits
  ]), [
    [2900, 100, 5, 5, 105],
    [8700, 300, 10, 30, 330],
    [14500, 500, 15, 75, 575],
    [29000, 1000, 20, 200, 1200],
    [58000, 2000, 25, 500, 2500]
  ]);
  assert.deepEqual(context.starterOffer, {
    amount: 2900,
    baseCredits: 100,
    bonusCredits: 5,
    eventBonusCredits: 5,
    totalCredits: 105
  });
});

test('신규·체험 사용자 세그먼트를 기존대로 유지한다', () => {
  const unused = buildCheckoutContext({ uid: 'u1', credits: 10, orders: [] }, {}, DURING_EVENT_MS);
  const engaged = buildCheckoutContext({ uid: 'u2', credits: 4, orders: [] }, {}, DURING_EVENT_MS);
  assert.equal(unused.segment, 'trial_unused');
  assert.equal(engaged.segment, 'trial_engaged');
  assert.equal(unused.starterOffer.totalCredits, 105);
});

test('재구매 저잔액 사용자는 가장 최근의 인식 가능한 상품을 받는다', () => {
  const context = buildCheckoutContext({
    uid: 'payer',
    credits: 3,
    orders: [
      { amount: 2900, status: 'paid', createdAt: '2026-01-01T00:00:00Z' },
      { amount: 14500, status: 'partially_refunded', refundedAmount: 1000, createdAt: '2026-02-01T00:00:00Z' }
    ]
  }, {}, DURING_EVENT_MS);
  assert.equal(context.segment, 'returning_low_balance');
  assert.equal(context.paidOrderCount, 2);
  assert.equal(context.lastPackage.amount, 14500);
  assert.equal(context.lastPackage.baseCredits, 500);
  assert.equal(context.lastPackage.eventBonusCredits, 75);
  assert.equal(context.lastPackage.totalCredits, 575);
  assert.equal(context.eligibleForFirstPurchaseOffer, false);
});

test('전액 환불 및 refunded 주문은 유지된 구매로 세지 않는다', () => {
  assert.equal(isRetainedPaidOrder({ amount: 2900, status: 'refunded' }), false);
  assert.equal(isRetainedPaidOrder({ amount: 2900, refundedAmount: 2900, status: 'partially_refunded' }), false);
  assert.equal(isRetainedPaidOrder({ amount: 2900, refundedAmount: 1000, status: 'partially_refunded' }), true);
});

test('상위 상품일수록 이벤트 후 크레딧 당 가격이 낮아진다', () => {
  const totals = [105, 330, 575, 1200, 2500];
  const unitPrices = AMOUNTS.map((amount, index) => amount / totals[index]);
  for (let i = 1; i < unitPrices.length; i += 1) {
    assert.ok(unitPrices[i] < unitPrices[i - 1], `${AMOUNTS[i]}원 티어는 직전 티어보다 크레딧 당 가격이 낮아야 한다`);
  }
  assert.deepEqual(unitPrices.map((value) => Number(value.toFixed(2))), [27.62, 26.36, 25.22, 24.17, 23.2]);
});
