'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CREDIT_OFFER_POLICY_VERSION,
  CREDIT_PRODUCT_BASES,
  CREDIT_PRODUCTS,
  ENTRY_PRODUCT_AMOUNT,
  EXTRA_CREDIT_EVENT,
  FREE_TRIAL_CREDITS,
  PACKAGE_BONUS_RATES,
  STARTER_UPGRADE,
  buildCheckoutContext,
  buildStarterUpgradeGrant,
  extraCreditEventActive,
  firstPurchaseBonusCredits,
  firstPurchaseBonusRate,
  firstPurchaseExperiment,
  getCreditProduct,
  getPurchasableCreditProduct,
  isPurchasableCreditAmount,
  isRetainedPaidOrder,
  resolveFirstPurchaseGrant,
  starterComparisonCredits
} = require('../lib/conversionOffers');

const DURING_EVENT_MS = Date.parse('2026-09-15T12:00:00+09:00');
const EVENT_LAST_MS = Date.parse('2026-09-30T23:59:59.999+09:00');
const EVENT_END_MS = Date.parse('2026-10-01T00:00:00+09:00');
// 2026-09 요금제 개편: 구매 가능 상품은 일반 3종 + 맥스. 2,900·8,700은 종료(해석만), 116,000은 문의 전용.
const AMOUNTS = [5900, 14500, 29000, 58000];
const RETIRED = [2900, 8700];
const INQUIRY = 116000;

test('5,900원 스타터는 이벤트 0%, 나머지 상품은 상시 보너스와 이벤트 5%를 분리해 지급한다', () => {
  const expected = [
    { amount: 5900, baseCredits: 200, packageBonusCredits: 0, eventBonusCredits: 0, totalCredits: 200 },
    { amount: 14500, baseCredits: 500, packageBonusCredits: 125, eventBonusCredits: 25, totalCredits: 650 },
    { amount: 29000, baseCredits: 1000, packageBonusCredits: 350, eventBonusCredits: 50, totalCredits: 1400 },
    { amount: 58000, baseCredits: 2000, packageBonusCredits: 900, eventBonusCredits: 100, totalCredits: 3000 }
  ];

  // 카탈로그 전체(종료·문의 전용 포함) — 주문이 존재하는 금액은 절대 지우지 않는다.
  assert.deepEqual(Object.values(CREDIT_PRODUCT_BASES).map(({ amount, baseCredits, purchasable }) => [amount, baseCredits, purchasable === true]), [
    [2900, 100, false],
    [5900, 200, true],
    [8700, 300, false],
    [14500, 500, true],
    [29000, 1000, true],
    [58000, 2000, true],
    [116000, 4000, false]
  ]);
  assert.equal(ENTRY_PRODUCT_AMOUNT, 5900);
  assert.equal(CREDIT_OFFER_POLICY_VERSION, 'credit-offer-v4-202609');
  assert.deepEqual(PACKAGE_BONUS_RATES, { 2900: 0, 5900: 0, 8700: 10, 14500: 25, 29000: 35, 58000: 45, 116000: 50 });
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
  assert.deepEqual(AMOUNTS.map((amount) => CREDIT_PRODUCTS[amount].credits), [200, 650, 1400, 3000]);
  assert.equal(CREDIT_PRODUCTS[2900].credits, 105);
  assert.equal(CREDIT_PRODUCTS[8700].credits, 345);
  assert.equal(CREDIT_PRODUCTS[INQUIRY].credits, 6200);

  const starter = getCreditProduct(5900, { nowMs: DURING_EVENT_MS, env: {} });
  assert.equal(starter.eventActive, true, '개강 이벤트 기간 자체는 활성 상태다');
  assert.equal(starter.eventBonusRate, 0);
  assert.equal(starter.eventBonusCredits, 0);
  assert.equal(starter.eventId, null, '이벤트 비대상 스타터 주문에는 이벤트 ID를 붙이지 않는다');
  for (const amount of [2900, 8700, 14500, 29000, 58000, INQUIRY]) {
    const product = getCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} });
    assert.equal(product.eventBonusRate, 5, `${amount}원은 +5% 유지`);
    assert.equal(product.eventId, EXTRA_CREDIT_EVENT.id, `${amount}원은 이벤트 ID 유지`);
  }
});

test('종료 상품은 해석만 되고 새 결제로는 열리지 않으며, 비상 스위치로만 되돌린다', () => {
  for (const amount of RETIRED) {
    const product = getCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} });
    assert.ok(product && product.paidCredits > 0, `${amount} 과거 주문 해석 유지`);
    assert.equal(product.purchasable, false);
    assert.equal(product.legacy, true);
    assert.equal(isPurchasableCreditAmount(amount, {}), false);
    assert.equal(getPurchasableCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} }), null);
    assert.equal(isPurchasableCreditAmount(amount, { CREDIT_LEGACY_CHECKOUT_ENABLED: '1' }), true, '비상 복귀 스위치');
    assert.equal(getPurchasableCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: { CREDIT_LEGACY_CHECKOUT_ENABLED: '1' } }).amount, amount);
  }
  assert.equal(getCreditProduct(2900, { nowMs: DURING_EVENT_MS, env: {} }).totalCredits, 105);
  assert.equal(getCreditProduct(8700, { nowMs: DURING_EVENT_MS, env: {} }).totalCredits, 345);
  for (const amount of AMOUNTS) {
    assert.equal(isPurchasableCreditAmount(amount, {}), true);
    assert.equal(getPurchasableCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} }).amount, amount);
  }
  assert.equal(getPurchasableCreditProduct(5900, { nowMs: DURING_EVENT_MS, env: {} }).paidCredits, 200);
  assert.equal(getPurchasableCreditProduct(1234, { env: {} }), null);
  assert.equal(isPurchasableCreditAmount(1234, {}), false);
});

test('팀·기관 116,000원은 지급량만 계산하고 어떤 스위치로도 온라인 결제가 열리지 않는다', () => {
  const during = getCreditProduct(INQUIRY, { nowMs: DURING_EVENT_MS, env: {} });
  assert.equal(during.label, '팀·기관');
  assert.equal(during.baseCredits, 4000);
  assert.equal(during.packageBonusCredits, 2000);
  assert.equal(during.eventBonusCredits, 200);
  assert.equal(during.totalCredits, 6200);
  assert.equal(during.inquiryOnly, true);
  assert.equal(during.purchasable, false);
  assert.equal(getCreditProduct(INQUIRY, { nowMs: EVENT_END_MS, env: {} }).totalCredits, 6000);
  assert.equal(isPurchasableCreditAmount(INQUIRY, {}), false);
  assert.equal(isPurchasableCreditAmount(INQUIRY, { CREDIT_LEGACY_CHECKOUT_ENABLED: '1' }), false, '문의 전용은 비상 스위치로도 안 열린다');
  assert.equal(getPurchasableCreditProduct(INQUIRY, { env: { CREDIT_LEGACY_CHECKOUT_ENABLED: '1' } }), null);
});

test('스타터 단가 대비 상시 지급량 차이는 가격표 카드 값과 일치한다', () => {
  const starter = getCreditProduct(5900, { nowMs: DURING_EVENT_MS, env: {} });
  const compare = (amount) => starterComparisonCredits(getCreditProduct(amount, { nowMs: DURING_EVENT_MS, env: {} }), starter);
  assert.deepEqual([14500, 29000, 58000, INQUIRY].map(compare), [133, 367, 934, 2068]);
  assert.equal(compare(5900), 0);
  assert.equal(starterComparisonCredits(null, starter), 0);
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

  const starterAfter = getCreditProduct(5900, { nowMs: EVENT_END_MS, env: {} });
  assert.equal(starterAfter.eventBonusCredits, 0);
  assert.equal(starterAfter.totalCredits, 200);
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
  assert.deepEqual(context.firstPurchaseOffers.map((offer) => offer.totalCredits), [200, 650, 1400, 3000]);
});

test('체크아웃 컨텍스트는 구매 가능 4종만 내려보내고 종료·문의 전용 상품은 오퍼에 넣지 않는다', () => {
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
    [5900, 200, 0, 0, 200],
    [14500, 500, 125, 25, 650],
    [29000, 1000, 350, 50, 1400],
    [58000, 2000, 900, 100, 3000]
  ]);
  assert.deepEqual(context.creditOffers.map((offer) => offer.label), ['스타터', '스탠다드', '프로', '맥스']);
  assert.deepEqual(context.firstPurchaseOffers.map((offer) => offer.amount), AMOUNTS);
  assert.ok(context.creditOffers.every((offer) => !RETIRED.includes(offer.amount) && offer.amount !== INQUIRY));
  assert.deepEqual(context.starterOffer, {
    amount: 5900,
    baseCredits: 200,
    bonusCredits: 0,
    packageBonusCredits: 0,
    eventBonusCredits: 0,
    totalCredits: 200
  });
  assert.equal(context.pricingPolicyVersion, 'credit-offer-v4-202609');
  assert.ok(context.creditOffers.every((offer) => offer.offerPolicyVersion === 'credit-offer-v4-202609'));
});

test('20크레딧 가입 지급액을 기준으로 신규·체험 사용자 세그먼트를 나눈다', () => {
  const unused = buildCheckoutContext({ uid: 'u1', credits: FREE_TRIAL_CREDITS, orders: [] }, {}, DURING_EVENT_MS);
  const engaged = buildCheckoutContext({ uid: 'u2', credits: FREE_TRIAL_CREDITS - 1, orders: [] }, {}, DURING_EVENT_MS);
  const unfunded = buildCheckoutContext({ uid: 'u3', credits: FREE_TRIAL_CREDITS + 1, orders: [] }, {}, DURING_EVENT_MS);
  assert.equal(FREE_TRIAL_CREDITS, 20);
  assert.equal(unused.segment, 'trial_unused');
  assert.equal(engaged.segment, 'trial_engaged');
  assert.equal(unfunded.segment, 'new_unfunded');
  assert.equal(unused.starterOffer.totalCredits, 200);
});

test('재구매 저잔액 사용자는 가장 최근의 인식 가능한 상품을 받는다(종료 상품 주문도 계속 인식)', () => {
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

  // 마지막 주문이 종료 상품(2,900)이어도 lastPackage는 그 주문을 돌려준다 — 프런트 catalogPlan 가드가 재구매 안내를 막는다.
  const legacyLast = buildCheckoutContext({
    uid: 'legacy-payer',
    credits: 3,
    orders: [
      { id: 'legacy-starter', amount: 2900, status: 'paid', createdAt: '2026-08-20T00:00:00Z', paidCredits: 100, safeCredits: 105, eventBonusCredits: 5 }
    ]
  }, {}, DURING_EVENT_MS);
  assert.equal(legacyLast.lastPackage.amount, 2900);
  assert.equal(legacyLast.lastPackage.label, '스타터');
  assert.equal(legacyLast.lastPackage.totalCredits, 105);
});

test('전액 환불 및 refunded 주문은 유지된 구매로 세지 않는다', () => {
  assert.equal(isRetainedPaidOrder({ amount: 2900, status: 'refunded' }), false);
  assert.equal(isRetainedPaidOrder({ amount: 2900, refundedAmount: 2900, status: 'partially_refunded' }), false);
  assert.equal(isRetainedPaidOrder({ amount: 2900, refundedAmount: 1000, status: 'partially_refunded' }), true);
});

test('상위 상품일수록 이벤트 후 크레딧 당 가격이 낮아진다', () => {
  const totals = [200, 650, 1400, 3000];
  const unitPrices = AMOUNTS.map((amount, index) => amount / totals[index]);
  for (let i = 1; i < unitPrices.length; i += 1) {
    assert.ok(unitPrices[i] < unitPrices[i - 1], `${AMOUNTS[i]}원 티어는 직전 티어보다 크레딧 당 가격이 낮아야 한다`);
  }
  assert.deepEqual(unitPrices.map((value) => Number(value.toFixed(2))), [29.5, 22.31, 20.71, 19.33]);
  // 기준 단가: 스타터만 29.5원, 그 외 29원
  assert.equal(5900 / 200, 29.5);
  for (const amount of [14500, 29000, 58000, INQUIRY]) {
    assert.equal(amount / CREDIT_PRODUCT_BASES[amount].baseCredits, 29);
  }
});

test('스타터→스탠다드 업그레이드 grant는 서버 주문 스냅샷으로만 계산하고 기본 비활성이다', () => {
  assert.deepEqual(STARTER_UPGRADE, {
    kind: 'starter_to_standard_upgrade',
    sourceAmount: 5900,
    targetAmount: 14500,
    additionalAmount: 8600,
    windowMs: 7 * 24 * 60 * 60 * 1000
  });
  const createdAt = '2026-09-15T00:00:00+09:00';
  const source = {
    id: 'order_starter_eligible',
    uid: 'u-upgrade',
    amount: 5900,
    status: 'paid',
    paidCredits: 200,
    safeCredits: 210,
    eventBonusCredits: 10,
    createdAt
  };
  const nowMs = Date.parse('2026-09-20T00:00:00+09:00');
  const grant = buildStarterUpgradeGrant(source, { nowMs, env: {} });
  // v3에서 이미 210크레딧을 받은 주문은 당시 스냅샷을 빼서 440만 추가한다.
  assert.equal(grant.amount, 8600);
  assert.equal(grant.paidCredits, 300);
  assert.equal(grant.packageBonusCredits, 125);
  assert.equal(grant.eventBonusCredits, 15);
  assert.equal(grant.totalCredits, 440);
  assert.equal(grant.cumulativeCredits, 650);

  // v4에서 200크레딧을 받은 새 스타터는 현재 스탠다드 총량 650까지 450을 추가한다.
  const currentPolicyGrant = buildStarterUpgradeGrant({
    ...source,
    id: 'order_starter_v4',
    safeCredits: 200,
    eventBonusCredits: 0
  }, { nowMs, env: {} });
  assert.equal(currentPolicyGrant.paidCredits, 300);
  assert.equal(currentPolicyGrant.packageBonusCredits, 125);
  assert.equal(currentPolicyGrant.eventBonusCredits, 25);
  assert.equal(currentPolicyGrant.totalCredits, 450);
  assert.equal(currentPolicyGrant.cumulativeCredits, 650);

  const disabled = buildCheckoutContext({ uid: 'u-upgrade', credits: 210, orders: [source] }, {}, nowMs);
  assert.equal(disabled.starterUpgradeEnabled, false);
  assert.equal(disabled.upgradeOffer, null);
  const partiallyEnabled = buildCheckoutContext(
    { uid: 'u-upgrade', credits: 210, orders: [source] },
    { STARTER_STANDARD_UPGRADE_ENABLED: '1' },
    nowMs
  );
  assert.equal(partiallyEnabled.starterUpgradeEnabled, false, '연결 환불 안전 플래그 없이 단독 활성화 금지');

  const enabled = buildCheckoutContext(
    { uid: 'u-upgrade', credits: 210, orders: [source] },
    {
      STARTER_STANDARD_UPGRADE_ENABLED: '1',
      STARTER_STANDARD_UPGRADE_LINKED_REFUND_ENABLED: '1'
    },
    nowMs
  );
  assert.equal(enabled.upgradeOffer.additionalAmount, 8600);
  assert.equal(enabled.upgradeOffer.additionalCredits, 440);
  assert.equal(enabled.upgradeOffer.cumulativeCredits, 650);

  assert.ok(buildStarterUpgradeGrant(source, {
    nowMs: Date.parse('2026-09-22T00:00:00+09:00'), env: {}
  }));
  assert.equal(buildStarterUpgradeGrant(source, {
    nowMs: Date.parse('2026-09-22T00:00:00.001+09:00'), env: {}
  }), null);
  assert.equal(buildStarterUpgradeGrant({ ...source, upgradeOrderId: 'order_used' }, { nowMs, env: {} }), null);

  // 종료된 2,900원 스타터 주문은 업그레이드 소스가 될 수 없다.
  const legacySource = { ...source, id: 'order_legacy_starter', amount: 2900, paidCredits: 100, safeCredits: 105, eventBonusCredits: 5 };
  assert.equal(buildStarterUpgradeGrant(legacySource, { nowMs, env: {} }), null);
});

test('이벤트 중 산 스타터를 이벤트 종료 후 업그레이드해도 당시 목표 총량을 넘지 않는다', () => {
  const source = {
    id: 'order_starter_event_boundary',
    amount: 5900,
    status: 'paid',
    paidCredits: 200,
    safeCredits: 210,
    packageBonusCredits: 0,
    eventBonusCredits: 10,
    createdAt: '2026-09-29T12:00:00+09:00'
  };
  const grant = buildStarterUpgradeGrant(source, {
    nowMs: Date.parse('2026-10-01T12:00:00+09:00'),
    env: {}
  });
  assert.equal(grant.paidCredits, 300);
  assert.equal(grant.packageBonusCredits, 115);
  assert.equal(grant.eventBonusCredits, 0);
  assert.equal(grant.totalCredits, 415);
  assert.equal(grant.cumulativeCredits, 625);
});

test('정확한 주문 lot 소진율이 70% 이상일 때만 스탠다드 추천을 만든다', () => {
  // 종료 상품(8,700) 주문도 소진율 계산과 추천에 계속 쓰인다.
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
  assert.equal(context.recommendation.comparisonCredits, 133);

  const starterOrder = {
    id: 'order_latest_starter', amount: 5900, status: 'paid', paidCredits: 200,
    safeCredits: 210, packageBonusCredits: 0, eventBonusCredits: 10,
    createdAt: '2026-09-20T00:00:00+09:00'
  };
  const starterContext = buildCheckoutContext({
    uid: 'u-usage-2', credits: 60, orders: [starterOrder],
    creditLots: [{ id: starterOrder.id, refundPaidCreditsRemaining: 50, refundEventBonusCreditsRemaining: 10 }]
  }, {}, Date.parse('2026-09-21T00:00:00+09:00'));
  assert.ok(starterContext.usage.consumedRatio > 0.7);
  assert.equal(starterContext.recommendation.amount, 14500);
});

test('추천과 반복 구매 인사이트는 종료 상품을 절대 가리키지 않는다', () => {
  const nowMs = Date.parse('2026-09-21T00:00:00+09:00');
  const starterOrder = (id, amount, createdAt) => ({
    id, amount, status: 'paid', createdAt,
    paidCredits: amount === 5900 ? 200 : 100, safeCredits: amount === 5900 ? 210 : 105
  });

  const repeatNew = buildCheckoutContext({
    uid: 'repeat-new', credits: 30,
    orders: [starterOrder('s1', 5900, '2026-09-10T00:00:00+09:00'), starterOrder('s2', 5900, '2026-09-18T00:00:00+09:00')]
  }, {}, nowMs);
  assert.deepEqual(repeatNew.repeatPurchaseInsight, {
    starterOrderCount: 2, starterPaidAmount: 11800, recommendedAmount: 14500, comparisonCredits: 133
  });

  // 종료된 2,900원 스타터를 반복 구매한 사용자도 같은 인사이트를 받는다(8,700 추천 분기 제거).
  const repeatLegacy = buildCheckoutContext({
    uid: 'repeat-legacy', credits: 30,
    orders: [starterOrder('l1', 2900, '2026-08-10T00:00:00+09:00'), starterOrder('l2', 2900, '2026-08-18T00:00:00+09:00')]
  }, {}, nowMs);
  assert.equal(repeatLegacy.repeatPurchaseInsight.starterOrderCount, 2);
  assert.equal(repeatLegacy.repeatPurchaseInsight.recommendedAmount, 14500);
  assert.equal(repeatLegacy.repeatPurchaseInsight.comparisonCredits, 133);

  const heavy = buildCheckoutContext({
    uid: 'heavy', credits: 30,
    orders: [
      { id: 'h1', amount: 29000, status: 'paid', createdAt: '2026-09-10T00:00:00+09:00', paidCredits: 1000, safeCredits: 1400 },
      { id: 'h2', amount: 29000, status: 'paid', createdAt: '2026-09-18T00:00:00+09:00', paidCredits: 1000, safeCredits: 1400 }
    ]
  }, {}, nowMs);
  assert.deepEqual(heavy.recommendation, { amount: 58000, reasonCode: 'high_30_day_purchase_volume', comparisonCredits: 934 });

  const repeated = buildCheckoutContext({
    uid: 'repeated', credits: 30,
    orders: [
      { id: 'r1', amount: 14500, status: 'paid', createdAt: '2026-09-10T00:00:00+09:00', paidCredits: 500, safeCredits: 650 },
      { id: 'r2', amount: 14500, status: 'paid', createdAt: '2026-09-18T00:00:00+09:00', paidCredits: 500, safeCredits: 650 }
    ]
  }, {}, nowMs);
  assert.deepEqual(repeated.recommendation, { amount: 29000, reasonCode: 'repeated_30_day_recharges', comparisonCredits: 367 });

  for (const context of [repeatNew, repeatLegacy, heavy, repeated]) {
    if (context.recommendation) assert.ok(AMOUNTS.includes(context.recommendation.amount));
    if (context.repeatPurchaseInsight) assert.ok(AMOUNTS.includes(context.repeatPurchaseInsight.recommendedAmount));
  }
});
