const crypto = require('crypto');

// 크레딧 사다리(2026-08-29 사장님 승인 — 6~8월 주문 2,517건 실측 기반 재설계).
// 기본 제공은 전 상품 29원/크레딧으로 동일하고, 차별화는 전부 "보너스 지급" 비율이다.
//   스타터 +10% / 라이트 +33% / 스탠다드 +40% / 플러스 +50% / 맥스 +65%
// 개편 이유: 종전 사다리는 같은 금액을 스타터로 나눠 사는 것 대비 이득이 라이트 +6%,
// 스탠다드 +9%에 그쳐 상위 상품을 살 이유가 없었다. 실제로 라이트 매출 비중이
// 6월 38.2% → 8월 20.7%로 붕괴 중이었다(라이트는 8/26까지 330 = 스타터 3회와 동일).
// 새 사다리의 같은 금액 대비 이득: 라이트 +21% / 스탠다드 +27% / 플러스 +36% / 맥스 +50%.
const CREDIT_PRODUCTS = Object.freeze({
  2900: Object.freeze({ amount: 2900, credits: 110, label: '스타터' }),
  8700: Object.freeze({ amount: 8700, credits: 400, label: '라이트' }),
  14500: Object.freeze({ amount: 14500, credits: 700, label: '스탠다드' }),
  29000: Object.freeze({ amount: 29000, credits: 1500, label: '플러스' }),
  58000: Object.freeze({ amount: 58000, credits: 3300, label: '맥스' })
});

// 첫 구매 보너스율(%) — 상위 상품일수록 높다(2026-08-29 사장님 승인).
// 종전 정액 +10은 소액 구매에 유리해 사다리를 역전시켰다: 스타터 120(24.17원)과
// 라이트 360(24.17원)의 단가가 소수점까지 같아져 첫 구매에서 라이트를 고를 이유가 0이었다.
// 비율제로 바꾸면 상위 상품일수록 첫 구매 단가가 낮아져 상향 유인이 생긴다.
const FIRST_PURCHASE_BONUS_RATES = Object.freeze({
  2900: 5,
  8700: 8,
  14500: 10,
  29000: 12,
  58000: 15
});

const RETAINED_PAID_STATUSES = new Set([
  'paid',
  'refund_requested',
  'refund_rejected',
  'partially_refunded'
]);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function firstPurchaseBonusRate(amount, env = process.env) {
  const configured = FIRST_PURCHASE_BONUS_RATES[Number(amount)] || 0;
  // 상품별 환경변수(FIRST_PURCHASE_BONUS_RATE_8700 등)로 개별 조정 가능. 상한 30%.
  return boundedInteger(env[`FIRST_PURCHASE_BONUS_RATE_${Number(amount) || 0}`], configured, 0, 30);
}

// 노출 비율 기본값 100(2026-08-29): 가격 화면이 첫 구매 보너스를 전 상품에 명시하므로,
// 일부에게만 지급하면 화면 표기가 거짓이 된다. A/B로 되돌리려면 이 환경변수를 50으로 낮춘다.
function firstPurchaseExperiment(uid, amount, env = process.env) {
  const percent = boundedInteger(env.FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT, 100, 0, 100);
  const rate = firstPurchaseBonusRate(amount, env);
  const digest = crypto.createHash('sha256').update(String(uid || 'anonymous')).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  const enabled = rate > 0 && bucket < percent;
  return {
    key: 'first_purchase_bonus_v2',
    bucket,
    variant: enabled ? `rate_${rate}` : 'control',
    bonusRate: enabled ? rate : 0
  };
}

// 지급 크레딧 = 상품 총 크레딧(보너스 포함) × 비율, 반올림.
// 스타터 6 · 라이트 32 · 스탠다드 70 · 플러스 180 · 맥스 495
function firstPurchaseBonusCredits(amount, rate) {
  const product = CREDIT_PRODUCTS[Number(amount)];
  if (!product || !(rate > 0)) return 0;
  return Math.round(product.credits * rate / 100);
}

function latestPaidProduct(paidOrders) {
  const sorted = [...paidOrders].sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  for (const order of sorted) {
    const amount = Number(order.amount) || 0;
    const product = CREDIT_PRODUCTS[amount];
    if (product) return product;
  }
  return null;
}

function resolveFirstPurchaseGrant({ uid, amount, hasPriorPaidOrder, conversion }, env = process.env) {
  const experiment = firstPurchaseExperiment(uid, amount, env);
  const isFirstPurchase = !hasPriorPaidOrder && !(conversion && conversion.firstPurchaseOrderId);
  return {
    isFirstPurchase,
    experimentKey: isFirstPurchase ? experiment.key : null,
    experimentVariant: isFirstPurchase ? experiment.variant : 'ineligible',
    bonusRate: isFirstPurchase ? experiment.bonusRate : 0,
    bonusCredits: isFirstPurchase ? firstPurchaseBonusCredits(amount, experiment.bonusRate) : 0
  };
}

function buildCheckoutContext({ uid, credits, orders, conversion }, env = process.env) {
  const balance = Math.max(0, Number(credits) || 0);
  const paidOrders = (orders || []).filter(isRetainedPaidOrder);
  const paidOrderCount = paidOrders.length;
  const grant = resolveFirstPurchaseGrant({ uid, amount: 2900, hasPriorPaidOrder: paidOrderCount > 0, conversion }, env);
  const eligibleForFirstPurchaseOffer = grant.isFirstPurchase;
  const starterBonusCredits = grant.bonusCredits;
  // 첫 구매 보너스는 전 상품에 적용되므로 상품별 지급량을 함께 내려보낸다(2026-08-29).
  // 종전에는 스타터 것만 내려보내 가격 화면이 스타터 카드에서만 보너스를 안내했고,
  // 다른 상품 첫 구매자는 보너스를 받고도 그 사실을 알 수 없었다.
  const firstPurchaseOffers = Object.values(CREDIT_PRODUCTS).map((product) => {
    const rate = eligibleForFirstPurchaseOffer
      ? firstPurchaseExperiment(uid, product.amount, env).bonusRate
      : 0;
    const bonusCredits = firstPurchaseBonusCredits(product.amount, rate);
    return {
      amount: product.amount,
      label: product.label,
      credits: product.credits,
      bonusRate: rate,
      bonusCredits,
      totalCredits: product.credits + bonusCredits
    };
  });

  let segment;
  if (paidOrderCount > 0 && balance < 20) segment = 'returning_low_balance';
  else if (paidOrderCount > 0) segment = 'returning_funded';
  else if (balance === 10) segment = 'trial_unused';
  else if (balance < 10) segment = 'trial_engaged';
  else segment = 'new_unfunded';

  const starter = CREDIT_PRODUCTS[2900];
  return {
    segment,
    balance,
    paidOrderCount,
    eligibleForFirstPurchaseOffer,
    experiment: {
      key: 'first_purchase_bonus_v2',
      variant: grant.experimentVariant
    },
    starterOffer: {
      amount: starter.amount,
      baseCredits: starter.credits,
      bonusCredits: starterBonusCredits,
      totalCredits: starter.credits + starterBonusCredits
    },
    firstPurchaseOffers,
    lastPackage: latestPaidProduct(paidOrders)
  };
}

module.exports = {
  CREDIT_PRODUCTS,
  FIRST_PURCHASE_BONUS_RATES,
  buildCheckoutContext,
  firstPurchaseBonusCredits,
  firstPurchaseBonusRate,
  firstPurchaseExperiment,
  isRetainedPaidOrder,
  resolveFirstPurchaseGrant,
  retainedAmount
};
