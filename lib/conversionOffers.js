const crypto = require('crypto');

// 결제금액의 환불 기준이 되는 유료 크레딧. 2026-09 요금제 개편부터 스타터(5,900원)는 기준 단가 29.5원,
// 그 외 상품은 29원이다.
// - legacy(2,900·8,700원): 새 결제를 받지 않지만 환불·재적용·콜백 스냅샷이 계속 해석해야 하므로 절대 지우지 않는다.
// - inquiryOnly(116,000원 팀·기관): 문의 후 수동 지급 상품. 오퍼 목록과 온라인 결제에는 어떤 경우에도 노출되지 않는다.
// 새 결제 진입 여부는 purchasable 하나로 판정한다(getPurchasableCreditProduct).
const CREDIT_PRODUCT_BASES = Object.freeze({
  2900: Object.freeze({ amount: 2900, baseCredits: 100, label: '스타터', purchasable: false, legacy: true }),
  5900: Object.freeze({ amount: 5900, baseCredits: 200, label: '스타터', purchasable: true }),
  8700: Object.freeze({ amount: 8700, baseCredits: 300, label: '라이트', purchasable: false, legacy: true }),
  14500: Object.freeze({ amount: 14500, baseCredits: 500, label: '스탠다드', purchasable: true }),
  29000: Object.freeze({ amount: 29000, baseCredits: 1000, label: '프로', purchasable: true }),
  58000: Object.freeze({ amount: 58000, baseCredits: 2000, label: '맥스', purchasable: true }),
  116000: Object.freeze({ amount: 116000, baseCredits: 4000, label: '팀·기관', purchasable: false, inquiryOnly: true })
});
// 시작 상품. 체크아웃 컨텍스트의 starterOffer와 반복 구매 인사이트가 이 금액을 기준으로 계산된다.
const ENTRY_PRODUCT_AMOUNT = 5900;
// 라벨이 '스타터'인 모든 금액(현행 5,900 + 종료된 2,900). 반복 구매 인사이트가 레거시 구매자도 포함하도록 쓴다.
const STARTER_AMOUNTS = Object.freeze(
  Object.values(CREDIT_PRODUCT_BASES).filter((base) => base.label === '스타터').map((base) => base.amount)
);

const CREDIT_OFFER_POLICY_VERSION = 'credit-offer-v4-202609';
const FREE_TRIAL_CREDITS = 20;
const PACKAGE_BONUS_RATES = Object.freeze({
  2900: 0,
  5900: 0,
  8700: 10,
  14500: 25,
  29000: 35,
  58000: 45,
  116000: 50
});
const STARTER_UPGRADE = Object.freeze({
  kind: 'starter_to_standard_upgrade',
  sourceAmount: 5900,
  targetAmount: 14500,
  additionalAmount: 8600,
  windowMs: 7 * 24 * 60 * 60 * 1000
});
// 카탈로그 불변식은 요청 때가 아니라 부팅 때 터져야 한다.
if (STARTER_UPGRADE.additionalAmount !== STARTER_UPGRADE.targetAmount - STARTER_UPGRADE.sourceAmount) {
  throw new Error('STARTER_UPGRADE.additionalAmount must equal targetAmount - sourceAmount');
}
if (!CREDIT_PRODUCT_BASES[ENTRY_PRODUCT_AMOUNT] || CREDIT_PRODUCT_BASES[ENTRY_PRODUCT_AMOUNT].purchasable !== true) {
  throw new Error('ENTRY_PRODUCT_AMOUNT must point to a purchasable product');
}

// 5,900원 스타터를 제외한 추가 크레딧 이벤트. 2026-09-30 23:59:59 KST까지 서버에 결제 확인을
// 요청해 지급량이 고정된 주문에 적용한다. 결제사 응답 지연으로 자정이 넘어가도 약속량은 유지한다.
// 지급된 크레딧 자체에는 유효기간이 없으며, 환불 시에는 유료 기준 크레딧과 분리해 회수한다.
const EXTRA_CREDIT_EVENT = Object.freeze({
  id: 'extra-credit-2026-09',
  policyVersion: 'credit-grant-base-v1',
  startsAtMs: Date.parse('2026-08-29T00:00:00+09:00'),
  endsAtMs: Date.parse('2026-10-01T00:00:00+09:00'),
  displayEndsOn: '2026-09-30',
  rate: 5
});
// 2026-09 가격 정책 v4: 현행 5,900원 스타터는 개강 이벤트 추가 지급 대상에서 제외한다.
// 종료된 2,900·8,700원과 문의 전용 116,000원은 과거 주문·수동 지급 해석을 위해 기존 +5% 계산을 보존한다.
const EXTRA_CREDIT_EVENT_EXCLUDED_AMOUNTS = Object.freeze([5900]);

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
  const packageBonusRate = PACKAGE_BONUS_RATES[base.amount] || 0;
  const packageBonusCredits = Math.round(base.baseCredits * packageBonusRate / 100);
  const ongoingCredits = base.baseCredits + packageBonusCredits;
  const eventBonusRate = eventActive && !EXTRA_CREDIT_EVENT_EXCLUDED_AMOUNTS.includes(base.amount)
    ? EXTRA_CREDIT_EVENT.rate
    : 0;
  const eventBonusCredits = Math.round(base.baseCredits * eventBonusRate / 100);
  const bonusCredits = packageBonusCredits + eventBonusCredits;
  return Object.freeze({
    amount: base.amount,
    label: base.label,
    baseCredits: base.baseCredits,
    paidCredits: base.baseCredits,
    offerPolicyVersion: CREDIT_OFFER_POLICY_VERSION,
    packageBonusRate,
    packageBonusCredits,
    ongoingCredits,
    eventActive,
    eventId: eventBonusRate > 0 ? EXTRA_CREDIT_EVENT.id : null,
    eventBonusRate,
    eventBonusCredits,
    bonusCredits,
    credits: base.baseCredits + bonusCredits,
    totalCredits: base.baseCredits + bonusCredits,
    grantPolicyVersion: EXTRA_CREDIT_EVENT.policyVersion,
    eventEndsAtMs: EXTRA_CREDIT_EVENT.endsAtMs,
    purchasable: base.purchasable === true,
    legacy: base.legacy === true,
    inquiryOnly: base.inquiryOnly === true
  });
}

// 새 결제 진입 판정. 종료 상품(legacy)은 비상 복귀 스위치 CREDIT_LEGACY_CHECKOUT_ENABLED=1로만 다시 열 수 있고,
// 문의 전용 상품은 어떤 스위치로도 온라인 결제가 열리지 않는다.
function isPurchasableCreditAmount(amount, env = process.env) {
  const base = CREDIT_PRODUCT_BASES[Number(amount)];
  if (!base) return false;
  if (base.purchasable === true) return true;
  return base.legacy === true && String((env || {}).CREDIT_LEGACY_CHECKOUT_ENABLED || '0') === '1';
}

// /prepare-payment·/confirm-payment의 새 결제 검증 전용. 과거 주문 해석(환불·재적용·콜백)은 getCreditProduct를 그대로 쓴다.
function getPurchasableCreditProduct(amount, options = {}) {
  const env = options.env || process.env;
  if (!isPurchasableCreditAmount(amount, env)) return null;
  return getCreditProduct(amount, options);
}

// 가격표 '스타터 단가 대비' 값: 같은 금액을 스타터 기준 단가로 샀을 때보다 상시 지급량(기준+상시 보너스)이 얼마나 많은지.
function starterComparisonCredits(target, starter) {
  if (!target || !starter || !(Number(starter.amount) > 0)) return 0;
  const atStarterRate = Math.round(Number(target.amount) * Number(starter.baseCredits) / Number(starter.amount));
  return Math.max(0, Number(target.ongoingCredits) - atStarterRate);
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
    if (!product) continue;
    const paidCredits = Math.max(0, Math.floor(Number(order.paidCredits ?? order.baseCredits) || product.paidCredits));
    const totalCredits = Math.max(paidCredits, Math.floor(Number(
      order.totalGrantedCredits ?? order.safeCredits ?? order.credits
    ) || product.totalCredits));
    const eventBonusCredits = Math.max(0, Math.min(
      totalCredits - paidCredits,
      Math.floor(Number(order.eventBonusCredits) || 0)
    ));
    const packageBonusCredits = Math.max(0, Math.floor(Number(
      order.packageBonusCredits
    ) || (totalCredits - paidCredits - eventBonusCredits)));
    return {
      id: order.id || null,
      amount: product.amount,
      label: product.label,
      baseCredits: paidCredits,
      paidCredits,
      packageBonusCredits,
      eventBonusCredits,
      totalCredits,
      createdAtMs: timestampMs(order.createdAt)
    };
  }
  return null;
}

function starterUpgradeEnabled(env = process.env) {
  // 결제 승인과 연결 환불 사가가 모두 검증된 배포에서만 이중 확인으로 연다.
  // 한 플래그를 실수로 켜도 두 결제 중 하나만 취소되는 상태가 노출되지 않는다.
  return String(env.STARTER_STANDARD_UPGRADE_ENABLED || '0') === '1'
    && String(env.STARTER_STANDARD_UPGRADE_LINKED_REFUND_ENABLED || '0') === '1';
}

function orderGrantSnapshot(order, fallbackProduct) {
  const paidCredits = Math.max(0, Math.floor(Number(
    order?.paidCredits ?? order?.baseCredits
  ) || fallbackProduct?.paidCredits || 0));
  const totalCredits = Math.max(paidCredits, Math.floor(Number(
    order?.totalGrantedCredits ?? order?.safeCredits ?? order?.credits
  ) || fallbackProduct?.totalCredits || paidCredits));
  const eventBonusCredits = Math.max(0, Math.min(
    totalCredits - paidCredits,
    Math.floor(Number(order?.eventBonusCredits) || 0)
  ));
  const packageBonusCredits = Math.max(0, Math.min(
    totalCredits - paidCredits - eventBonusCredits,
    Math.floor(Number(order?.packageBonusCredits)
      || (totalCredits - paidCredits - eventBonusCredits))
  ));
  return { paidCredits, packageBonusCredits, eventBonusCredits, totalCredits };
}

function buildStarterUpgradeGrant(sourceOrder, options = {}) {
  if (!sourceOrder || Number(sourceOrder.amount) !== STARTER_UPGRADE.sourceAmount) return null;
  if (String(sourceOrder.status || '') !== 'paid' || retainedAmount(sourceOrder) !== STARTER_UPGRADE.sourceAmount) return null;
  if (sourceOrder.upgradeOrderId || sourceOrder.activeUpgradeOrderId) return null;
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs);
  const sourceCreatedAtMs = timestampMs(sourceOrder.createdAt || sourceOrder.approvedAt);
  if (!sourceCreatedAtMs || nowMs < sourceCreatedAtMs || nowMs - sourceCreatedAtMs > STARTER_UPGRADE.windowMs) return null;

  const sourceProduct = getCreditProduct(STARTER_UPGRADE.sourceAmount, options);
  const targetProduct = getCreditProduct(STARTER_UPGRADE.targetAmount, options);
  const source = orderGrantSnapshot(sourceOrder, sourceProduct);
  const paidCredits = Math.max(0, targetProduct.paidCredits - source.paidCredits);
  // 업그레이드는 현재 시점의 목표 총량에서 이미 받은 총량을 빼서 계산한다.
  // 구성별 차감부터 하면 이벤트 종료 직후 과거 이벤트 보너스가 목표 총량에
  // 중복되어 625가 아닌 630크레딧이 되는 경계 오류가 생긴다.
  const totalCredits = Math.max(0, targetProduct.totalCredits - source.totalCredits);
  const bonusBudget = Math.max(0, totalCredits - paidCredits);
  const packageBonusCredits = Math.min(
    bonusBudget,
    Math.max(0, targetProduct.packageBonusCredits - source.packageBonusCredits)
  );
  const eventBonusCredits = Math.max(0, bonusBudget - packageBonusCredits);
  const bonusCredits = packageBonusCredits + eventBonusCredits;
  // 기준 크레딧 차액은 카탈로그에서 파생한다(5,900→14,500이면 500−200=300). 하드코딩하면 카탈로그 개편 때 조용히 null이 된다.
  const expectedPaidCredits = Math.max(0, targetProduct.paidCredits - sourceProduct.paidCredits);
  if (paidCredits !== expectedPaidCredits || totalCredits <= 0 || paidCredits + bonusCredits !== totalCredits) return null;

  return Object.freeze({
    amount: STARTER_UPGRADE.additionalAmount,
    label: '스탠다드 업그레이드',
    purchaseKind: STARTER_UPGRADE.kind,
    sourceOrderId: sourceOrder.id || null,
    targetAmount: STARTER_UPGRADE.targetAmount,
    paidCredits,
    baseCredits: paidCredits,
    packageBonusRate: targetProduct.packageBonusRate,
    packageBonusCredits,
    eventBonusRate: targetProduct.eventBonusRate,
    eventBonusCredits,
    bonusCredits,
    totalCredits,
    cumulativeCredits: source.totalCredits + totalCredits,
    offerPolicyVersion: targetProduct.offerPolicyVersion,
    grantPolicyVersion: targetProduct.grantPolicyVersion,
    eventId: targetProduct.eventId,
    eventEndsAtMs: targetProduct.eventEndsAtMs,
    expiresAtMs: sourceCreatedAtMs + STARTER_UPGRADE.windowMs
  });
}

function findStarterUpgradeOffer(paidOrders, options = {}) {
  const sorted = [...(paidOrders || [])]
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  for (const order of sorted) {
    const grant = buildStarterUpgradeGrant(order, options);
    if (grant?.sourceOrderId) return grant;
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

function buildCheckoutContext({ uid, credits, orders, creditLots }, env = process.env, nowMs = Date.now()) {
  const balance = Math.max(0, Number(credits) || 0);
  const paidOrders = (orders || []).filter(isRetainedPaidOrder);
  const paidOrderCount = paidOrders.length;
  // 오퍼·starterOffer·firstPurchaseOffers는 구매 가능 상품만 본다. 종료 상품과 문의 전용 상품은 여기서 걸러진다.
  const products = Object.values(CREDIT_PRODUCT_BASES)
    .filter((base) => base.purchasable === true)
    .map((base) => getCreditProduct(base.amount, { nowMs, env }));
  const productByAmount = new Map(products.map((product) => [product.amount, product]));
  const starter = productByAmount.get(ENTRY_PRODUCT_AMOUNT);

  const lastPackage = latestPaidProduct(paidOrders, nowMs, env);
  const upgradeGrant = starterUpgradeEnabled(env)
    ? findStarterUpgradeOffer(paidOrders, { nowMs, env })
    : null;
  const lotsByOrderId = new Map((creditLots || []).map(lot => [String(lot.id || lot.orderId || ''), lot]));
  const lastLot = lastPackage && lastPackage.id ? lotsByOrderId.get(String(lastPackage.id)) : null;
  const lastPackageRemaining = lastLot
    ? Math.max(0, Math.floor(Number(lastLot.refundPaidCreditsRemaining) || 0))
      + Math.max(0, Math.floor(Number(
        lastLot.refundBonusCreditsRemaining ?? lastLot.refundEventBonusCreditsRemaining
      ) || 0))
    : null;
  const consumedRatio = lastPackage && Number.isFinite(lastPackageRemaining)
    ? Math.max(0, Math.min(1, 1 - (lastPackageRemaining / Math.max(1, lastPackage.totalCredits))))
    : null;
  const recentCutoffMs = nowMs - (30 * 24 * 60 * 60 * 1000);
  const recentOrders = paidOrders.filter(order => timestampMs(order.createdAt) >= recentCutoffMs);
  const recentSpend = recentOrders.reduce((sum, order) => sum + retainedAmount(order), 0);
  const recentHighTierCount = recentOrders.filter(order => Number(order.amount) >= 14500).length;
  const starterOrders = paidOrders.filter(order => STARTER_AMOUNTS.includes(Number(order.amount)));
  const starterSpend = starterOrders.reduce((sum, order) => sum + retainedAmount(order), 0);

  // 추천은 구매 가능 상품만 가리킨다. comparisonCredits는 가격표의 '스타터 단가 대비' 값과 같은 식으로 파생한다.
  const compare = (amount) => starterComparisonCredits(productByAmount.get(amount), starter);
  let recommendation = null;
  if (recentSpend >= 58000 || recentHighTierCount >= 3) {
    recommendation = { amount: 58000, reasonCode: 'high_30_day_purchase_volume', comparisonCredits: compare(58000) };
  } else if (recentSpend >= 29000 || recentHighTierCount >= 2 || recentOrders.length >= 5) {
    recommendation = { amount: 29000, reasonCode: 'repeated_30_day_recharges', comparisonCredits: compare(29000) };
  } else if (consumedRatio !== null && consumedRatio >= 0.7) {
    recommendation = { amount: 14500, reasonCode: 'last_package_70_percent_consumed', comparisonCredits: compare(14500) };
  }

  let segment;
  if (paidOrderCount > 0 && consumedRatio !== null && consumedRatio >= 0.7) segment = 'returning_low_balance';
  else if (paidOrderCount > 0 && balance < 20) segment = 'returning_low_balance';
  else if (paidOrderCount > 0) segment = 'returning_funded';
  else if (balance === FREE_TRIAL_CREDITS) segment = 'trial_unused';
  else if (balance < FREE_TRIAL_CREDITS) segment = 'trial_engaged';
  else segment = 'new_unfunded';

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
      offerPolicyVersion: product.offerPolicyVersion,
      packageBonusRate: product.packageBonusRate,
      packageBonusCredits: product.packageBonusCredits,
      ongoingCredits: product.ongoingCredits,
      eventBonusRate: product.eventBonusRate,
      eventBonusCredits: product.eventBonusCredits,
      bonusCredits: product.bonusCredits,
      totalCredits: product.totalCredits
    })),
    // 구형 프런트가 첫 구매 행을 노출하지 않도록 명시적으로 비활성화한다.
    eligibleForFirstPurchaseOffer: false,
    experiment: { key: 'first_purchase_bonus_retired_20260829', variant: 'retired' },
    starterOffer: {
      amount: starter.amount,
      baseCredits: starter.baseCredits,
      bonusCredits: starter.bonusCredits,
      packageBonusCredits: starter.packageBonusCredits,
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
    pricingPolicyVersion: CREDIT_OFFER_POLICY_VERSION,
    starterUpgradeEnabled: starterUpgradeEnabled(env),
    usage: lastPackage ? {
      lastPackageTotal: lastPackage.totalCredits,
      lastPackageRemaining,
      consumedRatio
    } : null,
    recommendation,
    // 스타터를 반복 구매한 사용자에게는 항상 스탠다드를 권한다(종료 상품 8,700을 추천하던 분기는 제거).
    repeatPurchaseInsight: starterOrders.length >= 2 ? {
      starterOrderCount: starterOrders.length,
      starterPaidAmount: starterSpend,
      recommendedAmount: 14500,
      comparisonCredits: compare(14500)
    } : null,
    upgradeOffer: upgradeGrant ? {
      kind: upgradeGrant.purchaseKind,
      sourceOrderId: upgradeGrant.sourceOrderId,
      targetAmount: upgradeGrant.targetAmount,
      additionalAmount: upgradeGrant.amount,
      additionalCredits: upgradeGrant.totalCredits,
      cumulativeCredits: upgradeGrant.cumulativeCredits,
      expiresAtMs: upgradeGrant.expiresAtMs
    } : null,
    lastPackage
  };
}

module.exports = {
  CREDIT_PRODUCT_BASES,
  CREDIT_PRODUCTS,
  CREDIT_OFFER_POLICY_VERSION,
  ENTRY_PRODUCT_AMOUNT,
  EXTRA_CREDIT_EVENT,
  FREE_TRIAL_CREDITS,
  PACKAGE_BONUS_RATES,
  STARTER_UPGRADE,
  buildCheckoutContext,
  extraCreditEventActive,
  buildStarterUpgradeGrant,
  firstPurchaseBonusCredits,
  firstPurchaseBonusRate,
  firstPurchaseExperiment,
  getCreditProduct,
  getPurchasableCreditProduct,
  isPurchasableCreditAmount,
  isRetainedPaidOrder,
  resolveFirstPurchaseGrant,
  retainedAmount,
  starterComparisonCredits,
  starterUpgradeEnabled
};
