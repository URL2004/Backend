'use strict';

const TERMS_POLICY_VERSION = '2026-08-30-terms-v1';
const REFUND_POLICY_VERSION = '2026-08-30-base-credit-v2';
const SUBSCRIPTION_REFUND_POLICY_VERSION = '2026-08-30-subscription-usage-v2';
const REFUND_WINDOW_DAYS = 7;
const REFUND_WINDOW_MS = REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REFUND_WINDOW_BASIS = 'terms_snapshot_recorded_or_later_service_available';
const REFUND_CALCULATION_BASIS = 'remaining_paid_credit_ratio_floor_v1';
const REFUND_BONUS_TREATMENT = 'recover_remaining_bonus_credit_v1';
const SUBSCRIPTION_REFUND_CALCULATION_BASIS = 'remaining_cycle_uses_ratio_floor_v1';
const SUBSCRIPTION_REFUND_BONUS_TREATMENT = 'not_applicable_subscription_v1';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function refundWindowLegalDeadlineMs(startedAtMs, days = REFUND_WINDOW_DAYS) {
  const start = Math.max(0, Math.floor(Number(startedAtMs) || 0));
  if (!start) return 0;
  const safeDays = Math.max(1, Math.floor(Number(days) || REFUND_WINDOW_DAYS));
  // 민법상 초일을 산입하지 않는 일 단위 기간을 소비자에게 불리하지 않게 계산한다.
  // KST 시작일의 다음 날을 1일째로 보고, 7일째 23:59:59.999까지 열어 둔다.
  const kst = new Date(start + KST_OFFSET_MS);
  const deadlineDate = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate() + safeDays
  );
  const deadlineDay = new Date(deadlineDate).getUTCDay();
  // 민법 제161조에 따라 기간 말일이 토요일 또는 일요일이면 다음
  // 월요일 말일까지 연장한다. 법정 공휴일 전체 캘린더는 런타임에
  // 추정하지 않고, 기간 경과 신청도 별도 적격성 검토로 접수한다.
  const weekendExtensionDays = deadlineDay === 6 ? 2 : (deadlineDay === 0 ? 1 : 0);
  return Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate() + safeDays + weekendExtensionDays,
    23,
    59,
    59,
    999
  ) - KST_OFFSET_MS;
}

function buildRefundPolicyPurchaseSnapshot(
  nowMs = Date.now(),
  refundPolicyVersion = REFUND_POLICY_VERSION,
  {
    calculationBasis = REFUND_CALCULATION_BASIS,
    bonusTreatment = REFUND_BONUS_TREATMENT
  } = {}
) {
  const startedAtMs = Math.max(0, Math.floor(Number(nowMs) || Date.now()));
  const startedAt = new Date(startedAtMs);
  return {
    termsVersionAtPurchase: TERMS_POLICY_VERSION,
    refundPolicyVersionAtPurchase: refundPolicyVersion,
    refundCalculationBasisAtPurchase: calculationBasis,
    refundBonusTreatmentAtPurchase: bonusTreatment,
    refundWindowBasis: REFUND_WINDOW_BASIS,
    refundWindowDaysAtPurchase: REFUND_WINDOW_DAYS,
    // 실제 전자문서 교부 성공 이벤트가 아닌 서버 주문 적용 시각을 "교부"로
    // 과장 기록하지 않는다. 당시 정책 스냅샷 기록 시각과 서비스 개시 시각만 보존한다.
    termsSnapshotRecordedAt: startedAt,
    serviceAvailableAt: startedAt,
    refundWindowStartsAt: startedAt,
    refundWindowEndsAt: new Date(refundWindowLegalDeadlineMs(startedAtMs, REFUND_WINDOW_DAYS))
  };
}

module.exports = {
  TERMS_POLICY_VERSION,
  REFUND_POLICY_VERSION,
  SUBSCRIPTION_REFUND_POLICY_VERSION,
  REFUND_WINDOW_DAYS,
  REFUND_WINDOW_MS,
  REFUND_WINDOW_BASIS,
  REFUND_CALCULATION_BASIS,
  REFUND_BONUS_TREATMENT,
  SUBSCRIPTION_REFUND_CALCULATION_BASIS,
  SUBSCRIPTION_REFUND_BONUS_TREATMENT,
  refundWindowLegalDeadlineMs,
  buildRefundPolicyPurchaseSnapshot
};
