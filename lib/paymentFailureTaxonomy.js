// lib/paymentFailureTaxonomy.js — 결제 실패 분류의 단일 진실 원천.
//
// 왜 이 파일이 필요한가(2026-09-04 알림 증폭 사고):
//   한 사용자가 계좌 잔액부족으로 3번 거절당했을 뿐인데 SEV2 알림 9건 + SEV1 급증 1건이 나갔다.
//   결제가 3번 실패한 게 아니라 "같은 사람이 돈이 없어서 3번 되돌아간 것"인데, 코드가 실패를
//   성공/실패 한 축으로만 봤기 때문이다. 결제 실패는 원인에 따라 대응이 완전히 다르다.
//
//     · customer_declined  — 카드사·계좌 사유(잔액부족·한도초과·사용자 취소·세션 만료).
//                            돈은 나가지 않았고 크레딧도 지급되지 않는다. 우리가 할 일은 없다(SEV3).
//     · provider_ambiguous — 응답 유실·5xx·ALREADY_PROCESSED. 돈이 나갔는데 크레딧이 없을 수 있다(SEV1).
//     · operator_fault     — 시크릿 키·가맹점 설정·요청 형식 오류. 전 사용자 결제 불능으로 번진다(SEV1).
//     · provider_pending   — READY/IN_PROGRESS. 아직 안 끝났다. 재시도·정산으로 복구된다(SEV2).
//
// 판정 철칙: 애매하면 반드시 "우리 잘못" 쪽으로 기운다.
//   모르는 코드를 정상 이탈(SEV3)로 내리면 진짜 장애가 조용히 묻힌다. 거절은 화이트리스트로만 인정한다.

const OUTCOME_CUSTOMER_DECLINED = 'customer_declined';
const OUTCOME_PROVIDER_AMBIGUOUS = 'provider_ambiguous';
const OUTCOME_OPERATOR_FAULT = 'operator_fault';
const OUTCOME_PROVIDER_PENDING = 'provider_pending';

// 조회 결과가 이 상태면 재시도해도 절대 DONE이 되지 않는다 → 정산 후보에서 제외한다.
// 2026-09-04 이전에는 ABORTED 주문이 reconciliationCandidate=true로 남아 매시간 정산 워커가
// 다시 집어 "불일치=수동검토" 알림을 만들어 냈다.
const TERMINAL_ABANDONED_STATUSES = new Set(['ABORTED', 'EXPIRED']);
// 취소는 종료 상태이지만 정상 이탈이 아니다(돈이 오간 뒤일 수 있다). 지급도 재시도도 하지 않되 조용히 두지 않는다.
const TERMINAL_CANCELED_STATUSES = new Set(['CANCELED', 'PARTIAL_CANCELED']);
// 아직 진행 중 — 기존 provider_not_done 경로를 그대로 유지한다.
const PENDING_STATUSES = new Set(['READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT']);

// 우리 쪽 설정·구현 문제. 문자열이 REJECT/INVALID을 포함하더라도 절대 정상 이탈로 내리지 않는다.
// (예: INVALID_API_KEY를 거절로 분류하면 전 사용자 결제 불능이 SEV3으로 묻힌다.)
const OPERATOR_FAULT_CODES = new Set([
  'UNAUTHORIZED_KEY',
  'INVALID_API_KEY',
  'INCORRECT_BASIC_AUTH_FORMAT',
  'INVALID_AUTHORIZE_AUTH',
  'FORBIDDEN_REQUEST',
  'INVALID_REQUEST',
  'NOT_REGISTERED_BUSINESS',
  'INVALID_UNREGISTERED_SUBMALL',
  'NOT_SUPPORTED_METHOD',
  'BELOW_MINIMUM_AMOUNT',
  'INVALID_REFUND_ACCOUNT_INFO',
  'NOT_FOUND_TERMINAL_ID',
  'INVALID_STOPPED_PAYMENT'
]);

// 돈이 이미 움직였을 수 있는 코드 — 조용히 두면 "결제됐는데 크레딧 없음"이 된다.
const AMBIGUOUS_CODES = new Set([
  'ALREADY_PROCESSED_PAYMENT',
  'FAILED_INTERNAL_SYSTEM_PROCESSING',
  'PROVIDER_ERROR',
  'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING',
  'UNKNOWN_PAYMENT_ERROR'
]);

// 고객 사유 거절 화이트리스트. 값은 대응 판단에 쓰는 카테고리.
const DECLINE_CATEGORY_BY_CODE = new Map([
  ['REJECT_ACCOUNT_PAYMENT', 'insufficient_funds'],
  ['NOT_ENOUGH_BALANCE', 'insufficient_funds'],
  ['REJECT_CARD_PAYMENT', 'card_rejected'],
  ['REJECT_CARD_COMPANY', 'card_rejected'],
  ['INVALID_REJECT_CARD', 'card_rejected'],
  ['CARD_PROCESSING_ERROR', 'card_rejected'],
  ['INVALID_CARD_NUMBER', 'card_rejected'],
  ['INVALID_CARD_EXPIRATION', 'card_expired'],
  ['INVALID_STOPPED_CARD', 'card_unusable'],
  ['NOT_AVAILABLE_PAYMENT', 'card_unusable'],
  ['NOT_AVAILABLE_BANK', 'bank_unavailable'],
  ['INVALID_PASSWORD', 'auth_failed'],
  ['EXCEED_MAX_AUTH_COUNT', 'auth_failed'],
  ['EXCEED_MAX_DAILY_PAYMENT_COUNT', 'limit_exceeded'],
  ['EXCEED_MAX_ONE_DAY_AMOUNT', 'limit_exceeded'],
  ['EXCEED_MAX_ONE_TIME_AMOUNT', 'limit_exceeded'],
  ['EXCEED_MAX_AMOUNT', 'limit_exceeded'],
  ['EXCEED_MAX_PAYMENT_AMOUNT', 'limit_exceeded'],
  ['EXCEED_MAX_CARD_INSTALLMENT_PLAN', 'installment_unsupported'],
  ['INVALID_CARD_INSTALLMENT_PLAN', 'installment_unsupported'],
  ['NOT_SUPPORTED_INSTALLMENT_PLAN_CARD_OR_MERCHANT', 'installment_unsupported'],
  ['PAY_PROCESS_CANCELED', 'user_canceled'],
  ['USER_CANCEL', 'user_canceled'],
  ['NOT_FOUND_PAYMENT_SESSION', 'session_expired'],
  ['EXPIRED_PAYMENT_SESSION', 'session_expired']
]);

// 화이트리스트에 없는 새 코드를 위한 보조 판정. OPERATOR_FAULT_CODES가 항상 우선한다.
//
// ABORTED를 이 정규식에 넣지 않는 이유: PAY_PROCESS_ABORTED는 "승인 도중 중단"이라는 뜻이고
// 원인이 고객·결제사·우리 중 무엇인지 코드만으로는 알 수 없다. 종전 판단(우리 쪽 장애)을 유지한다.
// 우리가 직접 내려보낸 PAYMENT_ABORTED만 아래 declineCategoryForCode에서 예외로 인정한다 —
// 그 코드는 주문 상태가 ABORTED로 확정됐을 때만 나가기 때문이다.
const DECLINE_CODE_RE = /(^|_)(REJECT|INSUFFICIENT|EXCEED|LIMIT|STOLEN|LOST|EXPIRED|SUSPEND|CANCELED|CANCEL|PASSWORD|INVALID_CARD|NOT_SUPPORTED|PRODUCT_RETIRED)(_|$)/;

const CATEGORY_LABEL = {
  insufficient_funds: '잔액부족',
  card_rejected: '카드사 거절',
  card_expired: '카드 유효기간 오류',
  card_unusable: '사용할 수 없는 카드',
  bank_unavailable: '은행 점검·이용 불가',
  auth_failed: '인증 실패',
  limit_exceeded: '한도 초과',
  installment_unsupported: '할부 불가',
  user_canceled: '사용자 취소',
  checkout_aborted: '결제창 중단',
  session_expired: '결제 세션 만료',
  provider_declined: '결제사 거절',
  network_lost: '결제사 응답 유실',
  provider_unavailable: '결제사 장애',
  already_processed: '이미 처리된 결제',
  operator_config: '가맹점 설정 오류',
  provider_pending: '결제 미완료',
  provider_canceled: '취소된 결제',
  unknown: '원인 미상'
};

// 사용자에게 그대로 보여줄 기본 문구. 결제사 메시지가 있으면 그쪽을 우선한다.
const CATEGORY_USER_MESSAGE = {
  insufficient_funds: '잔액이 부족해 결제가 취소됐어요. 다른 결제수단으로 다시 시도해 주세요.',
  card_rejected: '카드사에서 결제를 거절했어요. 카드사에 문의하거나 다른 카드로 시도해 주세요.',
  card_expired: '카드 유효기간 정보가 맞지 않아요. 카드 정보를 확인해 주세요.',
  card_unusable: '사용할 수 없는 카드예요. 다른 결제수단으로 시도해 주세요.',
  bank_unavailable: '은행 점검 시간이라 결제가 어려워요. 잠시 후 다시 시도해 주세요.',
  auth_failed: '결제 인증에 실패했어요. 다시 시도해 주세요.',
  limit_exceeded: '결제 한도를 넘어 결제가 취소됐어요. 다른 결제수단으로 시도해 주세요.',
  installment_unsupported: '선택한 할부 개월수로는 결제할 수 없어요. 일시불로 시도해 주세요.',
  user_canceled: '결제를 취소했어요. 다시 결제하려면 충전 화면에서 시작해 주세요.',
  checkout_aborted: '결제가 완료되지 않았어요. 충전 화면에서 다시 시도해 주세요.',
  session_expired: '결제 시간이 만료됐어요. 충전 화면에서 다시 시작해 주세요.',
  provider_declined: '결제가 승인되지 않았어요. 다른 결제수단으로 다시 시도해 주세요.'
};

function text(value, max = 300) {
  if (value == null) return null;
  const s = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function upper(value) {
  const s = text(value, 120);
  return s ? s.toUpperCase() : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isTerminalAbandonedStatus(status) {
  return TERMINAL_ABANDONED_STATUSES.has(upper(status) || '');
}

function isTerminalCanceledStatus(status) {
  return TERMINAL_CANCELED_STATUSES.has(upper(status) || '');
}

function isPendingProviderStatus(status) {
  return PENDING_STATUSES.has(upper(status) || '');
}

// 코드 하나만 보고 "고객 사유 거절인가"를 판단한다. events 라우트(프런트 보고)와 공용.
function declineCategoryForCode(code) {
  const key = upper(code);
  if (!key) return null;
  if (OPERATOR_FAULT_CODES.has(key)) return null;
  if (AMBIGUOUS_CODES.has(key)) return null;
  const mapped = DECLINE_CATEGORY_BY_CODE.get(key);
  if (mapped) return mapped;
  // 우리가 내려보낸 409 코드(PAYMENT_ABORTED / PAYMENT_EXPIRED)도 정상 이탈이다.
  // 2026-09-04에는 이 경로가 없어서 프런트 보고가 client.payment_error(SEV2)로 올라왔다.
  if (key === 'PAYMENT_ABORTED') return 'checkout_aborted';
  if (key === 'PAYMENT_EXPIRED') return 'session_expired';
  if (key === 'PRODUCT_RETIRED') return 'checkout_aborted';
  return DECLINE_CODE_RE.test(key) ? 'provider_declined' : null;
}

/**
 * 결제 승인 실패 한 건을 분류한다.
 *
 * 입력은 "확인 호출(confirm)"과 "주문 조회(lookup)" 양쪽에서 알아낸 것 전부다.
 * 조회까지 마친 뒤 한 번만 부르면 로그도 한 줄로 끝난다(예전에는 단계마다 한 줄씩 총 2줄이 나갔다).
 */
function classifyPaymentFailure(input = {}) {
  const providerCode = upper(input.providerCode);
  const providerMessage = text(input.providerMessage);
  const providerStatus = upper(input.providerStatus);
  const providerFailureCode = upper(input.providerFailureCode);
  const providerFailureMessage = text(input.providerFailureMessage);
  const httpStatus = num(input.httpStatus);
  const lookupHttpStatus = num(input.lookupHttpStatus);
  const hasConfirmResponse = httpStatus != null;
  const networkError = text(input.networkError, 200);
  const lookupNetworkError = text(input.lookupNetworkError, 200);

  // 조회로 확인한 실패 사유가 승인 응답보다 정확하다. ABORTED 주문의 failure.code가 진짜 원인이다.
  const effectiveCode = providerFailureCode || providerCode;
  const effectiveMessage = providerFailureMessage || providerMessage;

  // ── ① 돈이 움직였을 가능성부터 본다. 여기 걸리면 다른 판정은 전부 무시한다. ──
  const ambiguousSignals = [];
  if (networkError) ambiguousSignals.push('confirm_network_error');
  if (!hasConfirmResponse && !networkError) ambiguousSignals.push('confirm_no_response');
  if (httpStatus != null && httpStatus >= 500) ambiguousSignals.push('confirm_provider_5xx');
  if (providerCode && AMBIGUOUS_CODES.has(providerCode)) ambiguousSignals.push('provider_ambiguous_code');
  if (lookupNetworkError) ambiguousSignals.push('lookup_network_error');
  if (lookupHttpStatus != null && lookupHttpStatus >= 500) ambiguousSignals.push('lookup_provider_5xx');

  const base = {
    providerCode: providerCode || null,
    providerMessage: providerMessage || null,
    providerFailureCode: providerFailureCode || null,
    providerFailureMessage: providerFailureMessage || null,
    providerStatus: providerStatus || null,
    providerHttpStatus: httpStatus,
    lookupHttpStatus,
    networkError: networkError || null,
    lookupNetworkError: lookupNetworkError || null,
    ambiguousSignals
  };

  // 조회가 단말 상태를 확정했으면 "돈이 안 나갔다"가 확실하다. 5xx 신호가 있어도 이쪽이 우선한다.
  const settledTerminal = isTerminalAbandonedStatus(providerStatus);

  if (ambiguousSignals.length && !settledTerminal) {
    const category = providerCode && AMBIGUOUS_CODES.has(providerCode)
      ? (providerCode === 'ALREADY_PROCESSED_PAYMENT' ? 'already_processed' : 'provider_unavailable')
      : (networkError || lookupNetworkError || !hasConfirmResponse ? 'network_lost' : 'provider_unavailable');
    return {
      ...base,
      outcome: OUTCOME_PROVIDER_AMBIGUOUS,
      category,
      categoryLabel: CATEGORY_LABEL[category],
      customerDecline: false,
      terminal: false,
      moneyAtRisk: true,
      creditGrantable: false,
      reconcilable: true,
      actionRequired: 'manual',
      alertEvent: 'payment.status_unknown',
      severityHint: 'SEV1',
      userMessage: '결제 상태 확인이 지연되고 있습니다. 잠시 후 다시 시도하면 자동으로 복구됩니다.',
      reason: `${CATEGORY_LABEL[category]}(${ambiguousSignals.join(',')})`
    };
  }

  // ── ② 우리 쪽 설정 오류 — 전 사용자 결제 불능. 절대 SEV3으로 내리지 않는다. ──
  if (effectiveCode && OPERATOR_FAULT_CODES.has(effectiveCode)) {
    return {
      ...base,
      outcome: OUTCOME_OPERATOR_FAULT,
      category: 'operator_config',
      categoryLabel: CATEGORY_LABEL.operator_config,
      customerDecline: false,
      terminal: true,
      moneyAtRisk: false,
      creditGrantable: false,
      reconcilable: false,
      actionRequired: 'manual',
      alertEvent: 'payment.provider_rejected_request',
      severityHint: 'SEV1',
      // 결제사 원문 메시지에 키·가맹점 정보가 실릴 수 있어 사용자에게는 일반 문구만 준다.
      userMessage: '결제 처리에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
      reason: `${CATEGORY_LABEL.operator_config}(${effectiveCode})`
    };
  }

  // ── ③ 취소된 결제 — 종료 상태지만 정상 이탈은 아니다. ──
  if (isTerminalCanceledStatus(providerStatus)) {
    return {
      ...base,
      outcome: OUTCOME_PROVIDER_AMBIGUOUS,
      category: 'provider_canceled',
      categoryLabel: CATEGORY_LABEL.provider_canceled,
      customerDecline: false,
      terminal: true,
      moneyAtRisk: true,
      creditGrantable: false,
      reconcilable: false,
      actionRequired: 'manual',
      alertEvent: 'payment.provider_not_done',
      severityHint: 'SEV2',
      userMessage: '취소된 결제라 크레딧을 지급하지 않았어요. 결제 내역을 확인해 주세요.',
      reason: `${CATEGORY_LABEL.provider_canceled}(${providerStatus})`
    };
  }

  // ── ④ 고객 사유 거절 — 돈 안 나감, 크레딧 없음, 우리가 할 일 없음. ──
  const declineCategory = declineCategoryForCode(effectiveCode)
    || (settledTerminal ? (providerStatus === 'EXPIRED' ? 'session_expired' : 'checkout_aborted') : null);
  if (declineCategory) {
    const label = CATEGORY_LABEL[declineCategory] || CATEGORY_LABEL.provider_declined;
    return {
      ...base,
      outcome: OUTCOME_CUSTOMER_DECLINED,
      category: declineCategory,
      categoryLabel: label,
      customerDecline: true,
      terminal: true,
      moneyAtRisk: false,
      creditGrantable: false,
      // 재시도해도 DONE이 되지 않는다 → 정산 워커가 다시 집지 않게 한다.
      reconcilable: false,
      actionRequired: 'none',
      alertEvent: 'payment.customer_declined',
      severityHint: 'SEV3',
      // 결제사 원문이 사용자에게 가장 정확하다("잔액부족으로 결제에 실패했습니다").
      userMessage: effectiveMessage
        || CATEGORY_USER_MESSAGE[declineCategory]
        || CATEGORY_USER_MESSAGE.provider_declined,
      reason: `${label}${effectiveCode ? `(${effectiveCode})` : (providerStatus ? `(${providerStatus})` : '')}`
    };
  }

  // ── ⑤ 아직 진행 중 — 재시도·정산으로 복구 가능. ──
  if (isPendingProviderStatus(providerStatus)) {
    return {
      ...base,
      outcome: OUTCOME_PROVIDER_PENDING,
      category: 'provider_pending',
      categoryLabel: CATEGORY_LABEL.provider_pending,
      customerDecline: false,
      terminal: false,
      moneyAtRisk: false,
      creditGrantable: false,
      reconcilable: true,
      actionRequired: 'monitor',
      alertEvent: 'payment.provider_not_done',
      severityHint: 'SEV2',
      userMessage: '결제가 아직 완료되지 않았어요. 결제를 마친 뒤 다시 시도해 주세요.',
      reason: `${CATEGORY_LABEL.provider_pending}(${providerStatus})`
    };
  }

  // ── ⑥ 모르는 실패 — 우리 장애로 취급한다(놓치는 것보다 낫다). ──
  return {
    ...base,
    outcome: OUTCOME_OPERATOR_FAULT,
    category: 'unknown',
    categoryLabel: CATEGORY_LABEL.unknown,
    customerDecline: false,
    terminal: false,
    moneyAtRisk: false,
    creditGrantable: false,
    reconcilable: true,
    actionRequired: 'monitor',
    alertEvent: 'payment.toss_confirm_failed',
    severityHint: 'SEV2',
    userMessage: '결제가 승인되지 않았어요. 잠시 후 다시 시도해 주세요.',
    reason: `${CATEGORY_LABEL.unknown}${effectiveCode ? `(${effectiveCode})` : ''}`
  };
}

// ── 재시도 상관관계 추적 ────────────────────────────────────────────────
// 왜: 로그 한 줄만 보면 "결제 실패 1건"이지만, 실제로는 같은 사람이 12분간 3번 되돌아간 것이었다.
// 알림·로그에 "이 사람의 5분 내 실패 N건 / 서로 다른 주문 M건"을 실어 한눈에 구분되게 한다.
// 인스턴스 메모리라 정확한 집계가 아니라 판단 보조용이다(요청 흐름을 막지 않는 것이 우선).
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_HISTORY_MS = 30 * 60 * 1000;
const FAILURE_SUBJECT_MAX = 2000;
const failureHistory = new Map(); // subject(uid|order) -> [{ t, orderId, category }]

function pruneFailureHistory(nowMs) {
  if (failureHistory.size < FAILURE_SUBJECT_MAX) return;
  for (const [key, entries] of failureHistory) {
    const kept = entries.filter(e => nowMs - e.t < FAILURE_HISTORY_MS);
    if (kept.length) failureHistory.set(key, kept);
    else failureHistory.delete(key);
  }
}

function push(key, entry, nowMs) {
  if (!key) return [];
  const kept = (failureHistory.get(key) || []).filter(e => nowMs - e.t < FAILURE_HISTORY_MS);
  kept.push(entry);
  failureHistory.set(key, kept);
  return kept;
}

/**
 * 실패 한 건을 기록하고 "이 사람/이 주문이 최근 얼마나 되풀이했는지"를 돌려준다.
 * @returns {{ uidFailures5m:number, uidDistinctOrders5m:number, orderAttempt:number, repeatedDecline:boolean, firstFailureAgoMs:number|null }}
 */
function trackFailure({ uid, orderId, category, outcome } = {}, nowMs = Date.now()) {
  pruneFailureHistory(nowMs);
  const entry = { t: nowMs, orderId: orderId || null, category: category || null, outcome: outcome || null };
  const uidEntries = uid ? push(`uid:${uid}`, entry, nowMs) : [];
  const orderEntries = orderId ? push(`order:${orderId}`, entry, nowMs) : [];
  const recentUid = uidEntries.filter(e => nowMs - e.t < FAILURE_WINDOW_MS);
  const distinctOrders = new Set(recentUid.map(e => e.orderId).filter(Boolean));
  const firstUid = uidEntries.length ? uidEntries[0].t : null;
  return {
    uidFailures5m: recentUid.length,
    uidFailures30m: uidEntries.length,
    uidDistinctOrders5m: distinctOrders.size,
    orderAttempt: orderEntries.length,
    // 같은 사람이 같은 사유로 되풀이 중 = 개인 사정이지 우리 장애가 아니라는 강한 신호.
    repeatedDecline: recentUid.length > 1
      && recentUid.every(e => e.outcome === OUTCOME_CUSTOMER_DECLINED)
      && new Set(recentUid.map(e => e.category)).size === 1,
    firstFailureAgoMs: firstUid == null ? null : Math.max(0, nowMs - firstUid)
  };
}

// 기록하지 않고 현재 집계만 읽는다. 프런트 보고(/events)는 이미 서버가 센 실패를
// 뒤따라 오는 것이라, 여기서 또 기록하면 같은 사건이 두 번 세어진다.
function peekFailures({ uid, orderId } = {}, nowMs = Date.now()) {
  const uidEntries = (uid ? failureHistory.get(`uid:${uid}`) : null) || [];
  const orderEntries = (orderId ? failureHistory.get(`order:${orderId}`) : null) || [];
  const recentUid = uidEntries.filter(e => nowMs - e.t < FAILURE_WINDOW_MS);
  return {
    uidFailures5m: recentUid.length,
    uidDistinctOrders5m: new Set(recentUid.map(e => e.orderId).filter(Boolean)).size,
    orderAttempt: orderEntries.filter(e => nowMs - e.t < FAILURE_HISTORY_MS).length
  };
}

function resetFailureHistory() {
  failureHistory.clear();
}

module.exports = {
  OUTCOME_CUSTOMER_DECLINED,
  OUTCOME_PROVIDER_AMBIGUOUS,
  OUTCOME_OPERATOR_FAULT,
  OUTCOME_PROVIDER_PENDING,
  TERMINAL_ABANDONED_STATUSES,
  DECLINE_CATEGORY_BY_CODE,
  OPERATOR_FAULT_CODES,
  AMBIGUOUS_CODES,
  CATEGORY_LABEL,
  classifyPaymentFailure,
  declineCategoryForCode,
  isTerminalAbandonedStatus,
  isTerminalCanceledStatus,
  isPendingProviderStatus,
  trackFailure,
  peekFailures,
  resetFailureHistory
};
