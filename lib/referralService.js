'use strict';

const crypto = require('crypto');

const DEFAULT_REWARD_CREDITS = 20;
const DEFAULT_APPLY_WINDOW_DAYS = 7;
const DEFAULT_DAILY_ATTEMPT_CAP = 10;
const REFERRAL_VERSION = 2;
const SETTLED_ORDER_COLLECTIONS = new Set(['orders', 'subscriptionOrders']);

function typedError(code, status = 400, extra = {}) {
  return Object.assign(new Error(code), { code, status, ...extra });
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (Number.isFinite(Number(value._seconds))) return Number(value._seconds) * 1000;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReferralCode(value) {
  const code = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{6,32}$/u.test(code)) throw typedError('REFERRAL_CODE_INVALID', 400);
  return code;
}

function referralRewardCredits(env = process.env) {
  const parsed = Number(env.REFERRAL_REWARD_CREDITS);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : DEFAULT_REWARD_CREDITS;
}

function referralApplyWindowMs(env = process.env) {
  const days = Number(env.REFERRAL_APPLY_WINDOW_DAYS);
  const boundedDays = Number.isFinite(days) ? Math.max(1, Math.min(30, days)) : DEFAULT_APPLY_WINDOW_DAYS;
  return boundedDays * 24 * 60 * 60 * 1000;
}

function referralAttemptCap(env = process.env) {
  const parsed = Number(env.REFERRAL_DAILY_ATTEMPT_CAP);
  return Number.isFinite(parsed) ? Math.max(3, Math.min(30, Math.floor(parsed))) : DEFAULT_DAILY_ATTEMPT_CAP;
}

function referralSecret(env = process.env) {
  return String(env.REFERRAL_VESTING_SECRET || env.OPENAI_SAFETY_SALT || env.ACCOUNT_DELETION_SECRET || '');
}

function referralSubjectHash(uid, secret = referralSecret()) {
  if (!uid || secret.length < 16) throw typedError('REFERRAL_SECRET_MISSING', 503);
  return crypto.createHmac('sha256', secret).update(`referral:v2:${uid}`).digest('hex');
}

function referralQuotaWindow(nowMs = Date.now()) {
  const date = new Date(Number(nowMs));
  const keyDate = date.toISOString().slice(0, 10).replace(/-/gu, '');
  const endMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return { key: `referral_apply_${keyDate}`, endMs };
}

async function consumeReferralAttemptQuota({ admin, db, uid, nowMs = Date.now(), cap = referralAttemptCap() }) {
  const window = referralQuotaWindow(nowMs);
  const ref = db.collection('users').doc(uid).collection('serverUsage').doc(window.key);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const count = snap.exists ? Math.max(0, Number(snap.data()?.count) || 0) : 0;
    if (count >= cap) {
      throw typedError('REFERRAL_RATE_LIMITED', 429, {
        retryAfterSeconds: Math.max(1, Math.ceil((window.endMs - nowMs) / 1000))
      });
    }
    transaction.set(ref, {
      kind: 'referral_apply',
      count: count + 1,
      expiresAt: admin.firestore.Timestamp.fromMillis(window.endMs + 24 * 60 * 60 * 1000),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: false });
    return { count: count + 1, cap };
  });
}

function userAlreadyPurchased(user) {
  const value = user && typeof user === 'object' ? user : {};
  return timestampMs(value.lastPayment) > 0
    || timestampMs(value.firstSettledPurchaseAt) > 0
    || timestampMs(value.subscription && value.subscription.startedAt) > 0;
}

function userWithinReferralWindow(user, nowMs, windowMs) {
  const createdAt = timestampMs(user && (user.createdAt || user.signupAt));
  return createdAt > 0 && createdAt <= nowMs + 5 * 60 * 1000 && nowMs - createdAt <= windowMs;
}

async function registerPendingReferral({ admin, db, uid, refCode, nowMs = Date.now(), env = process.env }) {
  if (!admin || !db || !uid) throw typedError('REFERRAL_UNAVAILABLE', 503);
  const code = normalizeReferralCode(refCode);
  // 신청만 성공하고 이후 vesting이 영구 실패하는 구성을 만들지 않는다.
  referralSubjectHash(uid, referralSecret(env));
  await consumeReferralAttemptQuota({ admin, db, uid, nowMs, cap: referralAttemptCap(env) });

  const matches = await db.collection('users').where('refCode', '==', code).limit(2).get();
  if (!matches || !Array.isArray(matches.docs) || matches.docs.length !== 1) {
    throw typedError(matches?.docs?.length > 1 ? 'REFERRAL_CODE_CONFLICT' : 'REFERRAL_CODE_INVALID', 400);
  }
  const referrerUid = matches.docs[0].id;
  if (referrerUid === uid) throw typedError('REFERRAL_SELF_NOT_ALLOWED', 400);

  const rewardCredits = referralRewardCredits(env);
  const windowMs = referralApplyWindowMs(env);
  const now = admin.firestore.Timestamp.fromMillis(nowMs);
  return db.runTransaction(async transaction => {
    const inviteeRef = db.collection('users').doc(uid);
    const referrerRef = db.collection('users').doc(referrerUid);
    const inviteeSnap = await transaction.get(inviteeRef);
    const referrerSnap = await transaction.get(referrerRef);
    if (!inviteeSnap.exists || !referrerSnap.exists) throw typedError('REFERRAL_USER_NOT_FOUND', 404);
    const invitee = inviteeSnap.data() || {};
    const referrer = referrerSnap.data() || {};
    if (String(invitee.refCode || '') === code || referrerUid === uid) {
      throw typedError('REFERRAL_SELF_NOT_ALLOWED', 400);
    }
    if (invitee.referredBy || invitee.referral) throw typedError('REFERRAL_ALREADY_APPLIED', 409);
    if (!userWithinReferralWindow(invitee, nowMs, windowMs)) throw typedError('REFERRAL_WINDOW_EXPIRED', 409);
    // lastPayment/firstSettledPurchaseAt is changed in the same user document as
    // payment fulfillment, so a concurrent purchase forces this transaction to retry.
    if (userAlreadyPurchased(invitee)) throw typedError('REFERRAL_PURCHASE_ALREADY_SETTLED', 409);
    if (referrer.accountDeletionStatus || referrer.deletedAt) throw typedError('REFERRAL_CODE_INVALID', 400);

    transaction.update(inviteeRef, {
      referredBy: code,
      referral: {
        version: REFERRAL_VERSION,
        status: 'pending',
        referrerUid,
        rewardCredits,
        appliedAt: now,
        vestingTrigger: 'first_settled_purchase',
        refundAbusePolicy: 'hold_until_refund_window_closes_v1'
      }
    });
    return {
      applied: true,
      pending: true,
      rewardCredits,
      referrerUid,
      referrerName: String(referrer.name || '').slice(0, 60),
      inviteeName: String(invitee.name || '').slice(0, 60)
    };
  });
}

function referralReleaseAtMs(order, nowMs = Date.now()) {
  const value = order && typeof order === 'object' ? order : {};
  const explicit = timestampMs(value.refundWindowEndsAt);
  if (explicit > 0) return explicit;
  const start = timestampMs(
    value.refundWindowStartsAt
    || value.serviceAvailableAt
    || value.providerApprovedAt
    || value.approvedAt
    || value.createdAt
    || value.requestedAt
  ) || Number(nowMs);
  const days = Math.max(1, Math.floor(Number(value.refundWindowDaysAtPurchase) || 7));
  return start + days * 24 * 60 * 60 * 1000;
}

function refundStillProcessing(order) {
  const value = order && typeof order === 'object' ? order : {};
  const phase = String(value.refundProcessing && value.refundProcessing.phase || '');
  return String(value.status || '') === 'refund_requested'
    || ['requested_reserved', 'provider_canceling'].includes(phase)
    || ['requested_reserved', 'provider_canceling'].includes(String(value.refundReservationState || ''));
}

async function vestPendingReferral({
  admin,
  db,
  inviteeUid,
  orderCollection,
  orderId,
  env = process.env
}) {
  if (!SETTLED_ORDER_COLLECTIONS.has(orderCollection)) throw typedError('REFERRAL_ORDER_KIND_INVALID', 400);
  const secret = referralSecret(env);
  const inviteeHash = referralSubjectHash(inviteeUid, secret);
  const markerRef = db.collection('referralVestings').doc(inviteeHash);
  return db.runTransaction(async transaction => {
    const orderRef = db.collection(orderCollection).doc(orderId);
    const inviteeRef = db.collection('users').doc(inviteeUid);
    const orderSnap = await transaction.get(orderRef);
    const inviteeSnap = await transaction.get(inviteeRef);
    const markerSnap = await transaction.get(markerRef);
    if (!orderSnap.exists || !inviteeSnap.exists) return { vested: false, reason: 'missing_order_or_user' };
    const order = orderSnap.data() || {};
    const invitee = inviteeSnap.data() || {};
    if (String(order.uid || '') !== inviteeUid || String(order.status || '') !== 'paid') {
      return { vested: false, reason: 'order_not_settled' };
    }
    const referral = invitee.referral && typeof invitee.referral === 'object' ? invitee.referral : null;
    if (!referral || referral.status !== 'pending' || !referral.referrerUid) {
      return { vested: false, reason: 'no_pending_referral' };
    }
    if (markerSnap.exists || ['locked', 'vested', 'cancelled'].includes(referral.status)) {
      return { vested: false, reason: 'already_recorded' };
    }
    const referrerUid = String(referral.referrerUid);
    if (referrerUid === inviteeUid) throw typedError('REFERRAL_SELF_NOT_ALLOWED', 409);
    const rewardCredits = Math.max(1, Math.min(100, Math.floor(Number(referral.rewardCredits) || referralRewardCredits(env))));
    const now = admin.firestore.FieldValue.serverTimestamp();
    const releaseAtMs = referralReleaseAtMs(order);
    const releaseAt = admin.firestore.Timestamp.fromMillis(releaseAtMs);

    transaction.update(inviteeRef, {
      'referral.status': 'locked',
      'referral.lockedAt': now,
      'referral.releaseAt': releaseAt,
      'referral.qualifyingOrderId': orderId,
      firstSettledPurchaseAt: now
    });
    transaction.set(markerRef, {
      version: REFERRAL_VERSION,
      inviteeHash,
      inviteeUid,
      referrerUid,
      referrerHash: referralSubjectHash(referrerUid, secret),
      rewardCredits,
      orderCollection,
      orderId,
      status: 'locked',
      releaseAt,
      refundAbusePolicy: 'hold_until_refund_window_closes_v1',
      createdAt: now
    });
    return { vested: false, locked: true, rewardCredits, releaseAtMs };
  });
}

async function releaseOneReferralReward({ admin, db, markerRef, nowMs = Date.now() }) {
  return db.runTransaction(async transaction => {
    const markerSnap = await transaction.get(markerRef);
    if (!markerSnap.exists) return { released: false, reason: 'marker_missing' };
    const marker = markerSnap.data() || {};
    if (marker.status !== 'locked') return { released: false, reason: 'not_locked' };
    const releaseAtMs = timestampMs(marker.releaseAt);
    if (!releaseAtMs || releaseAtMs > nowMs) return { released: false, reason: 'not_matured' };
    if (!SETTLED_ORDER_COLLECTIONS.has(marker.orderCollection)) {
      throw typedError('REFERRAL_ORDER_KIND_INVALID', 409);
    }

    const orderRef = db.collection(marker.orderCollection).doc(marker.orderId);
    const inviteeRef = db.collection('users').doc(marker.inviteeUid);
    const referrerRef = db.collection('users').doc(marker.referrerUid);
    const orderSnap = await transaction.get(orderRef);
    const inviteeSnap = await transaction.get(inviteeRef);
    const referrerSnap = await transaction.get(referrerRef);
    if (!orderSnap.exists || !inviteeSnap.exists || !referrerSnap.exists) {
      transaction.set(markerRef, {
        status: 'cancelled',
        cancelReason: 'account_or_order_missing',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { released: false, reason: 'account_or_order_missing', cancelled: true };
    }

    const order = orderSnap.data() || {};
    const invitee = inviteeSnap.data() || {};
    const referrer = referrerSnap.data() || {};
    if (String(order.uid || '') !== String(marker.inviteeUid || '')) {
      throw typedError('REFERRAL_ORDER_OWNER_MISMATCH', 409);
    }
    if (refundStillProcessing(order)) return { released: false, reason: 'refund_processing' };
    if (['refunded', 'partially_refunded'].includes(String(order.status || ''))) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      transaction.set(markerRef, {
        status: 'cancelled',
        cancelReason: 'qualifying_purchase_refunded',
        cancelledAt: now
      }, { merge: true });
      transaction.update(inviteeRef, {
        'referral.status': 'cancelled',
        'referral.cancelReason': 'qualifying_purchase_refunded',
        'referral.cancelledAt': now
      });
      return { released: false, reason: 'qualifying_purchase_refunded', cancelled: true };
    }
    if (!['paid', 'refund_rejected'].includes(String(order.status || ''))) {
      return { released: false, reason: 'order_not_releasable' };
    }

    const rewardCredits = Math.max(1, Math.min(100, Math.floor(Number(marker.rewardCredits) || DEFAULT_REWARD_CREDITS)));
    const inviteeBalance = Math.max(0, Number(invitee.credits) || 0) + rewardCredits;
    const referrerBalance = Math.max(0, Number(referrer.credits) || 0) + rewardCredits;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const ledgerSuffix = String(marker.inviteeHash || markerRef.id).slice(0, 32);
    transaction.update(inviteeRef, {
      credits: admin.firestore.FieldValue.increment(rewardCredits),
      'referral.status': 'vested',
      'referral.vestedAt': now,
      'referral.vestedOrderId': marker.orderId
    });
    transaction.update(referrerRef, { credits: admin.firestore.FieldValue.increment(rewardCredits) });
    transaction.set(inviteeRef.collection('creditHistory').doc(`referral_vested_${ledgerSuffix}`), {
      type: 'referral', used: 0, amount: rewardCredits, remaining: inviteeBalance,
      detail: '친구 추천 보상 (첫 결제 환불 가능 기간 종료)', orderId: marker.orderId, createdAt: now
    });
    transaction.set(referrerRef.collection('creditHistory').doc(`referral_from_${ledgerSuffix}`), {
      type: 'referral', used: 0, amount: rewardCredits, remaining: referrerBalance,
      detail: '친구 추천 보상 (초대 사용자 첫 결제 환불 가능 기간 종료)', orderId: marker.orderId, createdAt: now
    });
    transaction.set(markerRef, {
      status: 'vested',
      vestedAt: now
    }, { merge: true });
    return { released: true, rewardCredits };
  });
}

async function releaseMaturedReferralRewards({ admin, db, nowMs = Date.now(), limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const snapshot = await db.collection('referralVestings').where('status', '==', 'locked').limit(safeLimit).get();
  const summary = { scanned: 0, released: 0, cancelled: 0, deferred: 0, failed: 0 };
  for (const doc of snapshot.docs || []) {
    summary.scanned += 1;
    try {
      const result = await releaseOneReferralReward({ admin, db, markerRef: doc.ref, nowMs });
      if (result.released) summary.released += 1;
      else if (result.cancelled) summary.cancelled += 1;
      else summary.deferred += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

module.exports = {
  DEFAULT_REWARD_CREDITS,
  DEFAULT_APPLY_WINDOW_DAYS,
  DEFAULT_DAILY_ATTEMPT_CAP,
  REFERRAL_VERSION,
  SETTLED_ORDER_COLLECTIONS,
  typedError,
  timestampMs,
  normalizeReferralCode,
  referralRewardCredits,
  referralApplyWindowMs,
  referralAttemptCap,
  referralSecret,
  referralSubjectHash,
  referralQuotaWindow,
  consumeReferralAttemptQuota,
  userAlreadyPurchased,
  userWithinReferralWindow,
  registerPendingReferral,
  referralReleaseAtMs,
  refundStillProcessing,
  vestPendingReferral,
  releaseOneReferralReward,
  releaseMaturedReferralRewards
};
