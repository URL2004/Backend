'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  markSubscriptionIntentApplied,
  markSubscriptionProviderApproved,
  prepareSubscriptionIntent,
  providerChargeStatusUncertain,
  recoverPendingSubscriptionPayments,
  subscriptionProviderValidation
} = require('../lib/subscriptionReconciliation');
const { FakeFirestore, fakeAdmin } = require('./helpers/fakeFirestore');
const opsEvents = require('../lib/opsEvents');

const PLAN = Object.freeze({
  amount: 11900,
  usesPerCycle: 50,
  charLimit: 1000,
  name: '베이직'
});
const PLANS = Object.freeze({ '1000': PLAN });
const ORDER_ID = 'sub_user-1_1788051600000';
const APPROVED_AT = '2026-08-30T00:00:00+09:00';

test('응답 유실 가능 HTTP 오류는 거절로 확정하지 않고 order 조회 대상으로 둔다', () => {
  for (const status of [0, 408, 409, 429, 500, 503]) {
    assert.equal(providerChargeStatusUncertain({ status }), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(providerChargeStatusUncertain({ status }), false, String(status));
  }
});

test('승인 후 미적용·수동 검토·스캔 실패는 운영 SEV1로 분류된다', () => {
  for (const event of [
    'subscription.apply_deferred_for_reconciliation',
    'subscription.reconciliation_manual_review',
    'subscription.reconciliation_scan_failed'
  ]) {
    assert.equal(opsEvents.classify(event, 'error').sev, 'SEV1', event);
  }
});

test('첫 결제·갱신·시간당 cron이 durable reconciliation 경로에 연결돼 있다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'subscription.js'), 'utf8');
  assert.ok((source.match(/prepareSubscriptionIntent\s*\(/g) || []).length >= 2,
    '첫 결제와 갱신 모두 provider 호출 전 intent를 저장해야 한다');
  assert.match(source, /recoverPendingSubscriptionPayments\s*\(\s*\{/);
  assert.match(source, /queryProvider:\s*tossQueryOrder/);
  assert.match(source, /approvedAt:\s*charged\.data\.approvedAt/);
  assert.ok(
    source.indexOf('recoverPendingSubscriptionPayments({')
      < source.indexOf('reconcilePendingCreditCancellationInboxes({'),
    '승인 주문을 먼저 복구한 뒤 취소 inbox를 재생해야 한다'
  );
});

function payment(overrides = {}) {
  return {
    status: 'DONE',
    orderId: ORDER_ID,
    totalAmount: PLAN.amount,
    paymentKey: 'test_payment_key',
    approvedAt: APPROVED_AT,
    ...overrides
  };
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

async function seedApprovedIntent(db, admin) {
  await prepareSubscriptionIntent({
    admin,
    db,
    orderId: ORDER_ID,
    uid: 'user-1',
    tier: '1000',
    amount: PLAN.amount,
    plan: PLAN,
    isFirst: false,
    cardCompany: '테스트카드',
    cardNumber: '1234',
    billingSecret: { billingKey: 'billing-key' }
  });
  const approval = await markSubscriptionProviderApproved({
    admin,
    db,
    orderId: ORDER_ID,
    payment: payment()
  });
  assert.equal(approval.approved, true);
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'approved_reconciliation_required');
}

function idempotentCycleApplier(db, admin, counters) {
  return async args => db.runTransaction(async transaction => {
    const orderRef = db.collection('subscriptionOrders').doc(args.paymentResult.orderId);
    const userRef = db.collection('users').doc(args.uid);
    const existing = await transaction.get(orderRef);
    if (existing.exists) return { applied: false, deduped: true };
    const user = await transaction.get(userRef);
    transaction.set(orderRef, {
      uid: args.uid,
      tier: args.tier,
      amount: args.plan.amount,
      paymentKeyPresent: true,
      status: 'paid',
      approvedAt: APPROVED_AT,
      refundPolicyVersion: 'credit-refund-v2'
    });
    transaction.set(userRef, {
      creditsGranted: Number(user.data()?.creditsGranted || 0) + args.plan.usesPerCycle
    }, { merge: true });
    counters.grants += 1;
    return { applied: true, deduped: false };
  });
}

test('Toss 승인 뒤 최초 DB 적용 실패는 다음 cron에서 같은 주문으로 자동 복구한다', async () => {
  const db = new FakeFirestore({ 'users/user-1': { creditsGranted: 0 } });
  const admin = fakeAdmin();
  await seedApprovedIntent(db, admin);

  // The original request failed after approval.  No order or entitlement was
  // committed, but the durable approved intent and provider payment key remain.
  assert.equal(db.rows.has(`subscriptionOrders/${ORDER_ID}`), false);
  assert.equal(db.rows.get(`paymentSecrets/${ORDER_ID}`).paymentKey, 'test_payment_key');

  const counters = { grants: 0 };
  const result = await recoverPendingSubscriptionPayments({
    admin,
    db,
    queryProvider: async orderId => ({ ok: true, data: payment({ orderId }) }),
    applyCycle: idempotentCycleApplier(db, admin, counters),
    readBillingKey: async () => 'billing-key',
    plans: PLANS,
    logger: quietLogger()
  });

  assert.deepEqual({ scanned: result.scanned, recovered: result.recovered, failed: result.failed }, {
    scanned: 1,
    recovered: 1,
    failed: 0
  });
  assert.equal(counters.grants, 1);
  assert.equal(db.rows.get('users/user-1').creditsGranted, PLAN.usesPerCycle);
  assert.equal(db.rows.get(`subscriptionOrders/${ORDER_ID}`).status, 'paid');
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'applied');
});

test('중복 cron은 적용 완료 intent를 다시 지급하지 않는다', async () => {
  const db = new FakeFirestore({ 'users/user-1': { creditsGranted: 0 } });
  const admin = fakeAdmin();
  await seedApprovedIntent(db, admin);
  const counters = { grants: 0 };
  const options = {
    admin,
    db,
    queryProvider: async () => ({ ok: true, data: payment() }),
    applyCycle: idempotentCycleApplier(db, admin, counters),
    readBillingKey: async () => 'billing-key',
    plans: PLANS,
    logger: quietLogger()
  };

  const first = await recoverPendingSubscriptionPayments(options);
  const second = await recoverPendingSubscriptionPayments(options);
  assert.equal(first.recovered, 1);
  assert.equal(second.scanned, 0);
  assert.equal(counters.grants, 1);
  assert.equal(db.rows.get('users/user-1').creditsGranted, PLAN.usesPerCycle);
});

test('provider가 DONE이 아니면 혜택을 적용하지 않고 재조회 대상으로 유지한다', async () => {
  const db = new FakeFirestore({ 'users/user-1': { creditsGranted: 0 } });
  const admin = fakeAdmin();
  await prepareSubscriptionIntent({
    admin,
    db,
    orderId: ORDER_ID,
    uid: 'user-1',
    tier: '1000',
    amount: PLAN.amount,
    plan: PLAN,
    isFirst: false
  });
  let applyCalls = 0;
  const result = await recoverPendingSubscriptionPayments({
    admin,
    db,
    queryProvider: async () => ({ ok: true, data: payment({ status: 'IN_PROGRESS' }) }),
    applyCycle: async () => { applyCalls += 1; },
    readBillingKey: async () => 'billing-key',
    plans: PLANS,
    logger: quietLogger(),
    maxAttempts: 6
  });

  assert.equal(result.deferred, 1);
  assert.equal(applyCalls, 0);
  assert.equal(db.rows.has(`subscriptionOrders/${ORDER_ID}`), false);
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'confirming');
});

test('초기 청구의 HTTP 성공 응답이 non-DONE이어도 intent를 terminal로 빼지 않는다', async () => {
  const db = new FakeFirestore({});
  const admin = fakeAdmin();
  await prepareSubscriptionIntent({
    admin,
    db,
    orderId: ORDER_ID,
    uid: 'user-1',
    tier: '1000',
    amount: PLAN.amount,
    plan: PLAN,
    isFirst: false
  });
  const approval = await markSubscriptionProviderApproved({
    admin,
    db,
    orderId: ORDER_ID,
    payment: payment({ status: 'IN_PROGRESS' })
  });
  assert.equal(approval.approved, false);
  assert.equal(approval.identityMismatch, false);
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'confirming');
});

test('이미 applied인 승인건은 provider 조회와 내부 적용 모두 no-op이다', async () => {
  const db = new FakeFirestore({
    [`paymentIntents/${ORDER_ID}`]: {
      purchaseKind: 'subscription_cycle',
      orderId: ORDER_ID,
      uid: 'user-1',
      tier: '1000',
      amount: PLAN.amount,
      status: 'applied'
    },
    [`subscriptionOrders/${ORDER_ID}`]: { uid: 'user-1', status: 'paid', amount: PLAN.amount }
  });
  const admin = fakeAdmin();
  let providerCalls = 0;
  let applyCalls = 0;
  const result = await recoverPendingSubscriptionPayments({
    admin,
    db,
    queryProvider: async () => { providerCalls += 1; return { ok: true, data: payment() }; },
    applyCycle: async () => { applyCalls += 1; },
    readBillingKey: async () => 'billing-key',
    plans: PLANS,
    logger: quietLogger()
  });
  assert.equal(result.scanned, 0);
  assert.equal(providerCalls, 0);
  assert.equal(applyCalls, 0);
});

test('영구 주문 충돌은 반복 지급하지 않고 manual_review로 종결한다', async () => {
  const db = new FakeFirestore({ 'users/user-1': { creditsGranted: 0 } });
  const admin = fakeAdmin();
  await seedApprovedIntent(db, admin);
  const conflict = Object.assign(new Error('SUBSCRIPTION_ORDER_CONFLICT'), { code: 'SUBSCRIPTION_ORDER_CONFLICT' });
  const result = await recoverPendingSubscriptionPayments({
    admin,
    db,
    queryProvider: async () => ({ ok: true, data: payment() }),
    applyCycle: async () => { throw conflict; },
    readBillingKey: async () => 'billing-key',
    plans: PLANS,
    logger: quietLogger()
  });
  assert.equal(result.manualReview, 1);
  assert.equal(result.recovered, 0);
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'manual_review');
  assert.equal(db.rows.has(`subscriptionOrders/${ORDER_ID}`), false);
});

test('같은 orderId의 paymentKey가 바뀌면 기존 서버 시크릿을 덮지 않고 manual review한다', async () => {
  const db = new FakeFirestore({});
  const admin = fakeAdmin();
  await seedApprovedIntent(db, admin);
  const second = await markSubscriptionProviderApproved({
    admin,
    db,
    orderId: ORDER_ID,
    payment: payment({ paymentKey: 'different-payment-key' })
  });
  assert.equal(second.approved, false);
  assert.equal(second.identityMismatch, true);
  assert.ok(second.validation.reasons.includes('payment_key_mismatch'));
  assert.equal(db.rows.get(`paymentSecrets/${ORDER_ID}`).paymentKey, 'test_payment_key');
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'manual_review');
});

test('provider terminal 상태와 승인 주문 식별자 불일치를 구분한다', async () => {
  const expected = { orderId: ORDER_ID, amount: PLAN.amount };
  assert.deepEqual(subscriptionProviderValidation(payment({ status: 'CANCELED' }), expected).reasons, ['status_not_done']);
  assert.deepEqual(subscriptionProviderValidation(payment({ orderId: 'other-order' }), expected).reasons, ['order_id_mismatch']);

  const db = new FakeFirestore({});
  const admin = fakeAdmin();
  await prepareSubscriptionIntent({
    admin,
    db,
    orderId: ORDER_ID,
    uid: 'user-1',
    tier: '1000',
    amount: PLAN.amount,
    plan: PLAN,
    isFirst: false
  });
  const result = await recoverPendingSubscriptionPayments({
    admin,
    db,
    queryProvider: async () => ({ ok: true, data: payment({ status: 'CANCELED' }) }),
    applyCycle: async () => assert.fail('terminal provider payment must not be applied'),
    readBillingKey: async () => 'billing-key',
    plans: PLANS,
    logger: quietLogger(),
    maxAttempts: 2
  });
  assert.equal(result.terminal, 1);
  assert.equal(db.rows.get(`paymentIntents/${ORDER_ID}`).status, 'provider_terminal');
});

test('상품 가격 변경 뒤에도 승인 당시 planSnapshot으로 이미 결제된 사이클을 복구한다', async () => {
  const db = new FakeFirestore({ 'users/user-1': { creditsGranted: 0 } });
  const admin = fakeAdmin();
  await seedApprovedIntent(db, admin);
  let appliedPlan = null;
  const counters = { grants: 0 };
  const baseApply = idempotentCycleApplier(db, admin, counters);
  const result = await recoverPendingSubscriptionPayments({
    admin,
    db,
    queryProvider: async () => ({ ok: true, data: payment() }),
    applyCycle: async args => { appliedPlan = args.plan; return baseApply(args); },
    readBillingKey: async () => 'billing-key',
    plans: { '1000': { ...PLAN, amount: 12900, usesPerCycle: 55 } },
    logger: quietLogger()
  });
  assert.equal(result.recovered, 1);
  assert.equal(appliedPlan.amount, PLAN.amount);
  assert.equal(appliedPlan.usesPerCycle, PLAN.usesPerCycle);
});

test('applied 표식은 법적 주문/결제 비밀 스냅샷을 삭제하거나 덮어쓰지 않는다', async () => {
  const db = new FakeFirestore({
    [`paymentIntents/${ORDER_ID}`]: { status: 'approved_reconciliation_required', uid: 'user-1' },
    [`subscriptionOrders/${ORDER_ID}`]: {
      uid: 'user-1',
      amount: PLAN.amount,
      status: 'paid',
      refundPolicyVersion: 'credit-refund-v2',
      refundCalculationBasis: 'base_credit_ratio'
    },
    [`paymentSecrets/${ORDER_ID}`]: { uid: 'user-1', paymentKey: 'payment-key-retained' }
  });
  const admin = fakeAdmin();
  await markSubscriptionIntentApplied({ admin, db, orderId: ORDER_ID, source: 'test' });
  assert.equal(db.rows.get(`subscriptionOrders/${ORDER_ID}`).refundPolicyVersion, 'credit-refund-v2');
  assert.equal(db.rows.get(`subscriptionOrders/${ORDER_ID}`).refundCalculationBasis, 'base_credit_ratio');
  assert.equal(db.rows.get(`paymentSecrets/${ORDER_ID}`).paymentKey, 'payment-key-retained');
});
