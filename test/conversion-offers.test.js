'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CREDIT_PRODUCT_BASES,
  CREDIT_PRODUCTS,
  EXTRA_CREDIT_EVENT,
  FREE_TRIAL_CREDITS,
  STARTER_UPGRADE,
  buildCheckoutContext,
  buildStarterUpgradeGrant,
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

test('상시 패키지 보너스와 전 상품 5% 이벤트 보너스를 분리해 지급한다', () => {
  const expected = [
    { amount: 2900, baseCredits: 100, packageBonusCredits: 0, eventBonusCredits: 5, totalCredits: 105 },
    { amount: 8700, baseCredits: 300, packageBonusCredits: 30, eventBonusCredits: 15, totalCredits: 345 },
    { amount: 14500, baseCredits: 500, packageBonusCredits: 125, eventBonusCredits: 25, totalCredits: 650 },
    { amount: 29000, baseCredits: 1000, packageBonusCredits: 350, eventBonusCredits: 50, totalCredits: 1400 },
    { amount: 58000, baseCredits: 2000, packageBonusCredits: 900, eventBonusCredits: 100, totalCredits: 3000 }
  ];

  assert.deepEqual(Object.values(CREDIT_PRODUCT_BASES).map(({ amount, baseCredits }) => ({ amount, baseCredits })),
    expected.map(({ amount, baseCredits }) => ({ amount, baseCredits })));
  assert.deepEqual(AMOUNTS.map((amount) => {
    const product = getCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} });
    return {
      amount: product.amount,
      baseCredits: product.baseCredits,
      packageBonusCredits: product.packageBonusCredits,
      eventBonusCredits: product.eventBonusCredits,
      totalCredits: product.totalCredits
    };
  }), expected);

  // 정적 카탈로그도 현재 이벤트 표시와 동일해야 한다.
  assert.deepEqual(AMOUNTS.map((amount) => CREDIT_PRODUCTS[amount].credits), [105, 345, 650, 1400, 3000]);
});

test('이벤트는 2026-09-30 KST 끝까지 포함하고 10월 1일 0시에 종료한다', () => {
  assert.equal(EXTRA_CREDIT_EVENT.displayEndsOn, '2026-09-30');
  assert.equal(EXTRA_CREDIT_EVENT.endsAtMs, EVENT_END_MS);
  assert.equal(extraCreditEventActive(EVENT_LAST_MS, {}), true);
  assert.equal(extraCreditEventActive(EVENT_END_MS, {}), false);
  assert.equal(extraCreditEventActive(DURING_EVENT_MS, { EXTRA_CREDIT_EVENT_ENABLED: '0' }), false);

  const atDeadline = getCreditProduct(58000, { nowMs: EVENT_LAST_MS, env: {} });
  assert.equal(atDeadline.eventBonusCredits, 100);
  assert.equal(atDeadline.totalCredits, 3000);

  const afterDeadline = getCreditProduct(58000, { nowMs: EVENT_END_MS, env: {} });
  assert.equal(afterDeadline.eventActive, false);
  assert.equal(afterDeadline.eventBonusRate, 0);
  assert.equal(afterDeadline.eventBonusCredits, 0);
  assert.equal(afterDeadline.packageBonusCredits, 900);
  assert.equal(afterDeadline.totalCredits, 2900);
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
  assert.deepEqual(context.firstPurchaseOffers.map((offer) => offer.totalCredits), [105, 345, 650, 1400, 3000]);
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
    offer.packageBonusCredits,
    offer.eventBonusCredits,
    offer.totalCredits
  ]), [
    [2900, 100, 0, 5, 105],
    [8700, 300, 30, 15, 345],
    [14500, 500, 125, 25, 650],
    [29000, 1000, 350, 50, 1400],
    [58000, 2000, 900, 100, 3000]
  ]);
  assert.deepEqual(context.starterOffer, {
    amount: 2900,
    baseCredits: 100,
    bonusCredits: 5,
    packageBonusCredits: 0,
    eventBonusCredits: 5,
    totalCredits: 105
  });
});

test('25크레딧 가입 지급액을 기준으로 신규·체험 사용자 세그먼트를 나눈다', () => {
  const unused = buildCheckoutContext({ uid: 'u1', credits: FREE_TRIAL_CREDITS, orders: [] }, {}, DURING_EVENT_MS);
  const engaged = buildCheckoutContext({ uid: 'u2', credits: FREE_TRIAL_CREDITS - 1, orders: [] }, {}, DURING_EVENT_MS);
  const unfunded = buildCheckoutContext({ uid: 'u3', credits: FREE_TRIAL_CREDITS + 1, orders: [] }, {}, DURING_EVENT_MS);
  assert.equal(FREE_TRIAL_CREDITS, 25);
  assert.equal(unused.segment, 'trial_unused');
  assert.equal(engaged.segment, 'trial_engaged');
  assert.equal(unfunded.segment, 'new_unfunded');
  assert.equal(unused.starterOffer.totalCredits, 105);
});

test('재구매 저잔액 사용자는 가장 최근의 인식 가능한 상품을 받는다', () => {
  const context = buildCheckoutContext({
    uid: 'payer',
    credits: 3,
    orders: [
      { id: 'old-starter', amount: 2900, status: 'paid', createdAt: '2026-01-01T00:00:00Z', paidCredits: 100, safeCredits: 105, eventBonusCredits: 5 },
      { id: 'old-standard', amount: 14500, status: 'partially_refunded', refundedAmount: 1000, createdAt: '2026-02-01T00:00:00Z', paidCredits: 500, safeCredits: 575, eventBonusCredits: 75 }
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
  const totals = [105, 345, 650, 1400, 3000];
  const unitPrices = AMOUNTS.map((amount, index) => amount / totals[index]);
  for (let i = 1; i < unitPrices.length; i += 1) {
    assert.ok(unitPrices[i] < unitPrices[i - 1], `${AMOUNTS[i]}원 티어는 직전 티어보다 크레딧 당 가격이 낮아야 한다`);
  }
  assert.deepEqual(unitPrices.map((value) => Number(value.toFixed(2))), [27.62, 25.22, 22.31, 20.71, 19.33]);
});

test('스타터→스탠다드 업그레이드 grant는 서버 주문 스냅샷으로만 계산하고 기본 비활성이다', () => {
  const createdAt = '2026-09-15T00:00:00+09:00';
  const source = {
    id: 'order_starter_eligible',
    uid: 'u-upgrade',
    amount: 2900,
    status: 'paid',
    paidCredits: 100,
    safeCredits: 105,
    eventBonusCredits: 5,
    createdAt
  };
  const nowMs = Date.parse('2026-09-20T00:00:00+09:00');
  const grant = buildStarterUpgradeGrant(source, { nowMs, env: {} });
  assert.equal(grant.amount, 11600);
  assert.equal(grant.paidCredits, 400);
  assert.equal(grant.packageBonusCredits, 125);
  assert.equal(grant.eventBonusCredits, 20);
  assert.equal(grant.totalCredits, 545);
  assert.equal(grant.cumulativeCredits, 650);

  const disabled = buildCheckoutContext({ uid: 'u-upgrade', credits: 105, orders: [source] }, {}, nowMs);
  assert.equal(disabled.starterUpgradeEnabled, false);
  assert.equal(disabled.upgradeOffer, null);
  const partiallyEnabled = buildCheckoutContext(
    { uid: 'u-upgrade', credits: 105, orders: [source] },
    { STARTER_STANDARD_UPGRADE_ENABLED: '1' },
    nowMs
  );
  assert.equal(partiallyEnabled.starterUpgradeEnabled, false, '연결 환불 안전 플래그 없이 단독 활성화 금지');

  const enabled = buildCheckoutContext(
    { uid: 'u-upgrade', credits: 105, orders: [source] },
    {
      STARTER_STANDARD_UPGRADE_ENABLED: '1',
      STARTER_STANDARD_UPGRADE_LINKED_REFUND_ENABLED: '1'
    },
    nowMs
  );
  assert.equal(enabled.upgradeOffer.additionalAmount, STARTER_UPGRADE.additionalAmount);
  assert.equal(enabled.upgradeOffer.additionalCredits, 545);
  assert.equal(enabled.upgradeOffer.cumulativeCredits, 650);

  assert.ok(buildStarterUpgradeGrant(source, {
    nowMs: Date.parse('2026-09-22T00:00:00+09:00'), env: {}
  }));
  assert.equal(buildStarterUpgradeGrant(source, {
    nowMs: Date.parse('2026-09-22T00:00:00.001+09:00'), env: {}
  }), null);
  assert.equal(buildStarterUpgradeGrant({ ...source, upgradeOrderId: 'order_used' }, { nowMs, env: {} }), null);
});

test('이벤트 중 산 스타터를 이벤트 종료 후 업그레이드해도 당시 목표 총량을 넘지 않는다', () => {
  const source = {
    id: 'order_starter_event_boundary',
    amount: 2900,
    status: 'paid',
    paidCredits: 100,
    safeCredits: 105,
    packageBonusCredits: 0,
    eventBonusCredits: 5,
    createdAt: '2026-09-29T12:00:00+09:00'
  };
  const grant = buildStarterUpgradeGrant(source, {
    nowMs: Date.parse('2026-10-01T12:00:00+09:00'),
    env: {}
  });
  assert.equal(grant.paidCredits, 400);
  assert.equal(grant.packageBonusCredits, 120);
  assert.equal(grant.eventBonusCredits, 0);
  assert.equal(grant.totalCredits, 520);
  assert.equal(grant.cumulativeCredits, 625);
});

test('정확한 주문 lot 소진율이 70% 이상일 때만 스탠다드 추천을 만든다', () => {
  const order = {
    id: 'order_latest_light', amount: 8700, status: 'paid', paidCredits: 300,
    safeCredits: 345, packageBonusCredits: 30, eventBonusCredits: 15,
    createdAt: '2026-09-20T00:00:00+09:00'
  };
  const context = buildCheckoutContext({
    uid: 'u-usage', credits: 100, orders: [order],
    creditLots: [{
      id: order.id,
      refundPaidCreditsRemaining: 90,
      refundEventBonusCreditsRemaining: 10
    }]
  }, {}, Date.parse('2026-09-21T00:00:00+09:00'));
  assert.ok(context.usage.consumedRatio > 0.7);
  assert.equal(context.recommendation.amount, 14500);
  assert.equal(context.recommendation.reasonCode, 'last_package_70_percent_consumed');
});
