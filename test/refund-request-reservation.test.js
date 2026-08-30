'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const payment = require('../routes/payment');

const {
  reserveCreditRefundCredits,
  restoreCreditRefundReservationInTransaction,
  creditRefundProcessing,
  resumableCreditRefund,
  refundRequestProcessingConflict
} = payment.refundPolicy;

const DELETE = Symbol('delete');
const fieldValue = {
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  delete: () => DELETE
};

function fakeStore(initialRows) {
  const rows = new Map(Object.entries(initialRows).map(([key, value]) => [key, { ...value }]));
  class Ref {
    constructor(key) {
      this.key = key;
      this.id = key.split('/').at(-1);
    }
    collection(name) {
      return { doc: id => new Ref(`${this.key}/${name}/${id}`) };
    }
  }
  const snapshot = ref => ({
    exists: rows.has(ref.key),
    data: () => rows.get(ref.key)
  });
  const transaction = {
    async get(ref) {
      return snapshot(ref);
    },
    update(ref, patch) {
      const current = { ...(rows.get(ref.key) || {}) };
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === DELETE) delete current[key];
        else current[key] = value;
      }
      rows.set(ref.key, current);
    }
  };
  return {
    ref: key => new Ref(key),
    transaction,
    row: key => rows.get(key)
  };
}

function trackedOrder() {
  return {
    uid: 'u-reserve',
    status: 'paid',
    amount: 58000,
    totalGrantedCredits: 2500,
    paidCredits: 2000,
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    creditLotPolicyVersion: 'credit-lot-v1',
    refundPaidCreditsRemaining: 1500,
    refundEventBonusCreditsRemaining: 500,
    refundCreditBasis: 'paid_credits_first'
  };
}

test('신청 시 해당 주문의 paid·bonus lot과 지갑을 한 트랜잭션에서 예약하고 사용 대상에서 제외한다', async () => {
  const order = trackedOrder();
  const store = fakeStore({
    'orders/order-reserve': order,
    'users/u-reserve': { credits: 5200, creditLotV1Balance: 2200 },
    'users/u-reserve/creditLots/order-reserve': {
      orderId: 'order-reserve',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      creditLotPolicyVersion: 'credit-lot-v1',
      refundPaidCreditsRemaining: 1500,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const orderRef = store.ref('orders/order-reserve');
  const userRef = store.ref('users/u-reserve');
  const reserved = await reserveCreditRefundCredits({
    transaction: store.transaction,
    orderRef,
    userRef,
    latestOrder: order,
    remainingOrderCredits: 2500,
    fieldValue
  });

  assert.equal(reserved.calculation.refundAmount, 43500);
  assert.equal(reserved.refundableCredits, 2000);
  assert.equal(reserved.processingLotFields.reservedPaidCredits, 1500);
  assert.equal(reserved.processingLotFields.reservedBonusCredits, 500);
  assert.deepEqual(store.row('users/u-reserve'), { credits: 3200, creditLotV1Balance: 200 });
  assert.deepEqual(store.row('users/u-reserve/creditLots/order-reserve'), {
    orderId: 'order-reserve',
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    creditLotPolicyVersion: 'credit-lot-v1',
    refundPaidCreditsRemaining: 0,
    refundEventBonusCreditsRemaining: 0,
    active: false,
    creditLotUpdatedAt: 'SERVER_TIMESTAMP'
  });
  assert.equal(reserved.orderLotUpdate.creditLotActive, false);
});

test('예약 직후 같은 주문의 중복 신청은 processing으로 막히고 helper 재진입도 지갑을 이중 차감하지 않는다', async () => {
  const orderRefKey = 'orders/order-duplicate';
  const userRefKey = 'users/u-reserve';
  const order = trackedOrder();
  const store = fakeStore({
    [orderRefKey]: order,
    [userRefKey]: { credits: 5200, creditLotV1Balance: 2200 },
    [`${userRefKey}/creditLots/order-duplicate`]: {
      orderId: 'order-duplicate',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      creditLotPolicyVersion: 'credit-lot-v1',
      refundPaidCreditsRemaining: 1500,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const orderRef = store.ref(orderRefKey);
  const userRef = store.ref(userRefKey);
  const first = await reserveCreditRefundCredits({
    transaction: store.transaction,
    orderRef,
    userRef,
    latestOrder: order,
    remainingOrderCredits: 2500,
    fieldValue
  });
  const operation = {
    operationId: 'refund-op-duplicate',
    priorRefundedAmount: 0,
    priorRefundedCredits: 0,
    refundAmount: first.calculation.refundAmount,
    creditsToDeduct: first.refundableCredits,
    targetRefundedAmount: first.calculation.refundAmount,
    targetRefundedCredits: first.refundableCredits,
    previousRefundPolicyVersion: null,
    previousRefundCreditBasis: order.refundCreditBasis,
    previousRefundCreditSettlementClosed: false,
    ...first.processingLotFields
  };
  store.transaction.update(orderRef, {
    ...first.orderLotUpdate,
    status: 'refund_requested',
    refundProcessing: creditRefundProcessing(operation, 'REQUESTED_AT', 'requested_reserved')
  });

  assert.equal(store.row(userRefKey).credits, 3200);
  assert.equal(store.row(`${userRefKey}/creditLots/order-duplicate`).active, false);
  assert.equal(refundRequestProcessingConflict(store.row(orderRefKey)).code, 'REFUND_PROCESSING');

  // Firestore의 route transaction은 status/processing 재검사에서 중단된다. 방어적으로
  // helper가 다시 호출돼도 이미 0으로 예약된 lot만 보므로 추가 차감은 발생하지 않는다.
  const second = await reserveCreditRefundCredits({
    transaction: store.transaction,
    orderRef,
    userRef,
    latestOrder: store.row(orderRefKey),
    remainingOrderCredits: 2500,
    fieldValue
  });
  assert.equal(second.refundableCredits, 0);
  assert.deepEqual(store.row(userRefKey), { credits: 3200, creditLotV1Balance: 200 });
});

test('거절 또는 결제사 확정 실패 복원은 paid·bonus 원장을 정확히 되돌리고 같은 operation을 두 번 복원하지 않는다', async () => {
  const orderRefKey = 'orders/order-restore';
  const userRefKey = 'users/u-restore';
  const operation = {
    operationId: 'refund-op-request-1',
    priorRefundedAmount: 0,
    priorRefundedCredits: 0,
    refundAmount: 43500,
    creditsToDeduct: 2000,
    targetRefundedAmount: 43500,
    targetRefundedCredits: 2000,
    previousRefundPolicyVersion: null,
    previousRefundCreditBasis: 'paid_credits_first',
    previousRefundCreditSettlementClosed: false,
    creditLotPolicyVersion: 'credit-lot-v1',
    reservedPaidCredits: 1500,
    reservedBonusCredits: 500
  };
  const processing = creditRefundProcessing(operation, 'REQUESTED_AT', 'requested_reserved');
  const store = fakeStore({
    [orderRefKey]: {
      ...trackedOrder(),
      uid: 'u-restore',
      status: 'refund_requested',
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      creditLotActive: false,
      refundCreditSettlementClosed: true,
      refundReservationState: 'reserved',
      refundReservationOperationId: operation.operationId,
      refundProcessing: processing
    },
    [userRefKey]: { credits: 3200, creditLotV1Balance: 200 },
    [`${userRefKey}/creditLots/order-restore`]: {
      orderId: 'order-restore',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      creditLotPolicyVersion: 'credit-lot-v1',
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      active: false
    }
  });
  const orderRef = store.ref(orderRefKey);
  const userRef = store.ref(userRefKey);
  const first = await restoreCreditRefundReservationInTransaction({
    transaction: store.transaction,
    orderRef,
    userRef,
    latestOrder: store.row(orderRefKey),
    operationId: operation.operationId,
    restoreReason: 'admin_rejected',
    orderUpdate: { status: 'refund_rejected', rejectReason: '정책 미충족' },
    fieldValue
  });

  assert.deepEqual(first, { restored: true, alreadyRestored: false, restoredCredits: 2000 });
  assert.deepEqual(store.row(userRefKey), { credits: 5200, creditLotV1Balance: 2200 });
  assert.equal(store.row(`${userRefKey}/creditLots/order-restore`).refundPaidCreditsRemaining, 1500);
  assert.equal(store.row(`${userRefKey}/creditLots/order-restore`).refundEventBonusCreditsRemaining, 500);
  assert.equal(store.row(`${userRefKey}/creditLots/order-restore`).active, true);
  assert.equal(store.row(orderRefKey).status, 'refund_rejected');
  assert.equal(store.row(orderRefKey).refundProcessing, undefined);
  assert.equal(store.row(orderRefKey).refundReservationState, 'restored');

  const second = await restoreCreditRefundReservationInTransaction({
    transaction: store.transaction,
    orderRef,
    userRef,
    latestOrder: store.row(orderRefKey),
    operationId: operation.operationId,
    restoreReason: 'admin_rejected',
    fieldValue
  });
  assert.deepEqual(second, { restored: false, alreadyRestored: true });
  assert.deepEqual(store.row(userRefKey), { credits: 5200, creditLotV1Balance: 2200 });
});

test('결제사 확정 실패는 신청 전 주문 상태와 exact paid·bonus reservation을 복원한다', async () => {
  const orderRefKey = 'orders/order-provider-failed';
  const userRefKey = 'users/u-provider-failed';
  const operation = {
    operationId: 'refund-op-provider-failed',
    priorRefundedAmount: 0,
    priorRefundedCredits: 0,
    refundAmount: 43500,
    creditsToDeduct: 2000,
    targetRefundedAmount: 43500,
    targetRefundedCredits: 2000,
    previousRefundPolicyVersion: null,
    previousRefundCreditBasis: 'paid_credits_first',
    previousRefundCreditSettlementClosed: false,
    previousOrderStatus: 'paid',
    creditLotPolicyVersion: 'credit-lot-v1',
    reservedPaidCredits: 1500,
    reservedBonusCredits: 500
  };
  const store = fakeStore({
    [orderRefKey]: {
      ...trackedOrder(),
      uid: 'u-provider-failed',
      status: 'refund_requested',
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      creditLotActive: false,
      refundCreditSettlementClosed: true,
      refundReservationState: 'provider_canceling',
      refundReservationOperationId: operation.operationId,
      refundProcessing: creditRefundProcessing(operation, 'PROVIDER_AT', 'provider_canceling')
    },
    [userRefKey]: { credits: 3200, creditLotV1Balance: 200 },
    [`${userRefKey}/creditLots/order-provider-failed`]: {
      orderId: 'order-provider-failed',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      creditLotPolicyVersion: 'credit-lot-v1',
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      active: false
    }
  });
  const result = await restoreCreditRefundReservationInTransaction({
    transaction: store.transaction,
    orderRef: store.ref(orderRefKey),
    userRef: store.ref(userRefKey),
    latestOrder: store.row(orderRefKey),
    operationId: operation.operationId,
    restoreReason: 'provider_cancel_failed',
    orderUpdate: { refundApprovalFailedAt: 'FAILED_AT' },
    fieldValue
  });
  assert.equal(result.restored, true);
  assert.equal(store.row(orderRefKey).status, 'paid');
  assert.equal(store.row(orderRefKey).refundProcessing, undefined);
  assert.deepEqual(store.row(userRefKey), { credits: 5200, creditLotV1Balance: 2200 });
  assert.equal(store.row(`${userRefKey}/creditLots/order-provider-failed`).refundPaidCreditsRemaining, 1500);
  assert.equal(store.row(`${userRefKey}/creditLots/order-provider-failed`).refundEventBonusCreditsRemaining, 500);
});

test('신청 예약 phase만 거절 가능하고 provider 단계로 넘어가면 동일 operation 재시도 상태로 잠긴다', () => {
  const base = {
    operationId: 'refund-op-phase',
    priorRefundedAmount: 0,
    priorRefundedCredits: 0,
    refundAmount: 2900,
    creditsToDeduct: 100,
    targetRefundedAmount: 2900,
    targetRefundedCredits: 100
  };
  const requested = resumableCreditRefund({
    refundProcessing: creditRefundProcessing(base, 'NOW', 'requested_reserved')
  });
  assert.equal(requested.phase, 'requested_reserved');
  const provider = resumableCreditRefund({
    refundProcessing: creditRefundProcessing(base, 'NOW', 'provider_canceling')
  });
  assert.equal(provider.phase, 'provider_canceling');
  assert.deepEqual(refundRequestProcessingConflict({ refundProcessing: requested }), {
    status: 409,
    code: 'REFUND_PROCESSING',
    message: '이미 환불 처리가 진행 중입니다. 잠시 후 상태를 다시 확인해 주세요.'
  });
});

test('사용자 환불 사유는 선택이고 관리자 거절 사유는 계속 필수이며 7일 경과 요청은 검토 플래그로 접수한다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  const requestRoute = source.slice(
    source.indexOf("router.post('/request-refund'"),
    source.indexOf("router.post('/approve-refund'")
  );
  assert.match(requestRoute, /const normalizedCancelReason = typeof cancelReason === 'string'/u);
  assert.doesNotMatch(requestRoute, /환불 사유를 입력해주세요/u);
  assert.match(requestRoute, /requiresEligibilityReview/u);
  assert.match(requestRoute, /refundReservationState: 'reserved'/u);
  assert.match(requestRoute, /readPaymentKey\(orderRef\.id, order\)[\s\S]*REFUND_PAYMENT_REFERENCE_UNAVAILABLE/u);
  assert.match(requestRoute, /const requestSequence[\s\S]*refundOperationId\([\s\S]*`request-\$\{requestSequence\}`/u);
  assert.match(requestRoute, /latestOrder\.refundPolicyVersionAtPurchase[\s\S]*legacy-total-grant-v1/u);
  assert.match(requestRoute, /transaction\.get\(deletionJobRef\)[\s\S]*accountDeletionBlocksPayment/u);
  assert.match(requestRoute, /lane:\s*'activeCreditRefunds'[\s\S]*status:\s*'requested_reserved'/u);

  const rejectRoute = source.slice(source.indexOf("router.post('/reject-refund'"));
  assert.match(rejectRoute, /if \(!rejectReason \|\| rejectReason\.trim\(\)\.length < 2\)/u);
  assert.match(rejectRoute, /restoreCreditRefundReservationInTransaction/u);
});

test('route 계약은 요청 예약을 승인에서 재사용하고 provider 확정 실패만 복원하며 불명 상태는 잠금을 유지한다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  const requestRoute = source.slice(
    source.indexOf("router.post('/request-refund'"),
    source.indexOf("router.post('/approve-refund'")
  );
  assert.match(requestRoute, /const latestOrder = latestSnap\.data\(\) \|\| \{\};[\s\S]*latestOrder\.status !== 'paid'/u);
  assert.match(requestRoute, /reserveCreditRefundCredits\(\{[\s\S]*transaction,[\s\S]*userRef:[\s\S]*latestOrder/u);
  assert.match(requestRoute, /refundRequestSnapshot:[\s\S]*refundProcessing: creditRefundProcessing\(operation, now, 'requested_reserved'\)/u);

  const approveRoute = source.slice(
    source.indexOf("router.post('/approve-refund'"),
    source.indexOf("router.post('/reject-refund'")
  );
  const resumableAt = approveRoute.indexOf('const resumable = resumableCreditRefund(latestOrder)');
  const freshReserveAt = approveRoute.indexOf('const reserved = await reserveCreditRefundCredits');
  assert.ok(resumableAt >= 0 && freshReserveAt > resumableAt, '기존 신청 reservation을 새 계산보다 먼저 사용해야 한다');
  assert.match(approveRoute, /resumable\.phase === 'requested_reserved'[\s\S]*refundProcessing\.phase': 'provider_canceling'/u);
  assert.match(approveRoute, /transaction\.get\(deletionJobRef\)[\s\S]*accountDeletionBlocksPayment/u);
  assert.match(approveRoute, /lane:\s*'activeCreditRefunds'[\s\S]*status:\s*'provider_canceling'/u);
  assert.match(approveRoute, /lane:\s*'activeCreditRefunds'[\s\S]*status:\s*'settled'/u);
  assert.match(approveRoute, /refundEligibilityReviewDecision\(order, req\.body \|\| \{\}\)[\s\S]*refund\.eligibility_review_not_recorded/u);
  assert.match(approveRoute, /refundEligibilityReviewDecision\(latestOrder, req\.body \|\| \{\}\)[\s\S]*refundEligibilityReviewUpdate/u);
  const unknownAt = approveRoute.indexOf('if (cancellationState.unknown)');
  const compensateAt = approveRoute.indexOf('await compensateCreditRefundReservation');
  assert.ok(unknownAt >= 0 && compensateAt > unknownAt, '결과 불명 상태는 보상 복원 전에 retryable로 남아야 한다');
  const unknownBlock = approveRoute.slice(unknownAt, compensateAt);
  assert.doesNotMatch(unknownBlock, /compensateCreditRefundReservation/u);
  assert.match(approveRoute.slice(compensateAt), /restoreReason: 'provider_cancel_failed'[\s\S]*status: 'paid'/u);
  assert.match(
    approveRoute,
    /cumulativeRefundCredits = result\.targetRefundedCredits[\s\S]*refundedAmount: finalRefundedAmount,[\s\S]*refundedCredits: Math\.max\(0, Math\.floor\(Number\(cumulativeRefundCredits\)/u,
    'request-time reservation 승인 최종화는 누적 환불 금액과 크레딧을 함께 영구 기록해야 한다'
  );
});

test('신규 크레딧·구독 주문은 구매 당시 약관 버전과 환불 시작·종료 스냅샷을 함께 저장한다', () => {
  const paymentSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  const subscriptionSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'subscription.js'), 'utf8');
  assert.match(paymentSource, /const refundPolicyPurchaseSnapshot = buildRefundPolicyPurchaseSnapshot\(\)/u);
  assert.match(paymentSource, /reconciliationSource,[\s\S]*\.\.\.refundPolicyPurchaseSnapshot,[\s\S]*createdAt:/u);
  assert.match(subscriptionSource, /buildRefundPolicyPurchaseSnapshot\([\s\S]*SUBSCRIPTION_REFUND_POLICY_VERSION/u);
  assert.match(subscriptionSource, /calculationBasis: SUBSCRIPTION_REFUND_CALCULATION_BASIS/u);
  assert.match(subscriptionSource, /bonusTreatment: SUBSCRIPTION_REFUND_BONUS_TREATMENT/u);
  assert.match(subscriptionSource, /cycleEndsAt: nextBillingAt,[\s\S]*\.\.\.refundPolicyPurchaseSnapshot/u);
  assert.match(paymentSource, /refundDirectAttemptSequence[\s\S]*`direct-\$\{directAttemptSequence\}`/u);
  assert.ok(
    (paymentSource.match(/refundPolicyVersion: refundPolicyVersionForOrder\(/gu) || []).length >= 2,
    '직접 환불과 요청 승인 경로가 모두 구매 당시 정책 버전 보존 helper를 사용해야 한다'
  );
});
