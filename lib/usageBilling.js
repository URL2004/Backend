'use strict';

// Shared authentication and billing service. Routes depend on this module rather
// than importing one another, so detect and transform keep independent runtimes.
const { admin, db } = require('../config');

const SUB_CHAR_LIMITS = Object.freeze({
  '1000': 1000,
  '5000': 5000,
  '10000': 10000,
  unlimited: -1
});

async function authenticate(idToken) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch {
    throw Object.assign(new Error('AUTH_INVALID'), { status: 401 });
  }
}

async function precheckCredits(idToken, needed, authenticated = null) {
  const decoded = authenticated?.uid ? authenticated : await authenticate(idToken);
  const uid = decoded.uid;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const data = snap.data();
  const plan = data.plan || 'free';
  if (plan === 'unlimited') return { uid, plan };
  if ((data.credits || 0) < needed) {
    throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
  }
  return { uid, plan };
}

async function commitCreditDeduct(uid, needed, opType, requestId, meta = {}) {
  const userRef = db.collection('users').doc(uid);
  const historyRef = requestId
    ? userRef.collection('creditHistory').doc(`req_${requestId}`)
    : userRef.collection('creditHistory').doc();
  await db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const duplicate = requestId ? (await transaction.get(historyRef)).exists : false;
    const data = user.data();
    if ((data.plan || 'free') === 'unlimited' || duplicate) return;
    const credits = data.credits || 0;
    if (credits < needed) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
    const remaining = credits - needed;
    transaction.update(userRef, { credits: remaining });
    transaction.set(historyRef, {
      type: opType,
      used: needed,
      amount: 0,
      remaining,
      ...(meta.mode ? { mode: String(meta.mode) } : {}),
      ...(meta.evidence != null ? { evidence: !!meta.evidence } : {}),
      ...(meta.textLength ? { textLength: Number(meta.textLength) || 0 } : {}),
      ...(meta.fallback ? { fallback: true } : {}),
      ...(requestId ? { requestId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function commitCreditRestore(uid, amount, opType, requestId) {
  const userRef = db.collection('users').doc(uid);
  const deductRef = requestId ? userRef.collection('creditHistory').doc(`req_${requestId}`) : null;
  const restoreRef = requestId
    ? userRef.collection('creditHistory').doc(`restore_req_${requestId}`)
    : userRef.collection('creditHistory').doc();
  await db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    if (requestId) {
      if ((await transaction.get(restoreRef)).exists) return;
      if (!(await transaction.get(deductRef)).exists) return;
    }
    const data = user.data();
    if ((data.plan || 'free') === 'unlimited') return;
    const remaining = (data.credits || 0) + amount;
    transaction.update(userRef, { credits: remaining });
    transaction.set(restoreRef, {
      type: `${opType}_restore`,
      used: -amount,
      amount: 0,
      remaining,
      ...(requestId ? { requestId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function precheckCoupon(idToken, textLength, authenticated = null) {
  const decoded = authenticated?.uid ? authenticated : await authenticate(idToken);
  const uid = decoded.uid;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const data = snap.data();
  const subscription = data.subscription;
  if (!subscription) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });
  const nextBillingAt = subscription.nextBillingAt?.toMillis ? subscription.nextBillingAt.toMillis() : 0;
  const active = subscription.status === 'active'
    || (subscription.status === 'cancelled' && nextBillingAt > Date.now());
  if (!active) throw Object.assign(new Error('SUBSCRIPTION_INACTIVE'), { status: 403 });
  const tier = subscription.tier;
  const charLimit = SUB_CHAR_LIMITS[tier];
  if (charLimit === undefined) throw Object.assign(new Error('INVALID_TIER'), { status: 500 });
  if (charLimit !== -1 && textLength > charLimit) {
    throw Object.assign(new Error('COUPON_LIMIT_EXCEEDED'), { status: 400, charLimit });
  }
  if (tier !== 'unlimited' && (data.coupon?.remaining ?? 0) <= 0) {
    throw Object.assign(new Error('NO_COUPON'), { status: 402 });
  }
  return { uid, billingMode: 'coupon', tier };
}

async function commitCouponUsage(uid, tier, opType, textLength, requestId) {
  const userRef = db.collection('users').doc(uid);
  const historyRef = requestId
    ? userRef.collection('couponHistory').doc(`req_${requestId}`)
    : userRef.collection('couponHistory').doc();
  await db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const duplicate = requestId ? (await transaction.get(historyRef)).exists : false;
    if (duplicate) return;
    const data = user.data();
    if (!data.subscription) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });
    if (tier === 'unlimited') {
      transaction.update(userRef, { 'coupon.used': admin.firestore.FieldValue.increment(1) });
      transaction.set(historyRef, couponHistory('use', tier, 0, -1, opType, textLength, requestId));
      return;
    }
    const current = data.coupon?.remaining ?? 0;
    if (current <= 0) throw Object.assign(new Error('NO_COUPON'), { status: 402 });
    const remaining = current - 1;
    transaction.update(userRef, {
      'coupon.remaining': remaining,
      'coupon.used': admin.firestore.FieldValue.increment(1)
    });
    transaction.set(historyRef, couponHistory('use', tier, -1, remaining, opType, textLength, requestId));
  });
}

async function commitCouponRestore(uid, tier, opType, textLength, requestId) {
  const userRef = db.collection('users').doc(uid);
  const deductRef = requestId ? userRef.collection('couponHistory').doc(`req_${requestId}`) : null;
  const restoreRef = requestId
    ? userRef.collection('couponHistory').doc(`restore_req_${requestId}`)
    : userRef.collection('couponHistory').doc();
  await db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    if (requestId) {
      if ((await transaction.get(restoreRef)).exists) return;
      if (!(await transaction.get(deductRef)).exists) return;
    }
    if (tier === 'unlimited') {
      transaction.update(userRef, { 'coupon.used': admin.firestore.FieldValue.increment(-1) });
      transaction.set(restoreRef, couponHistory('restore', tier, 0, -1, opType, textLength, requestId));
      return;
    }
    const remaining = (user.data().coupon?.remaining ?? 0) + 1;
    transaction.update(userRef, {
      'coupon.remaining': remaining,
      'coupon.used': admin.firestore.FieldValue.increment(-1)
    });
    transaction.set(restoreRef, couponHistory('restore', tier, 1, remaining, opType, textLength, requestId));
  });
}

function couponHistory(type, tier, amount, remaining, mode, textLength, requestId) {
  return {
    type,
    tier,
    amount,
    remaining,
    mode,
    textLength,
    ...(requestId ? { requestId } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

async function retryAsync(fn, attempts = 3, baseDelayMs = 300) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error?.status === 404) throw error;
      if (attempt < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, baseDelayMs * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

function authErrorMessage(code) {
  return ({
    AUTH_REQUIRED: '로그인이 필요합니다.',
    AUTH_INVALID: '로그인 정보가 만료됐어요. 다시 로그인해주세요.',
    USER_NOT_FOUND: '사용자 정보를 찾을 수 없습니다.',
    INSUFFICIENT_CREDITS: '크레딧이 부족합니다.',
    NO_SUBSCRIPTION: 'Pro 구독이 필요합니다.',
    SUBSCRIPTION_INACTIVE: '구독이 만료되었거나 활성 상태가 아닙니다.',
    NO_COUPON: '이번 사이클의 쿠폰을 모두 사용했습니다. 다음 결제일에 갱신됩니다.',
    COUPON_LIMIT_EXCEEDED: '현재 구독 티어의 글자 수 한도를 초과했습니다.',
    INVALID_TIER: '구독 정보가 올바르지 않습니다. 관리자에 문의해주세요.'
  })[code] || '인증/결제 확인에 실패했습니다.';
}

module.exports = {
  SUB_CHAR_LIMITS,
  authenticate,
  precheckCredits,
  commitCreditDeduct,
  commitCreditRestore,
  precheckCoupon,
  commitCouponUsage,
  commitCouponRestore,
  retryAsync,
  authErrorMessage
};
