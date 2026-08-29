const crypto = require('crypto');

// 결제금액의 환불 기준이 되는 유료 크레딧. 모든 상품은 기준 단가 29원이다.
const CREDIT_PRODUCT_BASES = Object.freeze({
  2900: Object.freeze({ amount: 2900, baseCredits: 100, label: '스타터' }),
  8700: Object.freeze({ amount: 8700, baseCredits: 300, label: '라이트' }),
  14500: Object.freeze({ amount: 14500, baseCredits: 500, label: '스탠다드' }),
  29000: Object.freeze({ amount: 29000, baseCredits: 1000, label: '플러스' }),
  58000: Object.freeze({ amount: 58000, baseCredits: 2000, label: '맥스' })
});

// 전 사용자 대상 추가 크레딧 이벤트. 2026-09-30 23:59:59 KST까지 서버에 결제 확인을
// 요청해 지급량이 고정된 주문에 적용한다. 결제사 응답 지연으로 자정이 넘어가도 약속량은 유지한다.
// 지급된 크레딧 자체에는 유효기간이 없으며, 환불 시에는 유료 기준 크레딧과 분리해 회수한다.
const EXTRA_CREDIT_EVENT = Object.freeze({
  id: 'extra-credit-2026-09',
  policyVersion: 'credit-grant-base-v1',
  startsAtMs: Date.parse('2026-08-29T00:00:00+09:00'),
  endsAtMs: Date.parse('2026-10-01T00:00:00+09:00'),
  displayEndsOn: '2026-09-30',
  rates: Object.freeze({
    2900: 5,
    8700: 10,
    14500: 15,
    29000: 20,
    58000: 25
  })
});

const RETAINED_PAID_STATUSES = new Set([
  'paid',
  'refund_requested',
  'refund_rejected',
  'partially_refunded'
]);

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function extraCreditEventActive(nowMs = Date.now(), env = process.env) {
  if (String(env.EXTRA_CREDIT_EVENT_ENABLED || '1') === '0') return false;
  const now = Number(nowMs);
  return Number.isFinite(now)
    && now >= EXTRA_CREDIT_EVENT.startsAtMs
    && now < EXTRA_CREDIT_EVENT.endsAtMs;
}

function getCreditProduct(amount, options = {}) {
  const base = CREDIT_PRODUCT_BASES[Number(amount)];
  if (!base) return null;
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs);
  const env = options.env || process.env;
  const eventActive = extraCreditEventActive(nowMs, env);
  const eventBonusRate = eventActive ? EXTRA_CREDIT_EVENT.rates[base.amount] : 0;
  const eventBonusCredits = Math.round(base.baseCredits * eventBonusRate / 100);
  return Object.freeze({
    amount: base.amount,
    label: base.label,
    baseCredits: base.baseCredits,
    paidCredits: base.baseCredits,
    eventActive,
    eventId: eventActive ? EXTRA_CREDIT_EVENT.id : null,
    eventBonusRate,
    eventBonusCredits,
    credits: base.baseCredits + eventBonusCredits,
    totalCredits: base.baseCredits + eventBonusCredits,
    grantPolicyVersion: EXTRA_CREDIT_EVENT.policyVersion,
    eventEndsAtMs: EXTRA_CREDIT_EVENT.endsAtMs
  });
}

// 기존 소비 코드와 분석 스크립트의 정적 카탈로그 호환용이다. 실제 결제 지급량은 반드시
// getCreditProduct()를 호출해 결제 확인 요청 시각의 이벤트 활성 여부를 다시 확인한다.
const CREDIT_PRODUCTS = Object.freeze(Object.fromEntries(
  Object.keys(CREDIT_PRODUCT_BASES).map((amount) => [
    amount,
    getCreditProduct(Number(amount), { nowMs: EXTRA_CREDIT_EVENT.startsAtMs })
  ])
));

function retainedAmount(order) {
  const amount = Math.max(0, Number(order && order.amount) || 0);
  const refunded = Math.max(
    0,
    Number(order && order.refundedAmount) || Number(order && order.refundAmount) || 0
  );
  return Math.max(0, amount - refunded);
}

function isRetainedPaidOrder(order) {
  return !!order
    && RETAINED_PAID_STATUSES.has(String(order.status || '').toLowerCase())
    && retainedAmount(order) > 0;
}

function latestPaidProduct(paidOrders, nowMs, env) {
  const sorted = [...paidOrders].sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  for (const order of sorted) {
    const product = getCreditProduct(Number(order.amount) || 0, { nowMs, env });
    if (product) return product;
  }
  return null;
}

// 2026-08-29부터 첫 구매 보너스는 전 사용자 기간 이벤트와 중복하지 않는다.
// 구형 클라이언트 호환을 위해 필드와 함수는 한 릴리스 동안 0값으로 유지한다.
function firstPurchaseExperiment(uid) {
  const digest = crypto.createHash('sha256').update(String(uid || 'anonymous')).digest();
  return {
    key: 'first_purchase_bonus_retired_20260829',
    bucket: digest.readUInt32BE(0) % 100,
    variant: 'retired',
    bonusRate: 0
  };
}

function firstPurchaseBonusRate() {
  return 0;
}

function firstPurchaseBonusCredits() {
  return 0;
}

function resolveFirstPurchaseGrant() {
  return {
    isFirstPurchase: false,
    experimentKey: 'first_purchase_bonus_retired_20260829',
    experimentVariant: 'retired',
    bonusRate: 0,
    bonusCredits: 0
  };
}

function buildCheckoutContext({ uid, credits, orders }, env = process.env, nowMs = Date.now()) {
  const balance = Math.max(0, Number(credits) || 0);
  const paidOrders = (orders || []).filter(isRetainedPaidOrder);
  const paidOrderCount = paidOrders.length;
  const products = Object.values(CREDIT_PRODUCT_BASES).map((base) => (
    getCreditProduct(base.amount, { nowMs, env })
  ));

  let segment;
  if (paidOrderCount > 0 && balance < 20) segment = 'returning_low_balance';
  else if (paidOrderCount > 0) segment = 'returning_funded';
  else if (balance === 10) segment = 'trial_unused';
  else if (balance < 10) segment = 'trial_engaged';
  else segment = 'new_unfunded';

  const starter = products.find((product) => product.amount === 2900);
  return {
    segment,
    balance,
    paidOrderCount,
    creditEvent: {
      id: EXTRA_CREDIT_EVENT.id,
      active: products.some((product) => product.eventActive),
      displayEndsOn: EXTRA_CREDIT_EVENT.displayEndsOn,
      endsAtMs: EXTRA_CREDIT_EVENT.endsAtMs
    },
    creditOffers: products.map((product) => ({
      amount: product.amount,
      label: product.label,
      baseCredits: product.baseCredits,
      eventBonusRate: product.eventBonusRate,
      eventBonusCredits: product.eventBonusCredits,
      totalCredits: product.totalCredits
    })),
    // 구형 프런트가 첫 구매 행을 노출하지 않도록 명시적으로 비활성화한다.
    eligibleForFirstPurchaseOffer: false,
    experiment: { key: 'first_purchase_bonus_retired_20260829', variant: 'retired' },
    starterOffer: {
      amount: starter.amount,
      baseCredits: starter.baseCredits,
      bonusCredits: starter.eventBonusCredits,
      eventBonusCredits: starter.eventBonusCredits,
      totalCredits: starter.totalCredits
    },
    firstPurchaseOffers: products.map((product) => ({
      amount: product.amount,
      label: product.label,
      credits: product.totalCredits,
      bonusRate: 0,
      bonusCredits: 0,
      totalCredits: product.totalCredits
    })),
    lastPackage: latestPaidProduct(paidOrders, nowMs, env)
  };
}

module.exports = {
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
  resolveFirstPurchaseGrant,
  retainedAmount
};
