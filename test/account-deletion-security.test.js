'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertRecentAuth,
  accountDeletionPendingReasons,
  refundableOrderBlocksDeletion
} = require('../lib/accountDeletionPolicy');
const {
  accountDeletionHash,
  deleteAccountData,
  financialRetentionPatch
} = require('../lib/accountDeletionService');
const { FakeFirestore, fakeAdmin } = require('./helpers/fakeFirestore');

test('회원 탈퇴는 15분 이내 auth_time만 허용하고 누락·오래된 토큰은 거부한다', () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  assert.equal(assertRecentAuth({ auth_time: nowMs / 1000 - 899 }, { nowMs, maxAgeSeconds: 900 }).ageSeconds, 899);
  assert.throws(
    () => assertRecentAuth({ auth_time: nowMs / 1000 - 901 }, { nowMs, maxAgeSeconds: 900 }),
    { code: 'RECENT_LOGIN_REQUIRED', status: 401 }
  );
  assert.throws(() => assertRecentAuth({}, { nowMs, maxAgeSeconds: 900 }), { code: 'RECENT_LOGIN_REQUIRED' });
});

test('구독·결제확인·환불·활성 작업 및 환불 가능 주문을 삭제 전 409 사유로 모은다', () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  const reasons = accountDeletionPendingReasons({
    user: { subscription: { status: 'active' } },
    paymentIntents: [{ status: 'confirming' }],
    orders: [
      { status: 'refund_requested' },
      { status: 'paid', refundWindowEndsAt: new Date(nowMs + 1000) },
      { status: 'partially_refunded' }
    ],
    transformJobs: [{ status: 'running' }],
    nowMs
  });
  assert.deepEqual(new Set(reasons), new Set([
    'active_subscription',
    'payment_confirmation_pending',
    'refund_pending',
    'refundable_order_open',
    'partial_refund_unsettled',
    'transform_job_active'
  ]));
  assert.equal(refundableOrderBlocksDeletion({ status: 'refunded' }, nowMs), '');
});

test('재무 보존 메타는 uid·customerEmail·paymentKey·환불 스냅샷을 삭제하지 않는다', () => {
  const admin = fakeAdmin();
  const patch = financialRetentionPatch({ admin, deletedAccountHash: 'a'.repeat(64), now: 'NOW' });
  assert.deepEqual(patch, { deletedAccountHash: 'a'.repeat(64), accountDeletedAt: 'NOW' });
  for (const protectedField of ['uid', 'customerEmail', 'paymentKey', 'refundPolicyVersionAtPurchase']) {
    assert.equal(Object.hasOwn(patch, protectedField), false);
  }
});

test('단계별 탈퇴는 ledger/order/paymentKey를 보존하고 Auth를 마지막에 삭제한다', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  const uid = 'user-delete-1';
  const db = new FakeFirestore({
    [`users/${uid}`]: { email: 'user@example.com', credits: 90 },
    [`users/${uid}/history/h1`]: { inputText: 'private' },
    [`users/${uid}/creditHistory/c1`]: { type: 'charge', amount: 100 },
    [`users/${uid}/creditLots/o1`]: { refundPaidCreditsRemaining: 100 },
    [`billingSecrets/${uid}`]: { billingKey: 'billing-secret' },
    'orders/o1': {
      uid,
      status: 'paid',
      customerEmail: 'user@example.com',
      refundWindowEndsAt: new Date(nowMs - 1000),
      refundPolicyVersionAtPurchase: 'policy-v1'
    },
    'paymentSecrets/o1': { uid, paymentKey: 'payment-secret' }
  });
  const baseAdmin = fakeAdmin();
  let authDeleted = false;
  const admin = {
    ...baseAdmin,
    auth() {
      return {
        async deleteUser(targetUid) {
          assert.equal(targetUid, uid);
          assert.equal(db.rows.has(`users/${uid}`), false);
          assert.equal(db.rows.has(`billingSecrets/${uid}`), false);
          assert.equal(db.rows.get('orders/o1').paymentKey, undefined);
          assert.equal(db.rows.get('paymentSecrets/o1').paymentKey, 'payment-secret');
          assert.equal(db.rows.get('orders/o1').refundPolicyVersionAtPurchase, 'policy-v1');
          authDeleted = true;
        }
      };
    }
  };
  const secret = 'account-deletion-unit-secret-32bytes';
  const result = await deleteAccountData({ admin, db, uid, secret, nowMs });
  assert.equal(result.ok, true);
  assert.equal(authDeleted, true);
  assert.equal(db.rows.has(`users/${uid}/history/h1`), false);
  assert.equal(db.rows.has(`users/${uid}/creditHistory/c1`), true);
  assert.equal(db.rows.has(`users/${uid}/creditLots/o1`), true);
  assert.equal(db.rows.get('orders/o1').uid, uid);
  assert.equal(db.rows.get('orders/o1').customerEmail, 'user@example.com');
  assert.equal(db.rows.get('paymentSecrets/o1').uid, uid);
  const tombstone = db.rows.get(`accountDeletionTombstones/${accountDeletionHash(uid, secret)}`);
  assert.equal(tombstone.status, 'completed');
  assert.equal(tombstone.completedSteps.at(-1), 'firebase_auth_deleted');
});

test('탈퇴 중 Auth 삭제 실패는 tombstone 단계에서 재시도할 수 있다', async () => {
  const uid = 'retry-user';
  const secret = 'account-deletion-retry-secret-32bytes';
  const db = new FakeFirestore({ [`users/${uid}`]: { credits: 10 } });
  const admin = fakeAdmin();
  let attempts = 0;
  admin.auth = () => ({
    async deleteUser() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporary'), { code: 'auth/internal-error' });
    }
  });
  await assert.rejects(deleteAccountData({ admin, db, uid, secret }), { code: 'auth/internal-error' });
  const second = await deleteAccountData({ admin, db, uid, secret });
  assert.equal(second.ok, true);
  assert.equal(attempts, 2);
});
