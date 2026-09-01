'use strict';

// Shared authentication and billing service. Routes depend on this module rather
// than importing one another, so detect and transform keep independent runtimes.
const crypto = require('crypto');
const { admin, db } = require('../config');
const { logger } = require('./logger');
const { accountDeletionBlocksWrites, deletionInProgressError } = require('./accountActivityClaims');
const {
  CREDIT_LOT_POLICY_VERSION,
  allocateCreditDeduction,
  allocateCreditRestore,
  creditHistoryDocumentId
} = require('./creditLotAccounting');
const {
  SIGNUP_CREDIT_EVENT_COLLECTION,
  allocateSignupCreditRestore,
  allocateSignupCreditSpend,
  buildSignupCreditEvent,
  signupCreditAccountKey,
  signupCreditEventId
} = require('./signupCreditMonitoring');

const SUB_CHAR_LIMITS = Object.freeze({
  '1000': 1000,
  '5000': 5000,
  '10000': 10000,
  unlimited: -1
});

const CREDIT_REQUEST_FINGERPRINT_VERSION = 'credit-request-v1';
const CREDIT_REQUEST_FINGERPRINT_RE = /^[a-f0-9]{64}$/u;

function creditRequestPayloadFingerprint({ opType, needed, text }) {
  const operation = String(opType || '');
  const safeNeeded = Math.max(0, Math.floor(Number(needed) || 0));
  const source = String(text || '');
  return crypto.createHash('sha256')
    .update(CREDIT_REQUEST_FINGERPRINT_VERSION, 'utf8')
    .update('\0', 'utf8')
    .update(operation, 'utf8')
    .update('\0', 'utf8')
    .update(String(safeNeeded), 'utf8')
    .update('\0', 'utf8')
    .update(source, 'utf8')
    .digest('hex');
}

function idempotencyKeyReusedError() {
  return Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), {
    code: 'IDEMPOTENCY_KEY_REUSED',
    status: 409
  });
}

function assertCreditRequestBinding(row, { opType, needed, requestPayloadFingerprint }) {
  const fingerprint = String(requestPayloadFingerprint || '');
  if (!CREDIT_REQUEST_FINGERPRINT_RE.test(fingerprint)
    || row?.requestPayloadFingerprintVersion !== CREDIT_REQUEST_FINGERPRINT_VERSION
    || row?.requestPayloadFingerprint !== fingerprint
    || String(row?.type || '') !== String(opType || '')
    || Math.max(0, Math.floor(Number(row?.used) || 0)) !== Math.max(0, Math.floor(Number(needed) || 0))) {
    throw idempotencyKeyReusedError();
  }
}

async function precheckCreditDeductIdempotency(uid, needed, opType, requestId, requestPayloadFingerprint) {
  if (!requestId) throw idempotencyKeyReusedError();
  const userRef = db.collection('users').doc(uid);
  const historyRef = userRef.collection('creditHistory')
    .doc(creditHistoryDocumentId('deduct', requestId));
  const [snapshot, userSnapshot] = await Promise.all([historyRef.get(), userRef.get()]);
  const remainingCredits = userSnapshot.exists
    ? Math.max(0, Math.floor(Number(userSnapshot.data()?.credits) || 0))
    : null;
  if (!snapshot.exists) return { state: 'NEW', remainingCredits };
  const row = snapshot.data() || {};
  assertCreditRequestBinding(row, {
    opType,
    needed,
    requestPayloadFingerprint
  });
  return {
    state: 'DUPLICATE',
    remainingCredits,
    chargedCredits: Math.max(0, Math.floor(Number(row.used) || 0))
  };
}

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

async function getCreditAccountState(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const data = snap.data() || {};
  return {
    uid,
    plan: data.plan || 'free',
    credits: Math.max(0, Math.floor(Number(data.credits) || 0))
  };
}

function activeCreditLotsQuery(userRef) {
  // Only v1 lots live in this subcollection, so legacy root orders cannot crowd new
  // lots out of the bounded query. createdAt/orderId FIFO sorting stays in memory.
  return userRef.collection('creditLots')
    .where('active', '==', true);
}

function trackedCreditLots(snapshot) {
  return (snapshot?.docs || []).map(doc => ({
    ...(doc.data() || {}),
    id: doc.id,
    ref: doc.ref
  }));
}

function creditLotConsistencyError() {
  logger.error('credit_lot.inconsistent', { action: 'block_mutation_and_reconcile' });
  return Object.assign(new Error('CREDIT_LOT_INCONSISTENT'), { status: 503 });
}

function assertTrackedLotBalance(trackedBalance, lots) {
  const represented = lots.reduce((sum, lot) => sum
    + Math.max(0, Math.floor(Number(lot.refundPaidCreditsRemaining) || 0))
    + Math.max(0, Math.floor(Number(lot.refundEventBonusCreditsRemaining) || 0)), 0);
  if (represented !== Math.max(0, Math.floor(Number(trackedBalance) || 0))) {
    throw creditLotConsistencyError();
  }
}

async function commitCreditDeduct(uid, needed, opType, requestId, meta = {}) {
  const userRef = db.collection('users').doc(uid);
  const historyRef = requestId
    ? userRef.collection('creditHistory').doc(creditHistoryDocumentId('deduct', requestId))
    : userRef.collection('creditHistory').doc();
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  const eventAtMs = Date.now();
  const accountKey = signupCreditAccountKey(uid);
  const spendEventRef = db.collection(SIGNUP_CREDIT_EVENT_COLLECTION)
    .doc(signupCreditEventId('spend', accountKey, historyRef.id));
  return db.runTransaction(async transaction => {
    const [user, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(deletionRef),
    ]);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    if (deletionSnapshot.exists
      && accountDeletionBlocksWrites(deletionSnapshot.data() || {})) {
      throw deletionInProgressError();
    }
    const duplicateSnapshot = requestId ? await transaction.get(historyRef) : null;
    const duplicate = duplicateSnapshot?.exists === true;
    const data = user.data();
    const safeNeeded = Math.max(0, Math.floor(Number(needed) || 0));
    const requestPayloadFingerprint = String(meta.requestPayloadFingerprint || '');
    const hasBoundFingerprint = CREDIT_REQUEST_FINGERPRINT_RE.test(requestPayloadFingerprint);
    if (duplicate) {
      if (hasBoundFingerprint) {
        assertCreditRequestBinding(duplicateSnapshot.data() || {}, {
          opType,
          needed: safeNeeded,
          requestPayloadFingerprint
        });
        const current = Math.max(0, Math.floor(Number(data.credits) || 0));
        return { duplicate: true, current, next: current };
      }
      return;
    }
    if ((data.plan || 'free') === 'unlimited' && meta.respectUnlimited !== false) return;
    const credits = data.credits || 0;
    if (credits < safeNeeded) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
    const trackedBalance = Math.max(0, Math.floor(Number(data.creditLotV1Balance) || 0));
    if (trackedBalance > credits) throw creditLotConsistencyError();
    const untrackedAvailable = Math.max(0, credits - Math.min(credits, trackedBalance));
    const needsTrackedLots = trackedBalance > 0 && safeNeeded > untrackedAvailable;
    const lotSnapshot = needsTrackedLots
      ? await transaction.get(activeCreditLotsQuery(userRef))
      : null;
    const lots = trackedCreditLots(lotSnapshot);
    if (needsTrackedLots) assertTrackedLotBalance(trackedBalance, lots);
    const allocation = allocateCreditDeduction({
      amount: safeNeeded,
      globalBalance: credits,
      trackedBalance,
      lots
    });
    if (!allocation.complete) throw creditLotConsistencyError();
    const signupSpend = allocateSignupCreditSpend({
      userData: data,
      untrackedCredits: allocation.untrackedCredits,
      untrackedAvailable,
      nowMs: eventAtMs
    });

    const remaining = credits - safeNeeded;
    const userUpdate = { credits: remaining };
    if (allocation.trackedCredits > 0) {
      userUpdate.creditLotV1Balance = allocation.newTrackedBalance;
    }
    if (signupSpend.metadata) userUpdate.signupCreditGrant = signupSpend.metadata;
    const updatedAt = admin.firestore.FieldValue.serverTimestamp();
    transaction.update(userRef, userUpdate);
    for (const lot of allocation.lotUpdates) {
      if (!lot.ref) throw creditLotConsistencyError();
      transaction.update(lot.ref, {
        refundPaidCreditsRemaining: lot.paidRemaining,
        refundEventBonusCreditsRemaining: lot.bonusRemaining,
        active: lot.active,
        creditLotUpdatedAt: updatedAt
      });
      transaction.update(db.collection('orders').doc(lot.orderId), {
        refundPaidCreditsRemaining: lot.paidRemaining,
        refundEventBonusCreditsRemaining: lot.bonusRemaining,
        creditLotActive: lot.active,
        creditLotUpdatedAt: updatedAt
      });
    }
    transaction.set(historyRef, {
      type: opType,
      used: safeNeeded,
      amount: 0,
      remaining,
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      creditLotUntrackedUsed: allocation.untrackedCredits,
      creditLotTrackedUsed: allocation.trackedCredits,
      creditLotAllocations: allocation.allocations,
      ...(signupSpend.credits > 0 ? { signupGrantCreditsUsed: signupSpend.credits } : {}),
      ...(meta.mode ? { mode: String(meta.mode) } : {}),
      ...(meta.evidence != null ? { evidence: !!meta.evidence } : {}),
      ...(meta.textLength ? { textLength: Number(meta.textLength) || 0 } : {}),
      ...(meta.fallback ? { fallback: true } : {}),
      ...(meta.detail ? { detail: String(meta.detail).slice(0, 500) } : {}),
      ...(meta.adminUid ? { adminUid: String(meta.adminUid) } : {}),
      ...(hasBoundFingerprint ? {
        requestPayloadFingerprintVersion: CREDIT_REQUEST_FINGERPRINT_VERSION,
        requestPayloadFingerprint
      } : {}),
      ...(requestId ? { requestId } : {}),
      createdAt: updatedAt
    });
    if (signupSpend.credits > 0) {
      transaction.set(spendEventRef, buildSignupCreditEvent({
        eventType: 'spend',
        accountKey,
        creditAmount: signupSpend.credits,
        signupCreditsRemaining: signupSpend.metadata.remainingCredits,
        accountCreditsRemaining: remaining,
        op: opType,
        mode: meta.mode,
        occurredAtMs: eventAtMs,
        occurredAt: updatedAt
      }));
    }
    return {
      current: credits,
      next: remaining,
      allocation,
      signupGrantCreditsUsed: signupSpend.credits
    };
  });
}

async function commitCreditRestoreInternal({
  uid,
  amount,
  opType,
  requestId = null,
  deductHistoryId = null,
  restoreHistoryId = null,
  meta = {}
}) {
  const userRef = db.collection('users').doc(uid);
  const deductRef = deductHistoryId
    ? userRef.collection('creditHistory').doc(String(deductHistoryId))
    : (requestId
      ? userRef.collection('creditHistory').doc(creditHistoryDocumentId('deduct', requestId))
      : null);
  const restoreRef = restoreHistoryId
    ? userRef.collection('creditHistory').doc(String(restoreHistoryId))
    : (requestId
      ? userRef.collection('creditHistory').doc(creditHistoryDocumentId('restore', requestId))
      : userRef.collection('creditHistory').doc());
  const eventAtMs = Date.now();
  const accountKey = signupCreditAccountKey(uid);
  const restoreEventRef = db.collection(SIGNUP_CREDIT_EVENT_COLLECTION)
    .doc(signupCreditEventId('restore', accountKey, restoreRef.id));
  return db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    let deductHistory = null;
    if (deductRef) {
      const restoreSnapshot = await transaction.get(restoreRef);
      if (restoreSnapshot.exists) {
        const current = Math.max(0, Math.floor(Number(user.data()?.credits) || 0));
        return { alreadyHandled: true, current, next: current, restoredCredits: 0, restoreHistoryId: restoreRef.id };
      }
      const deductSnapshot = await transaction.get(deductRef);
      if (!deductSnapshot.exists) throw Object.assign(new Error('CREDIT_HISTORY_NOT_FOUND'), { status: 404 });
      deductHistory = deductSnapshot.data() || {};
      if (meta.requireUnresolved && (
        deductHistory.orphanDebitResolved === true
        || !!deductHistory.restoredAt
        || !!deductHistory.resolvedAt
        || !!deductHistory.restoreCreditHistoryId
        || !!deductHistory.resolveCreditHistoryId
      )) {
        const current = Math.max(0, Math.floor(Number(user.data()?.credits) || 0));
        return {
          alreadyHandled: true,
          current,
          next: current,
          restoredCredits: Math.max(0, Math.floor(Number(deductHistory.restoredCredits) || 0)),
          restoreHistoryId: deductHistory.restoreCreditHistoryId || deductHistory.resolveCreditHistoryId || null
        };
      }
    }
    const data = user.data();
    if ((data.plan || 'free') === 'unlimited' && meta.respectUnlimited !== false) return;
    const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
    const currentCredits = Math.max(0, Math.floor(Number(data.credits) || 0));
    const currentTrackedBalance = Math.max(0, Math.floor(Number(data.creditLotV1Balance) || 0));
    if (currentTrackedBalance > currentCredits) throw creditLotConsistencyError();
    const historicalAllocations = Array.isArray(deductHistory?.creditLotAllocations)
      ? deductHistory.creditLotAllocations
      : [];
    const historicalUntracked = deductHistory
      ? Math.max(0, Math.floor(Number(
        deductHistory.creditLotUntrackedUsed ?? (historicalAllocations.length ? 0 : deductHistory.used)
      ) || 0))
      : safeAmount;
    const needsTrackedLots = historicalAllocations.length > 0 && safeAmount > historicalUntracked;
    // A deduction can drain a lot and mark it inactive. Restore therefore reads the
    // exact lot documents from the stored allocation instead of the active query.
    const restoreLotRefs = needsTrackedLots
      ? [...new Set(historicalAllocations.map(row => String(row?.orderId || '')).filter(Boolean))]
        .map(orderId => userRef.collection('creditLots').doc(orderId))
      : [];
    const restoreLotSnapshots = restoreLotRefs.length > 0
      ? await transaction.getAll(...restoreLotRefs)
      : [];
    const allocation = allocateCreditRestore({
      amount: safeAmount,
      untrackedCredits: historicalUntracked,
      allocations: historicalAllocations,
      trackedBalance: currentTrackedBalance,
      lots: trackedCreditLots({ docs: restoreLotSnapshots })
    });
    if (!allocation.complete) throw creditLotConsistencyError();
    const signupRestore = allocateSignupCreditRestore({
      userData: data,
      untrackedCredits: allocation.untrackedCredits,
      deductHistory,
      nowMs: eventAtMs
    });

    const remaining = currentCredits + safeAmount;
    const userUpdate = { credits: remaining };
    if (allocation.trackedCredits > 0) {
      userUpdate.creditLotV1Balance = allocation.newTrackedBalance;
    }
    if (signupRestore.metadata) userUpdate.signupCreditGrant = signupRestore.metadata;
    const updatedAt = admin.firestore.FieldValue.serverTimestamp();
    if (meta.orphanDebitResolved) userUpdate.lastAdminOrphanDebitResolvedAt = updatedAt;
    transaction.update(userRef, userUpdate);
    for (const lot of allocation.lotUpdates) {
      if (!lot.ref) throw creditLotConsistencyError();
      transaction.update(lot.ref, {
        refundPaidCreditsRemaining: lot.paidRemaining,
        refundEventBonusCreditsRemaining: lot.bonusRemaining,
        active: lot.active,
        creditLotUpdatedAt: updatedAt
      });
      transaction.update(db.collection('orders').doc(lot.orderId), {
        refundPaidCreditsRemaining: lot.paidRemaining,
        refundEventBonusCreditsRemaining: lot.bonusRemaining,
        creditLotActive: lot.active,
        creditLotUpdatedAt: updatedAt
      });
    }
    transaction.set(restoreRef, {
      type: `${opType}_restore`,
      used: -safeAmount,
      amount: 0,
      remaining,
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      creditLotUntrackedRestored: allocation.untrackedCredits,
      creditLotTrackedRestored: allocation.trackedCredits,
      creditLotAllocations: allocation.allocations,
      ...(signupRestore.credits > 0 ? { signupGrantCreditsRestored: signupRestore.credits } : {}),
      ...(requestId ? { requestId } : {}),
      ...(meta.mode ? { mode: String(meta.mode) } : {}),
      ...(meta.evidence != null ? { evidence: !!meta.evidence } : {}),
      ...(meta.fallback ? { fallback: true } : {}),
      ...(meta.detail ? { detail: String(meta.detail).slice(0, 500) } : {}),
      ...(meta.adminUid ? { adminUid: String(meta.adminUid) } : {}),
      ...(deductRef ? { originalCreditHistoryId: deductRef.id, restoredDebitId: deductRef.id } : {}),
      ...(meta.orphanDebitResolved ? {
        orphanDebitResolved: true,
        orphanDebitResolution: 'credit_restore'
      } : {}),
      createdAt: updatedAt
    });
    const deductHistoryUpdate = {
      ...(signupRestore.credits > 0 ? {
        signupGrantCreditsRestored: signupRestore.totalRestoredForDeduct,
        signupGrantRestoredAt: updatedAt
      } : {}),
      ...(meta.orphanDebitResolved ? {
        orphanDebitResolved: true,
        orphanDebitResolution: 'credit_restore',
        restoredCredits: safeAmount,
        restoreCreditHistoryId: restoreRef.id,
        restoredAt: updatedAt,
        ...(meta.adminUid ? { restoredBy: String(meta.adminUid) } : {}),
        ...(meta.detail ? { restoreReason: String(meta.detail).slice(0, 500) } : {})
      } : {})
    };
    if (deductRef && Object.keys(deductHistoryUpdate).length > 0) {
      transaction.update(deductRef, deductHistoryUpdate);
    }
    if (signupRestore.credits > 0) {
      transaction.set(restoreEventRef, buildSignupCreditEvent({
        eventType: 'restore',
        accountKey,
        creditAmount: signupRestore.credits,
        signupCreditsRemaining: signupRestore.metadata.remainingCredits,
        accountCreditsRemaining: remaining,
        op: opType,
        mode: meta.mode || deductHistory?.mode,
        occurredAtMs: eventAtMs,
        occurredAt: updatedAt
      }));
    }
    return {
      alreadyHandled: false,
      current: Math.max(0, Math.floor(Number(data.credits) || 0)),
      next: remaining,
      restoredCredits: safeAmount,
      restoreHistoryId: restoreRef.id,
      allocation,
      signupGrantCreditsRestored: signupRestore.credits
    };
  });
}

async function commitCreditRestore(uid, amount, opType, requestId) {
  return commitCreditRestoreInternal({ uid, amount, opType, requestId });
}

async function commitCreditRestoreFromHistory(uid, amount, opType, deductHistoryId, restoreHistoryId, meta = {}) {
  return commitCreditRestoreInternal({
    uid,
    amount,
    opType,
    deductHistoryId,
    restoreHistoryId,
    meta
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
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  await db.runTransaction(async transaction => {
    const [user, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(deletionRef),
    ]);
    if (!user.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    if (deletionSnapshot.exists
      && accountDeletionBlocksWrites(deletionSnapshot.data() || {})) {
      throw deletionInProgressError();
    }
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
    CREDIT_LOT_INCONSISTENT: '크레딧 정산 상태를 확인하는 중이에요. 잠시 후 다시 시도해주세요.',
    NO_SUBSCRIPTION: 'Pro 구독이 필요합니다.',
    SUBSCRIPTION_INACTIVE: '구독이 만료되었거나 활성 상태가 아닙니다.',
    NO_COUPON: '이번 사이클의 쿠폰을 모두 사용했습니다. 다음 결제일에 갱신됩니다.',
    COUPON_LIMIT_EXCEEDED: '현재 구독 티어의 글자 수 한도를 초과했습니다.',
    INVALID_TIER: '구독 정보가 올바르지 않습니다. 관리자에 문의해주세요.'
  })[code] || '인증/결제 확인에 실패했습니다.';
}

module.exports = {
  SUB_CHAR_LIMITS,
  CREDIT_REQUEST_FINGERPRINT_VERSION,
  creditRequestPayloadFingerprint,
  precheckCreditDeductIdempotency,
  authenticate,
  precheckCredits,
  getCreditAccountState,
  commitCreditDeduct,
  commitCreditRestore,
  commitCreditRestoreFromHistory,
  precheckCoupon,
  commitCouponUsage,
  commitCouponRestore,
  retryAsync,
  authErrorMessage
};
