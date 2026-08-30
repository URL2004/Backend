'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const payment = require('../routes/payment');
const { paymentKeyHash } = require('../lib/paymentReconciliation');

const {
  paymentCallbackBindingHash,
  accountDeletionBlocksPayment,
  paymentIntentPreclaimExpired,
  upgradeCheckoutReservationPatch,
  paymentReconciliationClaimable,
  paymentIntentProviderMatches
} = payment.creditGrantPolicy;
const {
  REFERRAL_DAILY_INVITER_LIMIT,
  normalizeReferralCode,
  referralUtcDay,
  sameSignupClientPrincipal
} = payment.referralPolicy;
const {
  currentSubscriptionRefundContext,
  activeSubscriptionRefundClaim,
  subscriptionRefundGenerationCanMutateUser
} = payment.refundPolicy;

function timestamp(ms) {
  return { toMillis: () => ms };
}

test('일회성 결제 콜백 바인딩은 uid·order·금액·paymentKey 중 하나만 달라도 달라진다', () => {
  const base = {
    uid: 'uid-a',
    orderId: 'order_abcdef',
    amount: 2900,
    paymentKeyDigest: paymentKeyHash('payment-key-a')
  };
  const digest = paymentCallbackBindingHash(base);
  assert.equal(digest.length, 64);
  for (const changed of [
    { ...base, uid: 'uid-b' },
    { ...base, orderId: 'order_bcdefg' },
    { ...base, amount: 8700 },
    { ...base, paymentKeyDigest: paymentKeyHash('payment-key-b') }
  ]) {
    assert.notEqual(paymentCallbackBindingHash(changed), digest);
  }
});

test('탈퇴 처리 중이거나 보호기간이 남은 계정은 결제 intent 생성·적용에서 차단된다', () => {
  for (const status of ['processing', 'retry_pending', 'manual_review']) {
    assert.equal(accountDeletionBlocksPayment({ status }), true);
  }
  assert.equal(accountDeletionBlocksPayment({ status: 'completed', protectUntilMs: 2000 }, 1000), true);
  assert.equal(accountDeletionBlocksPayment({ status: 'completed', protectUntilMs: 1000 }, 2000), false);
  assert.equal(accountDeletionBlocksPayment({ status: 'failed' }, 1000), false);
});

test('사전 UID 선점은 v2 intent만 만료 판정하며 callback이 강한 claim을 보존한다', () => {
  assert.equal(paymentIntentPreclaimExpired({ ownerClaimVersion: 1, checkoutExpiresAtMs: 1 }, 2), false);
  assert.equal(paymentIntentPreclaimExpired({ ownerClaimVersion: 2, checkoutExpiresAtMs: 1 }, 2), true);
  assert.equal(paymentIntentPreclaimExpired({ ownerClaimVersion: 2, checkoutExpiresAtMs: 2 }, 2), false);
});

test('스타터 업그레이드는 provider 호출 전에 source order를 단일 checkout에 선점한다', () => {
  const source = { uid: 'uid-a', amount: 2900, status: 'paid' };
  const patch = upgradeCheckoutReservationPatch(source, {
    uid: 'uid-a', orderId: 'order_1760000000000_a1b2c3d4', nowMs: 1000
  });
  assert.equal(patch.upgradeCheckoutOrderId, 'order_1760000000000_a1b2c3d4');
  assert.ok(patch.upgradeCheckoutExpiresAtMs > 1000);
  assert.throws(() => upgradeCheckoutReservationPatch({
    ...source,
    upgradeCheckoutOrderId: 'order_1760000000001_deadbeef',
    upgradeCheckoutExpiresAtMs: 2000
  }, {
    uid: 'uid-a', orderId: 'order_1760000000000_a1b2c3d4', nowMs: 1500
  }), error => error?.code === 'UPGRADE_SOURCE_CONFLICT');
  assert.doesNotThrow(() => upgradeCheckoutReservationPatch({
    ...source,
    upgradeCheckoutOrderId: 'order_1760000000001_deadbeef',
    upgradeCheckoutExpiresAtMs: 1000
  }, {
    uid: 'uid-a', orderId: 'order_1760000000000_a1b2c3d4', nowMs: 1500
  }));
});

test('추천 코드는 실제 UID prefix 규격이고 동일 가입 환경은 양쪽 증거가 있을 때만 거절한다', () => {
  assert.equal(normalizeReferralCode(' AbC_12-x '), 'AbC_12-x');
  for (const invalid of ['', 'short', 'ninechars9', '한글코드12', 'abcd 123']) {
    assert.equal(normalizeReferralCode(invalid), '');
  }
  assert.equal(sameSignupClientPrincipal({}, {}), false);
  assert.equal(sameSignupClientPrincipal({ signupClientPrincipal: 'p1' }, {}), false);
  assert.equal(sameSignupClientPrincipal(
    { signupClientPrincipal: 'p1' },
    { signupClientPrincipal: 'p1' }
  ), true);
  assert.equal(sameSignupClientPrincipal(
    { signupClientPrincipal: 'p1' },
    { signupClientPrincipal: 'p2' }
  ), false);
  assert.equal(REFERRAL_DAILY_INVITER_LIMIT, 50);
  assert.equal(referralUtcDay(Date.UTC(2026, 7, 30, 23, 59, 59)), '2026-08-30');
});

test('승인 후 적용 실패 intent는 retryAt과 lease를 모두 만족할 때만 워커가 선점한다', () => {
  const candidate = { reconciliationCandidate: true, status: 'approved_reconciliation_required' };
  assert.equal(paymentReconciliationClaimable(candidate, 1000), true);
  assert.equal(paymentReconciliationClaimable({ ...candidate, reconciliationRetryAtMs: 1001 }, 1000), false);
  assert.equal(paymentReconciliationClaimable({
    ...candidate,
    reconciliationLeaseToken: 'lease',
    reconciliationLeaseUntilMs: 1001
  }, 1000), false);
  assert.equal(paymentReconciliationClaimable({
    ...candidate,
    reconciliationLeaseToken: 'lease',
    reconciliationLeaseUntilMs: 999
  }, 1000), true);
  assert.equal(paymentReconciliationClaimable({ ...candidate, status: 'applied' }, 1000), false);
});

test('결제사 재조회 결과도 원래 uid callback binding과 paymentKey digest에 묶인다', () => {
  const orderId = 'order_abcdef';
  const paymentKey = 'provider-payment-key';
  const intent = {
    uid: 'uid-owner',
    amount: 2900,
    paymentKeyHash: paymentKeyHash(paymentKey)
  };
  intent.callbackBindingHash = paymentCallbackBindingHash({
    uid: intent.uid,
    orderId,
    amount: intent.amount,
    paymentKeyDigest: intent.paymentKeyHash
  });
  const provider = { orderId, paymentKey, totalAmount: 2900, status: 'DONE' };
  assert.deepEqual(paymentIntentProviderMatches(intent, provider, orderId), { ok: true, reasons: [] });
  assert.deepEqual(
    paymentIntentProviderMatches({ ...intent, callbackBindingHash: '0'.repeat(64) }, provider, orderId),
    { ok: false, reasons: ['callback_binding_mismatch'] }
  );
});

test('currentOrderId가 있는 구독은 시간·티어가 같아도 과거 주문 환불과 일치하지 않는다', () => {
  const paidAtMs = 1_700_000_000_000;
  const user = {
    subscription: {
      tier: '5000',
      currentOrderId: 'sub-new-generation',
      cycleStartedAt: timestamp(paidAtMs)
    },
    coupon: { tier: '5000', remaining: 50, granted: 50, used: 0 }
  };
  const order = { orderId: 'sub-old-generation', tier: '5000' };
  assert.equal(currentSubscriptionRefundContext(user, order, paidAtMs, order.orderId).sameCycle, false);
  assert.equal(currentSubscriptionRefundContext(
    user,
    { ...order, orderId: 'sub-new-generation' },
    paidAtMs,
    'sub-new-generation'
  ).sameCycle, true);
});

test('구독 환불 claim 재시도와 사용자 세대 폐쇄 권한은 같은 operation에만 허용된다', () => {
  const order = {
    uid: 'uid-owner',
    subscriptionRefundProcessing: { operationId: 'operation-a' }
  };
  const claim = {
    uid: 'uid-owner',
    orderId: 'sub-order-a',
    generationOrderId: 'sub-order-a',
    operationId: 'operation-a',
    status: 'provider_status_unknown'
  };
  assert.equal(activeSubscriptionRefundClaim(claim, order, 'sub-order-a'), true);
  assert.equal(activeSubscriptionRefundClaim({ ...claim, operationId: 'operation-b' }, order, 'sub-order-a'), false);
  assert.equal(subscriptionRefundGenerationCanMutateUser({
    subscriptionRefundLock: { operationId: 'operation-a', orderId: 'sub-order-a' }
  }, claim), true);
  assert.equal(subscriptionRefundGenerationCanMutateUser({
    subscription: { currentOrderId: 'sub-new-generation' },
    subscriptionRefundLock: { operationId: 'operation-a', orderId: 'sub-order-a' }
  }, claim), false);
});

test('payment route keeps payment/deletion and subscription/provider race contracts wired', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  assert.match(source, /transaction\.get\(deletionJobRef\)/u);
  assert.match(source, /accountDeletionBlocksPayment\(deletionJobSnap\.data\(\)\)/u);
  assert.match(source, /router\.post\('\/cron\/reconcile-payments'/u);
  assert.match(source, /reconciliationCandidate:\s*true/u);
  assert.match(source, /PAYMENT_ACCOUNT_CLAIMS_COLLECTION\s*=\s*'paymentAccountClaims'/u);
  assert.match(source, /lane:\s*'activeCreditIntents'/u);
  assert.match(source, /lane:\s*'activeSubscriptionRefunds'/u);
  assert.match(source, /lane:\s*'activeCreditRefunds'/u);
  assert.match(source, /refundUserRef[\s\S]*?transaction\.get\(deletionJobRef\)[\s\S]*?activeCreditRefunds/u);
  assert.match(source, /subscriptionRefundClaims/u);
  assert.match(source, /claimSubscriptionRefund[\s\S]*?transaction\.get\(deletionJobRef\)[\s\S]*?accountDeletionBlocksPayment/u);
  assert.match(source, /subscription:\s*admin\.firestore\.FieldValue\.delete\(\)/u);
  assert.match(source, /currentSubscriptionRefundContext\([\s\S]*?orderRef\.id/u);
  assert.match(source, /cancellationLedgerId\(orderRef\.id, claim\.refundAmount\)/u);
  assert.match(source, /router\.post\('\/prepare-payment'/u);
  assert.match(source, /PAYMENT_PRECLAIM_REQUIRED/u);
  assert.match(source, /ownerClaimVersion:\s*Number\(existing\?\.ownerClaimVersion\)\s*>=\s*2\s*\?\s*2\s*:\s*1/u);
  assert.match(source, /collection\('accountSecurity'\)\.doc\(newUid\)/u);
  assert.match(source, /collection\('accountSecurity'\)\.doc\(referrerUid\)/u);
  assert.match(source, /collection\('referralDaily'\)/u);
  assert.match(source, /REFERRAL_DAILY_INVITER_LIMIT\s*=\s*50/u);
  assert.match(source, /inviteeDeletionSnap[\s\S]*?inviterDeletionSnap/u);
  assert.doesNotMatch(source, /const\s*\{[^}]*customerEmail[^}]*\}\s*=\s*body/u);
  assert.match(source, /verifiedCustomerEmail\s*=\s*typeof decodedToken\.email/u);
  assert.match(source, /customerEmail:\s*verifiedCustomerEmail/u);
  assert.match(source, /legacyBodyUid[\s\S]*?legacyUidPresent:\s*true/u);
});
