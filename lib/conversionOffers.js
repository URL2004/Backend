const crypto = require('crypto');

const CREDIT_PRODUCTS = Object.freeze({
  2900: Object.freeze({ amount: 2900, credits: 110, label: '스타터' }),
  // 라이트 330→350(2026-08-26 사장님 승인): 스타터 3회(=330)와 동일해 죽어 있던 티어를 살리고 단가 사다리를 단조로 정리
  8700: Object.freeze({ amount: 8700, credits: 350, label: '라이트' }),
  14500: Object.freeze({ amount: 14500, credits: 600, label: '스탠다드' }),
  29000: Object.freeze({ amount: 29000, credits: 1300, label: '플러스' }),
  58000: Object.freeze({ amount: 58000, credits: 2700, label: '맥스' })
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

function firstPurchaseExperiment(uid, env = process.env) {
  const percent = boundedInteger(env.FIRST_PURCHASE_BONUS_EXPERIMENT_PERCENT, 50, 0, 100);
  const configuredBonus = boundedInteger(env.FIRST_PURCHASE_BONUS_CREDITS, 10, 0, 20);
  const digest = crypto.createHash('sha256').update(String(uid || 'anonymous')).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  const enabled = configuredBonus > 0 && bucket < percent;
  return {
    key: 'first_purchase_bonus_v1',
    bucket,
    variant: enabled ? `bonus_${configuredBonus}` : 'control',
    bonusCredits: enabled ? configuredBonus : 0
  };
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

function resolveFirstPurchaseGrant({ uid, hasPriorPaidOrder, conversion }, env = process.env) {
  const experiment = firstPurchaseExperiment(uid, env);
  const isFirstPurchase = !hasPriorPaidOrder && !(conversion && conversion.firstPurchaseOrderId);
  return {
    isFirstPurchase,
    experimentKey: isFirstPurchase ? experiment.key : null,
    experimentVariant: isFirstPurchase ? experiment.variant : 'ineligible',
    bonusCredits: isFirstPurchase ? experiment.bonusCredits : 0
  };
}

function buildCheckoutContext({ uid, credits, orders, conversion }, env = process.env) {
  const balance = Math.max(0, Number(credits) || 0);
  const paidOrders = (orders || []).filter(isRetainedPaidOrder);
  const paidOrderCount = paidOrders.length;
  const grant = resolveFirstPurchaseGrant({ uid, hasPriorPaidOrder: paidOrderCount > 0, conversion }, env);
  const eligibleForFirstPurchaseOffer = grant.isFirstPurchase;
  const starterBonusCredits = grant.bonusCredits;

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
      key: 'first_purchase_bonus_v1',
      variant: grant.experimentVariant
    },
    starterOffer: {
      amount: starter.amount,
      baseCredits: starter.credits,
      bonusCredits: starterBonusCredits,
      totalCredits: starter.credits + starterBonusCredits
    },
    lastPackage: latestPaidProduct(paidOrders)
  };
}

module.exports = {
  CREDIT_PRODUCTS,
  buildCheckoutContext,
  firstPurchaseExperiment,
  isRetainedPaidOrder,
  resolveFirstPurchaseGrant,
  retainedAmount
};
