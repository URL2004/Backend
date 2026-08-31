'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeReferralCode,
  consumeReferralAttemptQuota,
  registerPendingReferral,
  vestPendingReferral,
  releaseMaturedReferralRewards
} = require('../lib/referralService');
const { FakeFirestore, fakeAdmin } = require('./helpers/fakeFirestore');

const ENV = {
  REFERRAL_VESTING_SECRET: 'referral-vesting-unit-secret-32bytes',
  REFERRAL_REWARD_CREDITS: '20',
  REFERRAL_APPLY_WINDOW_DAYS: '7',
  REFERRAL_DAILY_ATTEMPT_CAP: '10'
};

test('추천 코드는 제한된 형식만 허용해 쿼리·로그 오염을 막는다', () => {
  assert.equal(normalizeReferralCode(' abcDEF12 '), 'abcDEF12');
  for (const value of ['', 'abc', '한글코드12', 'abc def1', 'a'.repeat(33)]) {
    assert.throws(() => normalizeReferralCode(value), { code: 'REFERRAL_CODE_INVALID' });
  }
});

test('추천 코드 대입 시도는 UID별 일일 영속 한도를 넘으면 429로 막는다', async () => {
  const db = new FakeFirestore({});
  const admin = fakeAdmin();
  const nowMs = Date.UTC(2026, 7, 30, 12);
  for (let i = 0; i < 3; i++) {
    await consumeReferralAttemptQuota({ admin, db, uid: 'quota-user', nowMs: nowMs + i, cap: 3 });
  }
  await assert.rejects(
    consumeReferralAttemptQuota({ admin, db, uid: 'quota-user', nowMs: nowMs + 4, cap: 3 }),
    error => error.code === 'REFERRAL_RATE_LIMITED' && error.status === 429 && error.retryAfterSeconds > 0
  );
});

test('추천 등록은 즉시 크레딧을 지급하지 않고 pending만 원자적으로 기록한다', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  const db = new FakeFirestore({
    'users/invitee01': { credits: 10, refCode: 'invitee0', createdAt: nowMs - 1000 },
    'users/referrer01': { credits: 80, refCode: 'REFER123', createdAt: nowMs - 100000 }
  });
  const admin = fakeAdmin();
  const result = await registerPendingReferral({
    admin,
    db,
    uid: 'invitee01',
    refCode: 'REFER123',
    nowMs,
    env: ENV
  });
  assert.equal(result.pending, true);
  assert.equal(db.rows.get('users/invitee01').credits, 10);
  assert.equal(db.rows.get('users/referrer01').credits, 80);
  assert.equal(db.rows.get('users/invitee01').referral.status, 'pending');
  assert.equal(db.rows.get('users/invitee01').referral.vestingTrigger, 'first_settled_purchase');
  assert.equal(db.rows.get('users/invitee01').referral.refundAbusePolicy, 'hold_until_refund_window_closes_v1');
  const usage = db.rows.get('users/invitee01/serverUsage/referral_apply_20260830');
  assert.equal(usage.count, 1);
  assert.equal(typeof usage.expiresAt.toMillis, 'function');
});

test('자기추천·중복·가입기간 경과·이미 결제한 계정은 거부한다', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  const admin = fakeAdmin();
  const selfDb = new FakeFirestore({
    'users/same-user': { credits: 10, refCode: 'SELF1234', createdAt: nowMs }
  });
  await assert.rejects(
    registerPendingReferral({ admin, db: selfDb, uid: 'same-user', refCode: 'SELF1234', nowMs, env: ENV }),
    { code: 'REFERRAL_SELF_NOT_ALLOWED' }
  );

  const paidDb = new FakeFirestore({
    'users/invitee02': { credits: 10, refCode: 'invitee2', createdAt: nowMs - 1000, lastPayment: nowMs - 500 },
    'users/referrer02': { credits: 10, refCode: 'REFER456', createdAt: nowMs - 1000 }
  });
  await assert.rejects(
    registerPendingReferral({ admin, db: paidDb, uid: 'invitee02', refCode: 'REFER456', nowMs, env: ENV }),
    { code: 'REFERRAL_PURCHASE_ALREADY_SETTLED' }
  );
});

test('첫 settled purchase는 보상을 잠그고 환불 가능 기간 종료 뒤 양쪽에 한 번만 지급한다', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  const db = new FakeFirestore({
    'users/invitee03': {
      credits: 110,
      refCode: 'invitee3',
      createdAt: nowMs - 1000,
      referral: {
        version: 2,
        status: 'pending',
        referrerUid: 'referrer03',
        rewardCredits: 20,
        refundReversalPolicy: 'manual_review_v1'
      }
    },
    'users/referrer03': { credits: 50, refCode: 'REFER789' },
    'orders/order-first': {
      uid: 'invitee03', status: 'paid', amount: 2900,
      refundWindowEndsAt: { toMillis: () => nowMs + 7 * 24 * 60 * 60 * 1000 }
    }
  });
  const admin = fakeAdmin();
  const first = await vestPendingReferral({
    admin,
    db,
    inviteeUid: 'invitee03',
    orderCollection: 'orders',
    orderId: 'order-first',
    env: ENV
  });
  const duplicateLock = await vestPendingReferral({
    admin,
    db,
    inviteeUid: 'invitee03',
    orderCollection: 'orders',
    orderId: 'order-first',
    env: ENV
  });
  assert.equal(first.locked, true);
  assert.equal(duplicateLock.vested, false);
  assert.equal(db.rows.get('users/invitee03').credits, 110);
  assert.equal(db.rows.get('users/referrer03').credits, 50);
  assert.equal(db.rows.get('users/invitee03').referral.status, 'locked');
  const early = await releaseMaturedReferralRewards({ admin, db, nowMs: nowMs + 6 * 24 * 60 * 60 * 1000 });
  assert.equal(early.released, 0);
  const matured = await releaseMaturedReferralRewards({ admin, db, nowMs: nowMs + 8 * 24 * 60 * 60 * 1000 });
  const repeated = await releaseMaturedReferralRewards({ admin, db, nowMs: nowMs + 9 * 24 * 60 * 60 * 1000 });
  assert.equal(matured.released, 1);
  assert.equal(repeated.released, 0);
  assert.equal(db.rows.get('users/invitee03').credits, 130);
  assert.equal(db.rows.get('users/referrer03').credits, 70);
  assert.equal(db.rows.get('users/invitee03').referral.status, 'vested');
  const markers = [...db.rows.entries()].filter(([path]) => path.startsWith('referralVestings/'));
  assert.equal(markers.length, 1);
  assert.equal(markers[0][1].refundAbusePolicy, 'hold_until_refund_window_closes_v1');
  assert.equal([...db.rows.keys()].filter(path => path.includes('referral_vested_')).length, 1);
  assert.equal([...db.rows.keys()].filter(path => path.includes('referral_from_')).length, 1);
});

test('환불 가능 기간 안에 qualifying purchase가 환불되면 양쪽 보상은 지급되지 않는다', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 12);
  const db = new FakeFirestore({
    'users/invitee05': {
      credits: 105,
      referral: { status: 'pending', referrerUid: 'referrer05', rewardCredits: 20 }
    },
    'users/referrer05': { credits: 10 },
    'orders/refunded-order': {
      uid: 'invitee05', status: 'paid',
      refundWindowEndsAt: { toMillis: () => nowMs + 1000 }
    }
  });
  const admin = fakeAdmin();
  await vestPendingReferral({
    admin, db, inviteeUid: 'invitee05', orderCollection: 'orders', orderId: 'refunded-order', env: ENV
  });
  db.rows.get('orders/refunded-order').status = 'refunded';
  const summary = await releaseMaturedReferralRewards({ admin, db, nowMs: nowMs + 2000 });
  assert.equal(summary.cancelled, 1);
  assert.equal(db.rows.get('users/invitee05').credits, 105);
  assert.equal(db.rows.get('users/referrer05').credits, 10);
  assert.equal(db.rows.get('users/invitee05').referral.status, 'cancelled');
});

test('미결제·다른 사용자 주문에는 추천 보상을 지급하지 않는다', async () => {
  const db = new FakeFirestore({
    'users/invitee04': {
      credits: 10,
      referral: { status: 'pending', referrerUid: 'referrer04', rewardCredits: 20 }
    },
    'users/referrer04': { credits: 10 },
    'orders/not-paid': { uid: 'another-user', status: 'paid' }
  });
  const result = await vestPendingReferral({
    admin: fakeAdmin(),
    db,
    inviteeUid: 'invitee04',
    orderCollection: 'orders',
    orderId: 'not-paid',
    env: ENV
  });
  assert.deepEqual(result, { vested: false, reason: 'order_not_settled' });
  assert.equal(db.rows.get('users/invitee04').credits, 10);
  assert.equal(db.rows.get('users/referrer04').credits, 10);
});
