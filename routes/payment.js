// [결제] 토스페이먼츠 결제 확인 + Firebase 크레딧 지급 처리

const express = require('express');
const crypto = require('crypto');
const { admin, db, verifyToken, verifyAdminToken, verifyFirebaseIdToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const metaConversions = require('../lib/metaConversions');
const { outboundFetch } = require('../lib/outboundPolicy');
const { realClientIp } = require('../lib/clientip');
const { bearerToken } = require('../lib/reqtoken');
const { authLogFields, verifyCronRequest } = require('../lib/cronAuth');
const { getRevenue } = require('../lib/revenue');
const detectCalibration = require('../lib/detectCalibration');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { buildHumanizeQualityReport } = require('../lib/humanizeQualityReport');
const {
  STARTER_UPGRADE,
  buildCheckoutContext,
  buildStarterUpgradeGrant,
  getCreditProduct,
  isRetainedPaidOrder,
  starterUpgradeEnabled
} = require('../lib/conversionOffers');
const {
  approvedPaymentValidation,
  cancellationLedgerId,
  confirmIdempotencyKey,
  creditLedgerDelta,
  paymentKeyHash,
  providerCanceledAmount,
  providerResultSummary,
  refundIdempotencyKey,
  refundOperationId,
  validateConfirmInput
} = require('../lib/paymentReconciliation');
const {
  CREDIT_GRANT_POLICY_VERSION,
  CREDIT_LOT_POLICY_VERSION,
  hasNumericLotBalances
} = require('../lib/creditLotAccounting');
const {
  commitCreditDeduct,
  commitCreditRestoreFromHistory
} = require('../lib/usageBilling');
const {
  TERMS_POLICY_VERSION,
  REFUND_POLICY_VERSION,
  SUBSCRIPTION_REFUND_POLICY_VERSION,
  REFUND_WINDOW_DAYS,
  REFUND_WINDOW_MS,
  REFUND_WINDOW_BASIS,
  REFUND_CALCULATION_BASIS,
  REFUND_BONUS_TREATMENT,
  refundWindowLegalDeadlineMs,
  buildRefundPolicyPurchaseSnapshot
} = require('../lib/refundPolicySnapshot');
const gptAnalyze = require('./analyze-gpt');

const router = express.Router();
const JOB_ARCHIVE_COLLECTION = 'transformJobArchive';
const UNLIMITED_REFUND_SETTLEMENT_USES = 50;
const PAYMENT_RECONCILIATION_LEASE_MS = 5 * 60 * 1000;
const PAYMENT_RECONCILIATION_MAX_ATTEMPTS = 12;
const PAYMENT_ACCOUNT_CLAIMS_COLLECTION = 'paymentAccountClaims';
const ACTIVE_PAYMENT_INTENT_STATUSES = new Set([
  'confirming',
  'status_unknown',
  'provider_not_done',
  'approved_reconciliation_required',
  'approved_account_unavailable',
  'manual_review'
]);
const PAYMENT_CHECKOUT_PRECLAIM_TTL_MS = 30 * 60 * 1000;
const RETIRED_BASIC_EXPERIMENT_CONFIG = Object.freeze({
  enabled: false,
  retired: true,
  source: 'retired',
  version: 'single-engine-v2.5.5'
});
function tossBasicToken(res) {
  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) {
    logger.error('payment.toss_secret_missing');
    if (res) res.status(503).json({ error: '결제 서버 설정이 완료되지 않았습니다.' });
    return null;
  }
  return Buffer.from(secretKey + ':').toString('base64');
}

async function getCreditOrdersForUser(uid) {
  // 결제 컨텍스트는 최근 30일 사용량과 반복 구매 순서를 계산한다. 정렬 없는
  // limit(100)은 어떤 100건이 반환될지 보장하지 않아 고사용자의 최신 주문을
  // 누락할 수 있으므로 해당 사용자의 주문 스냅샷 전체를 읽고 서버에서 정렬한다.
  const snap = await db.collection('orders').where('uid', '==', uid).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function parseProviderJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function paymentAccountClaimPatch({ uid, lane, id, status, operationId = null, active = true }) {
  const nowMs = Date.now();
  return {
    uid,
    [lane]: {
      [id]: active
        ? {
          status,
          ...(operationId ? { operationId } : {}),
          updatedAtMs: nowMs
        }
        : admin.firestore.FieldValue.delete()
    },
    updatedAtMs: nowMs
  };
}

async function markPaymentIntent(orderId, status, fields = {}) {
  const intentRef = db.collection('paymentIntents').doc(orderId);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(intentRef);
    const existing = snapshot.exists ? snapshot.data() || {} : {};
    const uid = String(fields.uid || existing.uid || '');
    transaction.set(intentRef, {
      status,
      ...fields,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (uid) {
      transaction.set(
        db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(uid),
        paymentAccountClaimPatch({
          uid,
          lane: 'activeCreditIntents',
          id: orderId,
          status,
          active: ACTIVE_PAYMENT_INTENT_STATUSES.has(status)
        }),
        { merge: true }
      );
    }
  });
}

async function bestEffortMarkPaymentIntent(orderId, status, fields = {}) {
  try {
    await markPaymentIntent(orderId, status, fields);
  } catch (err) {
    logger.error('payment.intent_update_failed', { orderId, status, err });
  }
}

function paymentCallbackBindingHash({ uid, orderId, amount, paymentKeyDigest }) {
  return crypto.createHash('sha256')
    .update([
      String(uid || ''),
      String(orderId || ''),
      String(Math.max(0, Math.floor(Number(amount) || 0))),
      String(paymentKeyDigest || '')
    ].join('\u0000'))
    .digest('hex');
}

function accountDeletionBlocksPayment(job, nowMs = Date.now()) {
  const value = job && typeof job === 'object' ? job : {};
  const status = String(value.status || '');
  if (['processing', 'retry_pending', 'manual_review'].includes(status)) return true;
  return status === 'completed' && Number(value.protectUntilMs) > nowMs;
}

function paymentIntentPreclaimExpired(intent, nowMs = Date.now()) {
  const value = intent && typeof intent === 'object' ? intent : {};
  return Number(value.ownerClaimVersion) >= 2
    && Number(value.checkoutExpiresAtMs) < nowMs;
}

function paymentAccountUnavailableError(code = 'ACCOUNT_DELETION_IN_PROGRESS') {
  return Object.assign(new Error(code), {
    status: 409,
    code
  });
}

function upgradeCheckoutReservationPatch(sourceOrder, { uid, orderId, nowMs = Date.now() }) {
  const source = sourceOrder && typeof sourceOrder === 'object' ? sourceOrder : null;
  const reservedOrderId = String(source?.upgradeCheckoutOrderId || '');
  const reservationActive = reservedOrderId
    && Number(source?.upgradeCheckoutExpiresAtMs || 0) > nowMs;
  if (!source
    || source.uid !== uid
    || Number(source.amount) !== STARTER_UPGRADE.sourceAmount
    || String(source.status || '') !== 'paid'
    || (source.upgradeOrderId && source.upgradeOrderId !== orderId)
    || (source.activeUpgradeOrderId && source.activeUpgradeOrderId !== orderId)
    || (reservationActive && reservedOrderId !== orderId)) {
    throw Object.assign(new Error('UPGRADE_SOURCE_CONFLICT'), {
      status: 409,
      code: 'UPGRADE_SOURCE_CONFLICT'
    });
  }
  return {
    upgradeCheckoutOrderId: orderId,
    upgradeCheckoutClaimedBy: uid,
    upgradeCheckoutClaimedAtMs: nowMs,
    upgradeCheckoutExpiresAtMs: nowMs + PAYMENT_CHECKOUT_PRECLAIM_TTL_MS
  };
}

function paymentIntentGrant(existing, creditGrant) {
  const purchaseKind = existing?.purchaseKind || creditGrant?.purchaseKind || 'credit_package';
  const sourceOrderId = existing?.sourceOrderId || creditGrant?.sourceOrderId || null;
  const targetAmount = Math.max(0, Math.floor(Number(existing?.targetAmount ?? creditGrant?.targetAmount) || 0));
  const storedPaid = Number(existing && existing.paidCredits);
  const storedTotal = Number(existing && existing.totalGrantedCredits);
  if (storedPaid > 0 && storedTotal >= storedPaid) {
    const paidCredits = Math.floor(storedPaid);
    const retiredFirstPurchaseBonus = Math.max(
      0,
      Math.floor(Number(existing.firstPurchaseBonusCredits) || 0)
    );
    const immutableTotal = Math.max(paidCredits, Math.floor(storedTotal) - retiredFirstPurchaseBonus);
    const bonusBudget = Math.max(0, immutableTotal - paidCredits);
    const eventBonusCredits = Math.min(
      bonusBudget,
      Math.max(0, Math.floor(Number(existing.eventBonusCredits) || 0))
    );
    const packageBonusCredits = Math.min(
      Math.max(0, bonusBudget - eventBonusCredits),
      Math.max(0, Math.floor(Number(existing.packageBonusCredits) || (bonusBudget - eventBonusCredits)))
    );
    return {
      paidCredits,
      packageBonusCredits,
      eventBonusCredits,
      bonusCredits: bonusBudget,
      totalCredits: immutableTotal,
      packageBonusRate: Math.max(0, Math.floor(Number(existing.packageBonusRate) || 0)),
      eventBonusRate: Math.max(0, Math.floor(Number(existing.eventBonusRate) || 0)),
      eventId: existing.eventId || null,
      eventEndsAtMs: Math.max(0, Math.floor(Number(existing.eventEndsAtMs) || 0)),
      grantPolicyVersion: existing.grantPolicyVersion || 'credit-grant-base-v1',
      offerPolicyVersion: existing.offerPolicyVersion || null,
      purchaseKind,
      sourceOrderId,
      targetAmount,
      firstPurchaseBonusCredits: 0
    };
  }
  // 배포 전에 만들어졌지만 아직 주문으로 확정되지 않은 intent는 당시 baseCredits가
  // 실제 총 지급량이었다. 재시도 시 새 이벤트 지급량으로 바꾸지 않고 원래 약속을 지킨다.
  const legacyPromisedCredits = Math.max(0, Math.floor(Number(existing && existing.baseCredits) || 0));
  if (legacyPromisedCredits > 0) {
    return {
      paidCredits: legacyPromisedCredits,
      packageBonusCredits: 0,
      eventBonusCredits: 0,
      bonusCredits: 0,
      totalCredits: legacyPromisedCredits,
      packageBonusRate: 0,
      eventBonusRate: 0,
      eventId: null,
      eventEndsAtMs: 0,
      grantPolicyVersion: 'legacy-total-grant-v1',
      offerPolicyVersion: null,
      purchaseKind,
      sourceOrderId,
      targetAmount,
      firstPurchaseBonusCredits: 0
    };
  }
  return {
    paidCredits: creditGrant.paidCredits,
    packageBonusCredits: creditGrant.packageBonusCredits || 0,
    eventBonusCredits: creditGrant.eventBonusCredits,
    bonusCredits: creditGrant.bonusCredits || Math.max(0, creditGrant.totalCredits - creditGrant.paidCredits),
    totalCredits: creditGrant.totalCredits,
    packageBonusRate: creditGrant.packageBonusRate || 0,
    eventBonusRate: creditGrant.eventBonusRate,
    eventId: creditGrant.eventId,
    eventEndsAtMs: creditGrant.eventEndsAtMs,
    grantPolicyVersion: creditGrant.grantPolicyVersion,
    offerPolicyVersion: creditGrant.offerPolicyVersion || null,
    purchaseKind,
    sourceOrderId,
    targetAmount,
    firstPurchaseBonusCredits: 0
  };
}

const CREDIT_CANCELLATION_LOCKED_INTENT_STATUSES = new Set([
  'cancellation_no_credit',
  'cancellation_review_required'
]);

function assertPaymentIntentAllowsCreditGrant(intent) {
  const status = String(intent?.status || '');
  if (intent?.creditCancellationLocked === true || CREDIT_CANCELLATION_LOCKED_INTENT_STATUSES.has(status)) {
    throw Object.assign(new Error('PAYMENT_CANCELLATION_LOCKED'), {
      status: 409,
      code: 'PAYMENT_CANCELLATION_LOCKED'
    });
  }
  return true;
}

async function preclaimPaymentIntent({ orderId, uid, amount, creditGrant }) {
  const intentRef = db.collection('paymentIntents').doc(orderId);
  const userRef = db.collection('users').doc(uid);
  const deletionJobRef = db.collection('accountDeletionJobs').doc(uid);
  const sourceOrderRef = creditGrant?.purchaseKind === STARTER_UPGRADE.kind && creditGrant?.sourceOrderId
    ? db.collection('orders').doc(creditGrant.sourceOrderId)
    : null;
  const nowMs = Date.now();
  return db.runTransaction(async transaction => {
    const [intentSnapshot, userSnapshot, deletionJobSnapshot, sourceOrderSnapshot] = await Promise.all([
      transaction.get(intentRef),
      transaction.get(userRef),
      transaction.get(deletionJobRef),
      sourceOrderRef ? transaction.get(sourceOrderRef) : Promise.resolve(null)
    ]);
    if (!userSnapshot.exists) throw paymentAccountUnavailableError('PAYMENT_USER_MISSING');
    if (deletionJobSnapshot.exists && accountDeletionBlocksPayment(deletionJobSnapshot.data(), nowMs)) {
      throw paymentAccountUnavailableError();
    }
    const existing = intentSnapshot.exists ? intentSnapshot.data() || {} : null;
    assertPaymentIntentAllowsCreditGrant(existing);
    if (existing && (
      existing.uid !== uid
      || Number(existing.amount) !== amount
      || String(existing.purchaseKind || 'credit_package') !== String(creditGrant.purchaseKind || 'credit_package')
      || String(existing.sourceOrderId || '') !== String(creditGrant.sourceOrderId || '')
    )) {
      throw Object.assign(new Error('PAYMENT_INTENT_CONFLICT'), { status: 409, code: 'PAYMENT_INTENT_CONFLICT' });
    }
    if (existing?.paymentKeyHash || existing?.status === 'applied') {
      throw Object.assign(new Error('PAYMENT_INTENT_ALREADY_CONFIRMED'), {
        status: 409,
        code: 'PAYMENT_INTENT_ALREADY_CONFIRMED'
      });
    }
    const grant = paymentIntentGrant(existing, creditGrant);
    const upgradeReservation = sourceOrderRef
      ? upgradeCheckoutReservationPatch(
        sourceOrderSnapshot?.exists ? sourceOrderSnapshot.data() || {} : null,
        { uid, orderId, nowMs }
      )
      : null;
    transaction.set(intentRef, {
      uid,
      amount,
      paidCredits: grant.paidCredits,
      baseCredits: grant.paidCredits,
      packageBonusCredits: grant.packageBonusCredits,
      eventBonusCredits: grant.eventBonusCredits,
      bonusCredits: grant.bonusCredits,
      totalGrantedCredits: grant.totalCredits,
      packageBonusRate: grant.packageBonusRate,
      eventBonusRate: grant.eventBonusRate,
      eventId: grant.eventId,
      eventEndsAtMs: grant.eventEndsAtMs,
      grantPolicyVersion: grant.grantPolicyVersion,
      offerPolicyVersion: grant.offerPolicyVersion,
      purchaseKind: grant.purchaseKind,
      sourceOrderId: grant.sourceOrderId,
      targetAmount: grant.targetAmount,
      firstPurchaseBonusCredits: grant.firstPurchaseBonusCredits,
      ownerClaimVersion: 2,
      ownerClaimedAt: existing?.ownerClaimedAt || admin.firestore.FieldValue.serverTimestamp(),
      status: 'checkout_prepared',
      checkoutExpiresAtMs: nowMs + PAYMENT_CHECKOUT_PRECLAIM_TTL_MS,
      reconciliationCandidate: false,
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (sourceOrderRef) transaction.update(sourceOrderRef, upgradeReservation);
    return { grant, expiresAtMs: nowMs + PAYMENT_CHECKOUT_PRECLAIM_TTL_MS };
  });
}

async function preparePaymentIntent({ orderId, paymentKey, uid, amount, creditGrant }) {
  const intentRef = db.collection('paymentIntents').doc(orderId);
  const userRef = db.collection('users').doc(uid);
  const deletionJobRef = db.collection('accountDeletionJobs').doc(uid);
  const accountClaimRef = db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(uid);
  const sourceOrderRef = creditGrant?.purchaseKind === STARTER_UPGRADE.kind && creditGrant?.sourceOrderId
    ? db.collection('orders').doc(creditGrant.sourceOrderId)
    : null;
  const keyHash = paymentKeyHash(paymentKey);
  const callbackBindingHash = paymentCallbackBindingHash({
    uid,
    orderId,
    amount,
    paymentKeyDigest: keyHash
  });
  return db.runTransaction(async transaction => {
    const [snap, userSnap, deletionJobSnap, sourceOrderSnap] = await Promise.all([
      transaction.get(intentRef),
      transaction.get(userRef),
      transaction.get(deletionJobRef),
      sourceOrderRef ? transaction.get(sourceOrderRef) : Promise.resolve(null)
    ]);
    if (!userSnap.exists) throw paymentAccountUnavailableError('PAYMENT_USER_MISSING');
    if (deletionJobSnap.exists && accountDeletionBlocksPayment(deletionJobSnap.data())) {
      throw paymentAccountUnavailableError();
    }
    const existing = snap.exists ? snap.data() : null;
    assertPaymentIntentAllowsCreditGrant(existing);
    if (!existing && process.env.PAYMENT_PRECLAIM_REQUIRED === '1') {
      throw Object.assign(new Error('PAYMENT_PRECLAIM_REQUIRED'), {
        status: 409,
        code: 'PAYMENT_PRECLAIM_REQUIRED'
      });
    }
    if (paymentIntentPreclaimExpired(existing)) {
      throw Object.assign(new Error('PAYMENT_PRECLAIM_EXPIRED'), {
        status: 409,
        code: 'PAYMENT_PRECLAIM_EXPIRED'
      });
    }
    if (existing && (
      existing.uid !== uid ||
      Number(existing.amount) !== amount ||
      (existing.paymentKeyHash && existing.paymentKeyHash !== keyHash)
      || (existing.callbackBindingHash && existing.callbackBindingHash !== callbackBindingHash)
      || String(existing.purchaseKind || 'credit_package') !== String(creditGrant.purchaseKind || 'credit_package')
      || String(existing.sourceOrderId || '') !== String(creditGrant.sourceOrderId || '')
    )) {
      throw Object.assign(new Error('PAYMENT_INTENT_CONFLICT'), { status: 409 });
    }
    const grant = paymentIntentGrant(existing, creditGrant);
    const upgradeReservation = sourceOrderRef
      ? upgradeCheckoutReservationPatch(
        sourceOrderSnap?.exists ? sourceOrderSnap.data() || {} : null,
        { uid, orderId }
      )
      : null;
    transaction.set(intentRef, {
      uid,
      amount,
      paidCredits: grant.paidCredits,
      baseCredits: grant.paidCredits,
      packageBonusCredits: grant.packageBonusCredits,
      eventBonusCredits: grant.eventBonusCredits,
      bonusCredits: grant.bonusCredits,
      totalGrantedCredits: grant.totalCredits,
      packageBonusRate: grant.packageBonusRate,
      eventBonusRate: grant.eventBonusRate,
      eventId: grant.eventId,
      eventEndsAtMs: grant.eventEndsAtMs,
      grantPolicyVersion: grant.grantPolicyVersion,
      offerPolicyVersion: grant.offerPolicyVersion,
      purchaseKind: grant.purchaseKind,
      sourceOrderId: grant.sourceOrderId,
      targetAmount: grant.targetAmount,
      firstPurchaseBonusCredits: grant.firstPurchaseBonusCredits,
      paymentKeyHash: keyHash,
      callbackBindingHash,
      // A callback must not erase the stronger owner claim established before
      // the Toss window opened. Legacy clients remain version 1 until the
      // compatibility switch is closed.
      ownerClaimVersion: Number(existing?.ownerClaimVersion) >= 2 ? 2 : 1,
      ownerClaimedAt: existing?.ownerClaimedAt || admin.firestore.FieldValue.serverTimestamp(),
      status: existing && existing.status === 'applied' ? 'applied' : 'confirming',
      reconciliationCandidate: existing?.status === 'applied' ? false : true,
      reconciliationRetryAtMs: existing?.status === 'applied'
        ? admin.firestore.FieldValue.delete()
        : (Number(existing?.reconciliationRetryAtMs) || Date.now() + 5 * 60 * 1000),
      attempts: Number(existing?.attempts || 0) + 1,
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(accountClaimRef, paymentAccountClaimPatch({
      uid,
      lane: 'activeCreditIntents',
      id: orderId,
      status: existing?.status === 'applied' ? 'applied' : 'confirming',
      active: existing?.status !== 'applied'
    }), { merge: true });
    if (sourceOrderRef) transaction.update(sourceOrderRef, upgradeReservation);
    return grant;
  });
}

async function requestTossConfirm({ basicToken, paymentKey, orderId, amount }) {
  try {
    const response = await outboundFetch('toss', 'https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': confirmIdempotencyKey(orderId, paymentKey)
      },
      body: JSON.stringify({ paymentKey, orderId, amount })
    });
    return { response, result: await parseProviderJson(response), networkError: null };
  } catch (networkError) {
    return { response: null, result: {}, networkError };
  }
}

async function queryTossOrder({ basicToken, orderId }) {
  try {
    const response = await outboundFetch('toss', `https://api.tosspayments.com/v1/payments/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicToken}` }
    });
    return { response, result: await parseProviderJson(response), networkError: null };
  } catch (networkError) {
    return { response: null, result: {}, networkError };
  }
}

function creditPaymentResponse(granted) {
  return {
    ok: true,
    deduped: granted.deduped === true,
    message: granted.deduped ? '이미 처리된 결제입니다.' : '충전 성공',
    creditAmount: granted.totalCredits,
    baseCreditAmount: granted.baseCredits,
    bonusCredits: granted.bonusCredits,
    packageBonusCredits: granted.packageBonusCredits || 0,
    eventBonusCredits: granted.eventBonusCredits || 0,
    creditEventId: granted.eventId || null,
    offerPolicyVersion: granted.offerPolicyVersion || null,
    purchaseKind: granted.purchaseKind || 'credit_package',
    sourceOrderId: granted.sourceOrderId || null,
    newBalance: granted.newBalance,
    experimentKey: granted.experimentKey,
    experimentVariant: granted.experimentVariant
  };
}

async function applyCreditPayment({
  verifiedUid,
  orderId,
  paymentKey,
  safeAmount,
  creditGrant,
  customerEmail,
  providerPayment,
  reconciliationSource
}) {
  const orderRef = db.collection('orders').doc(orderId);
  const userRef = db.collection('users').doc(verifiedUid);
  const intentRef = db.collection('paymentIntents').doc(orderId);
  const deletionJobRef = db.collection('accountDeletionJobs').doc(verifiedUid);
  const accountClaimRef = db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(verifiedUid);
  const baseCredits = creditGrant.paidCredits;
  const packageBonusCredits = Math.max(0, Math.floor(Number(creditGrant.packageBonusCredits) || 0));
  const eventBonusCredits = Math.max(0, Math.floor(Number(creditGrant.eventBonusCredits) || 0));
  const firstPurchaseBonusCredits = Math.max(0, Math.floor(Number(creditGrant.firstPurchaseBonusCredits) || 0));
  const totalCredits = creditGrant.totalCredits;
  const bonusCredits = Math.max(0, totalCredits - baseCredits);
  const usesBaseCreditPolicy = creditGrant.grantPolicyVersion === CREDIT_GRANT_POLICY_VERSION;
  const creditLotRef = userRef.collection('creditLots').doc(orderId);
  const isUpgrade = creditGrant.purchaseKind === STARTER_UPGRADE.kind;
  const sourceOrderRef = isUpgrade && creditGrant.sourceOrderId
    ? db.collection('orders').doc(creditGrant.sourceOrderId)
    : null;
  // 크레딧은 결제 확정과 동시에 제공된다. 서버가 당시 약관 버전과 환불 기산점을
  // 주문에 고정해 두면 향후 정책이 바뀌어도 구매 당시 기준을 재현할 수 있다.
  const refundPolicyPurchaseSnapshot = buildRefundPolicyPurchaseSnapshot();

  return db.runTransaction(async transaction => {
    // Firestore transactions require every read before the first write.
    const orderSnap = await transaction.get(orderRef);
    const userSnap = await transaction.get(userRef);
    const intentSnap = await transaction.get(intentRef);
    const deletionJobSnap = await transaction.get(deletionJobRef);
    const sourceOrderSnap = sourceOrderRef ? await transaction.get(sourceOrderRef) : null;
    const userData = userSnap.exists ? userSnap.data() : {};
    const currentCredits = Number(userData.credits) || 0;

    if (!userSnap.exists) throw paymentAccountUnavailableError('PAYMENT_USER_MISSING');
    if (deletionJobSnap.exists && accountDeletionBlocksPayment(deletionJobSnap.data())) {
      throw paymentAccountUnavailableError();
    }

    if (intentSnap.exists) assertPaymentIntentAllowsCreditGrant(intentSnap.data() || {});

    if (orderSnap.exists) {
      const order = orderSnap.data() || {};
      if (order.uid !== verifiedUid || Number(order.amount) !== safeAmount) {
        throw Object.assign(new Error('ORDER_CONFLICT'), { status: 409 });
      }
      const totalCredits = Number(order.safeCredits ?? order.credits ?? baseCredits) || baseCredits;
      transaction.set(intentRef, {
        status: 'applied',
        dedupedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(accountClaimRef, paymentAccountClaimPatch({
        uid: verifiedUid,
        lane: 'activeCreditIntents',
        id: orderId,
        status: 'applied',
        active: false
      }), { merge: true });
      return {
        deduped: true,
        baseCredits: Number(order.paidCredits ?? order.baseCredits) || Math.min(baseCredits, totalCredits),
        bonusCredits: Math.max(0, totalCredits - (Number(order.paidCredits ?? order.baseCredits) || totalCredits)),
        packageBonusCredits: Number(order.packageBonusCredits) || 0,
        eventBonusCredits: Number(order.eventBonusCredits) || 0,
        eventId: order.creditEventId || null,
        totalCredits,
        newBalance: currentCredits,
        experimentKey: order.offerExperimentKey || null,
        experimentVariant: order.offerExperimentVariant || null,
        purchaseKind: order.purchaseKind || 'credit_package',
        sourceOrderId: order.sourceOrderId || null,
        offerPolicyVersion: order.offerPolicyVersion || null
      };
    }

    if (!intentSnap.exists) {
      throw Object.assign(new Error('PAYMENT_INTENT_MISSING'), { status: 503 });
    }
    const intent = intentSnap.data() || {};
    const expectedBindingHash = paymentCallbackBindingHash({
      uid: verifiedUid,
      orderId,
      amount: safeAmount,
      paymentKeyDigest: paymentKeyHash(paymentKey)
    });
    if (
      intent.uid !== verifiedUid ||
      Number(intent.amount) !== safeAmount ||
      intent.paymentKeyHash !== paymentKeyHash(paymentKey) ||
      (intent.callbackBindingHash && intent.callbackBindingHash !== expectedBindingHash)
    ) {
      throw Object.assign(new Error('PAYMENT_INTENT_CONFLICT'), { status: 409 });
    }
    if (isUpgrade) {
      const sourceOrder = sourceOrderSnap?.exists ? (sourceOrderSnap.data() || {}) : null;
      if (!sourceOrder
        || sourceOrder.uid !== verifiedUid
        || Number(sourceOrder.amount) !== STARTER_UPGRADE.sourceAmount
        || String(sourceOrder.status || '') !== 'paid'
        || (sourceOrder.upgradeOrderId && sourceOrder.upgradeOrderId !== orderId)
        || (sourceOrder.activeUpgradeOrderId && sourceOrder.activeUpgradeOrderId !== orderId)
        || (sourceOrder.upgradeCheckoutOrderId && sourceOrder.upgradeCheckoutOrderId !== orderId)) {
        throw Object.assign(new Error('UPGRADE_SOURCE_CONFLICT'), { status: 409, code: 'UPGRADE_SOURCE_CONFLICT' });
      }
    }

    const newCredits = currentCredits + totalCredits;
    const paidAt = providerPayment?.approvedAt || null;

    const lotFields = usesBaseCreditPolicy ? {
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      creditLotActive: totalCredits > 0,
      refundPaidCreditsRemaining: baseCredits,
      // 기존 필드명은 이벤트 보너스였지만 v2부터는 상시+이벤트 보너스 전체를 뜻한다.
      refundEventBonusCreditsRemaining: bonusCredits
    } : {};
    transaction.set(orderRef, {
      uid: verifiedUid,
      amount: safeAmount,
      safeCredits: totalCredits,
      totalGrantedCredits: totalCredits,
      paidCredits: baseCredits,
      baseCredits,
      packageBonusCredits,
      eventBonusCredits,
      bonusCredits,
      promotionalBonusCredits: bonusCredits,
      firstPurchaseBonusCredits,
      creditEventId: creditGrant.eventId,
      creditEventBonusRate: creditGrant.eventBonusRate,
      creditPackageBonusRate: creditGrant.packageBonusRate || 0,
      creditEventEndsAtMs: creditGrant.eventEndsAtMs,
      creditGrantPolicyVersion: creditGrant.grantPolicyVersion,
      offerPolicyVersion: creditGrant.offerPolicyVersion || null,
      purchaseKind: creditGrant.purchaseKind || 'credit_package',
      sourceOrderId: creditGrant.sourceOrderId || null,
      targetAmount: creditGrant.targetAmount || null,
      cumulativeCredits: creditGrant.cumulativeCredits || null,
      refundCreditBasis: usesBaseCreditPolicy ? 'paid_credits_first' : 'legacy_total_grant',
      ...lotFields,
      paymentKeyPresent: true,
      customerEmail: typeof customerEmail === 'string' ? customerEmail.slice(0, 160) : '',
      status: 'paid',
      providerStatus: providerPayment?.status || 'DONE',
      providerApprovedAt: paidAt,
      reconciliationSource,
      ...refundPolicyPurchaseSnapshot,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    transaction.set(db.collection('paymentSecrets').doc(orderId), {
      paymentKey,
      uid: verifiedUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (sourceOrderRef) {
      transaction.update(sourceOrderRef, {
        upgradeOrderId: orderId,
        activeUpgradeOrderId: orderId,
        upgradeCheckoutOrderId: admin.firestore.FieldValue.delete(),
        upgradeCheckoutClaimedBy: admin.firestore.FieldValue.delete(),
        upgradeCheckoutClaimedAtMs: admin.firestore.FieldValue.delete(),
        upgradeCheckoutExpiresAtMs: admin.firestore.FieldValue.delete(),
        upgradedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const userUpdate = {
      credits: newCredits,
      lastPayment: admin.firestore.FieldValue.serverTimestamp()
    };
    if (usesBaseCreditPolicy) {
      userUpdate.creditLotV1Balance = Math.max(0, Math.floor(Number(userData.creditLotV1Balance) || 0)) + totalCredits;
      transaction.set(creditLotRef, {
        orderId,
        creditGrantPolicyVersion: CREDIT_GRANT_POLICY_VERSION,
        creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
        paidCreditsCap: baseCredits,
        bonusCreditsCap: bonusCredits,
        eventBonusCreditsCap: bonusCredits,
        refundPaidCreditsRemaining: baseCredits,
        refundEventBonusCreditsRemaining: bonusCredits,
        active: totalCredits > 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    if (userSnap.exists) transaction.update(userRef, userUpdate);
    else transaction.set(userRef, userUpdate);

    transaction.set(userRef.collection('creditHistory').doc(`charge_${orderId}`), {
      type: 'charge',
      used: 0,
      amount: totalCredits,
      remaining: newCredits,
      plan: null,
      orderId,
      baseCredits,
      bonusCredits,
      packageBonusCredits,
      eventBonusCredits,
      creditEventId: creditGrant.eventId,
      creditGrantPolicyVersion: creditGrant.grantPolicyVersion,
      offerPolicyVersion: creditGrant.offerPolicyVersion || null,
      purchaseKind: creditGrant.purchaseKind || 'credit_package',
      sourceOrderId: creditGrant.sourceOrderId || null,
      ...(usesBaseCreditPolicy ? { creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    transaction.set(intentRef, {
      status: 'applied',
      reconciliationCandidate: false,
      reconciliationLeaseToken: admin.firestore.FieldValue.delete(),
      reconciliationLeaseUntilMs: admin.firestore.FieldValue.delete(),
      creditedCredits: totalCredits,
      reconciliationSource,
      appliedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(accountClaimRef, paymentAccountClaimPatch({
      uid: verifiedUid,
      lane: 'activeCreditIntents',
      id: orderId,
      status: 'applied',
      active: false
    }), { merge: true });

    return {
      deduped: false,
      baseCredits,
      bonusCredits,
      packageBonusCredits,
      eventBonusCredits,
      eventId: creditGrant.eventId,
      totalCredits,
      newBalance: newCredits,
      experimentKey: null,
      experimentVariant: firstPurchaseBonusCredits > 0 ? 'legacy_honored' : 'retired',
      purchaseKind: creditGrant.purchaseKind || 'credit_package',
      sourceOrderId: creditGrant.sourceOrderId || null,
      offerPolicyVersion: creditGrant.offerPolicyVersion || null
    };
  });
}

function paymentReconciliationClaimable(intent, nowMs = Date.now()) {
  const value = intent && typeof intent === 'object' ? intent : {};
  if (value.reconciliationCandidate !== true || value.status === 'applied') return false;
  if (Number(value.reconciliationRetryAtMs) > nowMs) return false;
  const leaseUntil = Number(value.reconciliationLeaseUntilMs) || 0;
  return !value.reconciliationLeaseToken || leaseUntil <= nowMs;
}

async function claimPaymentReconciliationIntent(doc, nowMs = Date.now()) {
  const leaseToken = crypto.randomUUID();
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(doc.ref);
    if (!snapshot.exists) return null;
    const intent = snapshot.data() || {};
    if (!paymentReconciliationClaimable(intent, nowMs)) return null;
    const attempt = Math.max(0, Math.floor(Number(intent.reconciliationAttempts) || 0)) + 1;
    if (attempt > PAYMENT_RECONCILIATION_MAX_ATTEMPTS) {
      transaction.update(doc.ref, {
        status: 'manual_review',
        reconciliationCandidate: false,
        reconciliationAttempts: attempt - 1,
        reconciliationManualReviewReason: 'retry_exhausted',
        reconciliationLeaseToken: admin.firestore.FieldValue.delete(),
        reconciliationLeaseUntilMs: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      if (intent.uid) {
        transaction.set(
          db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(intent.uid),
          paymentAccountClaimPatch({
            uid: intent.uid,
            lane: 'activeCreditIntents',
            id: doc.id,
            status: 'manual_review',
            active: true
          }),
          { merge: true }
        );
      }
      return { manualReview: true, intent };
    }
    transaction.update(doc.ref, {
      reconciliationLeaseToken: leaseToken,
      reconciliationLeaseUntilMs: nowMs + PAYMENT_RECONCILIATION_LEASE_MS,
      reconciliationAttempts: attempt,
      reconciliationLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { leaseToken, intent: { ...intent, reconciliationAttempts: attempt } };
  });
}

async function transitionPaymentReconciliation(docRef, leaseToken, patch) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists || snapshot.data()?.reconciliationLeaseToken !== leaseToken) return false;
    const existing = snapshot.data() || {};
    transaction.update(docRef, {
      ...patch,
      reconciliationLeaseToken: admin.firestore.FieldValue.delete(),
      reconciliationLeaseUntilMs: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (existing.uid) {
      const nextStatus = String(patch.status || existing.status || 'approved_reconciliation_required');
      transaction.set(
        db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(existing.uid),
        paymentAccountClaimPatch({
          uid: existing.uid,
          lane: 'activeCreditIntents',
          id: docRef.id,
          status: nextStatus,
          active: ACTIVE_PAYMENT_INTENT_STATUSES.has(nextStatus)
        }),
        { merge: true }
      );
    }
    return true;
  });
}

function paymentIntentProviderMatches(intent, providerPayment, orderId) {
  const value = intent && typeof intent === 'object' ? intent : {};
  const payment = providerPayment && typeof providerPayment === 'object' ? providerPayment : {};
  const approval = approvedPaymentValidation(payment, {
    paymentKey: payment.paymentKey,
    orderId,
    amount: value.amount
  });
  if (!approval.ok) return { ok: false, reasons: approval.reasons };
  if (!payment.paymentKey || paymentKeyHash(payment.paymentKey) !== value.paymentKeyHash) {
    return { ok: false, reasons: ['payment_key_hash_mismatch'] };
  }
  const binding = paymentCallbackBindingHash({
    uid: value.uid,
    orderId,
    amount: value.amount,
    paymentKeyDigest: value.paymentKeyHash
  });
  if (value.callbackBindingHash && value.callbackBindingHash !== binding) {
    return { ok: false, reasons: ['callback_binding_mismatch'] };
  }
  return { ok: true, reasons: [] };
}

async function reconcilePendingApprovedPayments({ limit = 25 } = {}) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const nowMs = Date.now();
  const snapshot = await db.collection('paymentIntents')
    .where('reconciliationCandidate', '==', true)
    .limit(Math.min(300, boundedLimit * 6))
    .get();
  const docs = snapshot.docs
    .filter(doc => paymentReconciliationClaimable(doc.data() || {}, nowMs))
    .sort((left, right) => {
      const a = left.data() || {};
      const b = right.data() || {};
      return (Number(a.reconciliationRetryAtMs) || 0) - (Number(b.reconciliationRetryAtMs) || 0)
        || String(left.id).localeCompare(String(right.id));
    })
    .slice(0, boundedLimit);
  const result = { scanned: docs.length, applied: 0, cancelled: 0, retried: 0, manualReview: 0 };
  const basicToken = tossBasicToken();
  if (!basicToken) throw Object.assign(new Error('TOSS_SECRET_MISSING'), { code: 'TOSS_SECRET_MISSING' });

  for (const doc of docs) {
    const claim = await claimPaymentReconciliationIntent(doc, nowMs);
    if (!claim) continue;
    if (claim.manualReview) {
      result.manualReview++;
      continue;
    }
    const { leaseToken, intent } = claim;
    try {
      const uid = String(intent.uid || '');
      const amount = Math.max(0, Math.floor(Number(intent.amount) || 0));
      if (!uid || !amount) throw Object.assign(new Error('PAYMENT_INTENT_INVALID'), { terminal: true });

      const [providerLookup, userSnap, deletionJobSnap] = await Promise.all([
        queryTossOrder({ basicToken, orderId: doc.id }),
        db.collection('users').doc(uid).get(),
        db.collection('accountDeletionJobs').doc(uid).get()
      ]);
      if (!providerLookup.response?.ok) {
        throw Object.assign(new Error('PROVIDER_LOOKUP_UNAVAILABLE'), {
          retryable: true,
          providerStatus: providerLookup.response?.status || 0
        });
      }
      const providerPayment = providerLookup.result || {};
      const providerMatch = paymentIntentProviderMatches(intent, providerPayment, doc.id);
      if (!providerMatch.ok) {
        throw Object.assign(new Error('PAYMENT_RECONCILIATION_MISMATCH'), {
          terminal: true,
          reasons: providerMatch.reasons
        });
      }

      const accountUnavailable = !userSnap.exists
        || (deletionJobSnap.exists && accountDeletionBlocksPayment(deletionJobSnap.data()));
      if (accountUnavailable || intent.providerCancellationRequired === true) {
        const operationId = refundOperationId(doc.id, 0, amount, 0, 'account-unavailable');
        const tossUrl = `https://api.tosspayments.com/v1/payments/${encodeURIComponent(providerPayment.paymentKey)}/cancel`;
        const cancellation = await requestTossCancel({
          tossUrl,
          basicToken,
          operationId,
          cancelReason: '탈퇴 처리 중 승인 결제 자동 취소'
        });
        const cancellationLookup = cancellation.response?.ok
          ? null
          : await queryTossOrder({ basicToken, orderId: doc.id });
        const cancellationState = tossCancellationState({
          response: cancellation.response,
          lookup: cancellationLookup,
          targetRefundedAmount: amount
        });
        if (!cancellationState.confirmed) {
          throw Object.assign(new Error(cancellationState.unknown
            ? 'PROVIDER_CANCELLATION_STATUS_UNKNOWN'
            : 'PROVIDER_CANCELLATION_FAILED'), {
            retryable: cancellationState.unknown,
            terminal: !cancellationState.unknown
          });
        }
        await transitionPaymentReconciliation(doc.ref, leaseToken, {
          status: 'provider_cancelled_account_unavailable',
          reconciliationCandidate: false,
          providerCancellationRequired: false,
          providerCancelledAt: admin.firestore.FieldValue.serverTimestamp()
        });
        result.cancelled++;
        continue;
      }

      const creditGrant = paymentIntentGrant(intent, getCreditProduct(amount) || {});
      await applyCreditPayment({
        verifiedUid: uid,
        orderId: doc.id,
        paymentKey: providerPayment.paymentKey,
        safeAmount: amount,
        creditGrant,
        customerEmail: '',
        providerPayment,
        reconciliationSource: 'scheduled_reconciliation'
      });
      result.applied++;
    } catch (error) {
      const terminal = error.terminal === true;
      const attempts = Math.max(1, Math.floor(Number(intent.reconciliationAttempts) || 1));
      const exhausted = attempts >= PAYMENT_RECONCILIATION_MAX_ATTEMPTS;
      const manualReview = terminal || exhausted;
      await transitionPaymentReconciliation(doc.ref, leaseToken, {
        status: manualReview ? 'manual_review' : 'approved_reconciliation_required',
        reconciliationCandidate: !manualReview,
        reconciliationRetryAtMs: Date.now() + Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(6, attempts - 1))),
        reconciliationErrorCode: String(error.code || error.message || 'PAYMENT_RECONCILIATION_FAILED').slice(0, 80),
        ...(manualReview ? { reconciliationManualReviewReason: terminal ? 'terminal_mismatch' : 'retry_exhausted' } : {})
      });
      if (manualReview) result.manualReview++;
      else result.retried++;
      logger[manualReview ? 'error' : 'warn']('payment.reconciliation_worker_failed', {
        orderId: doc.id,
        uid: intent.uid || null,
        attempts,
        manualReview,
        err: error
      });
    }
  }
  return result;
}

async function handleCreditPaymentConfirmation(req, res) {
  const body = req.body || {};
  const { paymentKey, orderId, amount, meta } = body;
  const legacyBodyUid = typeof body.uid === 'string' ? body.uid : '';
  const idToken = bearerToken(req);
  const requestedKind = String(body.purchaseKind || 'credit_package');
  const sourceOrderId = String(body.sourceOrderId || '').trim();
  const isUpgradeRequest = requestedKind === STARTER_UPGRADE.kind;
  if (!['credit_package', STARTER_UPGRADE.kind].includes(requestedKind)) {
    return res.status(400).json({ error: '지원하지 않는 결제 유형입니다.' });
  }
  if (isUpgradeRequest && !starterUpgradeEnabled(process.env)) {
    return res.status(409).json({
      error: '스타터 결제금액 인정 업그레이드는 연결 환불 검증 후 제공될 예정입니다.',
      code: 'UPGRADE_TEMPORARILY_UNAVAILABLE'
    });
  }
  const safeAmount = Number(amount);
  let product = !isUpgradeRequest && Number.isInteger(safeAmount) ? getCreditProduct(safeAmount) : null;
  let baseCredits = product && product.paidCredits;
  if (isUpgradeRequest && (safeAmount !== STARTER_UPGRADE.additionalAmount || !validateConfirmInput({
    paymentKey: 'upgrade-source',
    orderId: sourceOrderId
  }).ok)) {
    return res.status(400).json({ error: '업그레이드 주문 정보가 올바르지 않습니다.' });
  }
  if (!isUpgradeRequest && (!product || !baseCredits)) {
    return res.status(400).json({ error: '유효하지 않은 결제 금액입니다.' });
  }

  const inputValidation = validateConfirmInput({ paymentKey, orderId });
  if (!inputValidation.ok) return res.status(400).json({ error: inputValidation.error });
  if (!idToken) return res.status(401).json({ error: '로그인이 필요합니다.' });

  let verifiedUid;
  let decodedToken;
  let verifiedCustomerEmail = '';
  try {
    decodedToken = await verifyFirebaseIdToken(idToken, { checkRevoked: true });
    verifiedUid = decodedToken.uid;
    verifiedCustomerEmail = typeof decodedToken.email === 'string'
      ? decodedToken.email.trim().slice(0, 160)
      : '';
    setLogContext({ uid: verifiedUid });
  } catch {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인 후 결제를 완료해주세요.' });
  }
  // Legacy clients may still submit uid. It is never an identity source; keep
  // only the mismatch guard until those clients age out.
  if (legacyBodyUid && legacyBodyUid !== verifiedUid) {
    logger.warn('payment.uid_mismatch_blocked', {
      verifiedUid,
      orderId,
      amount: safeAmount,
      legacyUidPresent: true
    });
    return res.status(403).json({ error: '사용자 정보가 일치하지 않습니다.' });
  }

  let existingOrderPrecheckSnap;
  try {
    existingOrderPrecheckSnap = await db.collection('orders').doc(orderId).get();
  } catch (err) {
    logger.error('payment.precheck_failed', { uid: verifiedUid, orderId, amount: safeAmount, err });
    return res.status(503).json({ error: '결제 처리 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }

  if (isUpgradeRequest && !existingOrderPrecheckSnap.exists) {
    try {
      const [sourceSnap, intentSnap] = await Promise.all([
        db.collection('orders').doc(sourceOrderId).get(),
        db.collection('paymentIntents').doc(orderId).get()
      ]);
      const sourceOrder = sourceSnap.exists ? { id: sourceSnap.id, ...sourceSnap.data() } : null;
      if (!sourceOrder || sourceOrder.uid !== verifiedUid || String(sourceOrder.status || '') !== 'paid') {
        return res.status(409).json({
          error: '업그레이드할 스타터 주문을 확인할 수 없습니다.',
          code: 'UPGRADE_SOURCE_UNAVAILABLE'
        });
      }
      if (intentSnap.exists) {
        const intent = intentSnap.data() || {};
        if (String(intent.purchaseKind || '') !== STARTER_UPGRADE.kind
          || String(intent.sourceOrderId || '') !== sourceOrderId) {
          return res.status(409).json({ error: '기존 결제 시도와 업그레이드 정보가 일치하지 않습니다.' });
        }
        product = {
          ...paymentIntentGrant(intent, getCreditProduct(STARTER_UPGRADE.targetAmount)),
          amount: STARTER_UPGRADE.additionalAmount,
          label: '스탠다드 업그레이드'
        };
      } else {
        product = buildStarterUpgradeGrant(sourceOrder);
      }
      baseCredits = product && product.paidCredits;
      if (!product || !baseCredits) {
        return res.status(409).json({
          error: '이 스타터 주문의 업그레이드 기간이 끝났거나 이미 사용한 혜택입니다.',
          code: 'UPGRADE_NOT_ELIGIBLE'
        });
      }
    } catch (err) {
      logger.error('payment.upgrade_offer_resolve_failed', { uid: verifiedUid, orderId, sourceOrderId, err });
      return res.status(503).json({ error: '업그레이드 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.' });
    }
  }

  // An already-applied order is a successful idempotent retry. Never call Toss again.
  try {
    const existingOrderSnap = existingOrderPrecheckSnap;
    if (existingOrderSnap.exists) {
      const existingOrder = existingOrderSnap.data() || {};
      if (existingOrder.uid !== verifiedUid
        || Number(existingOrder.amount) !== safeAmount
        || String(existingOrder.purchaseKind || 'credit_package') !== requestedKind
        || String(existingOrder.sourceOrderId || '') !== (isUpgradeRequest ? sourceOrderId : '')) {
        logger.error('payment.existing_order_conflict', { verifiedUid, orderId, amount: safeAmount });
        return res.status(409).json({ error: '주문 정보가 기존 처리 내역과 일치하지 않습니다.' });
      }
      const userSnap = await db.collection('users').doc(verifiedUid).get();
      const totalCredits = Number(existingOrder.safeCredits ?? existingOrder.credits ?? baseCredits) || baseCredits;
      const storedBaseCredits = Number(existingOrder.paidCredits ?? existingOrder.baseCredits) || Math.min(baseCredits, totalCredits);
      const existingResult = {
        deduped: true,
        baseCredits: storedBaseCredits,
        bonusCredits: Math.max(0, totalCredits - storedBaseCredits),
        packageBonusCredits: Number(existingOrder.packageBonusCredits) || 0,
        eventBonusCredits: Number(existingOrder.eventBonusCredits) || 0,
        eventId: existingOrder.creditEventId || null,
        totalCredits,
        newBalance: Number(userSnap.data()?.credits) || 0,
        experimentKey: existingOrder.offerExperimentKey || null,
        experimentVariant: existingOrder.offerExperimentVariant || null,
        purchaseKind: existingOrder.purchaseKind || 'credit_package',
        sourceOrderId: existingOrder.sourceOrderId || null
      };
      logger.info('payment.confirm_deduped', { uid: verifiedUid, orderId, amount: safeAmount });
      return res.json(creditPaymentResponse(existingResult));
    }
  } catch (err) {
    logger.error('payment.precheck_failed', { uid: verifiedUid, orderId, amount: safeAmount, err });
    return res.status(503).json({ error: '결제 처리 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }

  const basicToken = tossBasicToken(res);
  if (!basicToken) return;

  // This durable server-only record exists before the external approval call.
  let creditGrant;
  try {
    creditGrant = await preparePaymentIntent({
      orderId,
      paymentKey,
      uid: verifiedUid,
      amount: safeAmount,
      creditGrant: product
    });
  } catch (err) {
    const status = Number(err.status) || 503;
    const cancellationLocked = err.code === 'PAYMENT_CANCELLATION_LOCKED';
    const accountUnavailable = err.code === 'ACCOUNT_DELETION_IN_PROGRESS' || err.code === 'PAYMENT_USER_MISSING';
    const preclaimError = err.code === 'PAYMENT_PRECLAIM_REQUIRED' || err.code === 'PAYMENT_PRECLAIM_EXPIRED';
    logger[cancellationLocked || accountUnavailable ? 'warn' : 'error'](
      cancellationLocked
        ? 'payment.credit_grant_blocked_by_cancellation'
        : (accountUnavailable ? 'payment.intent_blocked_account_unavailable' : 'payment.intent_prepare_failed'),
      { uid: verifiedUid, orderId, amount: safeAmount, stage: 'prepare', err }
    );
    return res.status(status).json({
      error: accountUnavailable
        ? '탈퇴 처리 중이거나 결제 계정을 확인할 수 없어 새 결제를 시작할 수 없습니다.'
        : (preclaimError
          ? '결제 준비 정보가 없거나 만료됐습니다. 충전 화면에서 결제를 다시 시작해 주세요.'
        : (cancellationLocked
        ? '결제 취소가 먼저 확인된 주문이라 크레딧 지급을 중단했습니다. 결제 내역을 확인해 주세요.'
        : (status === 409
          ? '주문 정보가 기존 결제 시도와 일치하지 않습니다.'
          : '결제 처리를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.'))),
      ...(cancellationLocked
        ? { code: 'PAYMENT_CANCELLATION_LOCKED' }
        : (accountUnavailable || preclaimError ? { code: err.code } : {}))
    });
  }

  const confirmation = await requestTossConfirm({ basicToken, paymentKey, orderId, amount: safeAmount });
  let providerPayment = confirmation.response?.ok ? confirmation.result : null;
  let reconciliationSource = 'confirm_response';
  let lookup = null;

  if (!providerPayment) {
    logger.warn('payment.toss_confirm_failed', {
      uid: verifiedUid,
      orderId,
      amount: safeAmount,
      status: confirmation.response?.status || null,
      toss: providerResultSummary(confirmation.result),
      networkError: confirmation.networkError ? confirmation.networkError.message : null
    });
    // A lost response and ALREADY_PROCESSED_PAYMENT are reconciled from Toss's order state.
    lookup = await queryTossOrder({ basicToken, orderId });
    if (lookup.response?.ok) {
      providerPayment = lookup.result;
      reconciliationSource = 'order_lookup';
    }
  }

  if (!providerPayment) {
    const code = confirmation.result?.code || null;
    const ambiguous = Boolean(
      confirmation.networkError ||
      !confirmation.response ||
      confirmation.response.status >= 500 ||
      code === 'ALREADY_PROCESSED_PAYMENT' ||
      lookup?.networkError ||
      (lookup?.response && lookup.response.status >= 500)
    );
    await bestEffortMarkPaymentIntent(orderId, ambiguous ? 'status_unknown' : 'confirm_failed', {
      lastProviderCode: code,
      lastProviderStatus: confirmation.response?.status || null,
      lookupStatus: lookup?.response?.status || null,
      reconciliationCandidate: ambiguous,
      ...(ambiguous ? { reconciliationRetryAtMs: Date.now() } : {})
    });
    if (ambiguous) {
      logger.error('payment.status_unknown', { uid: verifiedUid, orderId, amount: safeAmount, code });
      return res.status(502).json({
        error: '결제 상태 확인이 지연되고 있습니다. 잠시 후 다시 시도하면 자동으로 복구됩니다.',
        code: 'PAYMENT_STATUS_UNKNOWN',
        retryable: true
      });
    }
    const providerStatus = confirmation.response?.status;
    const responseStatus = providerStatus >= 400 && providerStatus < 500 ? providerStatus : 502;
    return res.status(responseStatus).json({
      error: confirmation.result?.message || '결제가 승인되지 않았습니다.',
      code: code || 'PAYMENT_CONFIRM_FAILED'
    });
  }

  const approval = approvedPaymentValidation(providerPayment, {
    paymentKey,
    orderId,
    amount: safeAmount
  });
  if (!approval.ok) {
    const identityMismatch = approval.reasons.some(reason => reason !== 'status_not_done');
    const status = identityMismatch ? 'manual_review' : 'provider_not_done';
    await bestEffortMarkPaymentIntent(orderId, status, {
      reconciliationSource,
      providerStatus: approval.status,
      validationReasons: approval.reasons,
      reconciliationCandidate: !identityMismatch
    });
    const logFields = {
      uid: verifiedUid,
      orderId,
      amount: safeAmount,
      reconciliationSource,
      validationReasons: approval.reasons,
      provider: providerResultSummary(providerPayment)
    };
    if (identityMismatch) {
      logger.error('payment.reconciliation_mismatch', logFields);
      return res.status(502).json({
        error: '결제 승인 정보가 주문 정보와 일치하지 않아 자동 지급을 중단했습니다.',
        code: 'PAYMENT_RECONCILIATION_MISMATCH'
      });
    }
    logger.warn('payment.provider_not_done', logFields);
    return res.status(409).json({
      error: '결제가 완료 상태가 아닙니다.',
      code: `PAYMENT_${approval.status || 'NOT_DONE'}`
    });
  }

  await bestEffortMarkPaymentIntent(orderId, 'approved_reconciliation_required', {
    reconciliationSource,
    providerStatus: approval.status,
    providerApprovedAt: providerPayment.approvedAt || null,
    reconciliationCandidate: true,
    reconciliationRetryAtMs: Date.now()
  });

  let granted;
  try {
    granted = await applyCreditPayment({
      verifiedUid,
      orderId,
      paymentKey,
      safeAmount,
      creditGrant,
      customerEmail: verifiedCustomerEmail,
      providerPayment,
      reconciliationSource
    });
  } catch (err) {
    if (err.code === 'PAYMENT_CANCELLATION_LOCKED') {
      logger.warn('payment.credit_grant_blocked_by_cancellation', {
        uid: verifiedUid,
        orderId,
        amount: safeAmount,
        stage: 'apply',
        reconciliationSource,
        err
      });
      return res.status(409).json({
        error: '결제 취소가 먼저 확인되어 크레딧을 지급하지 않았습니다. 결제 내역을 확인해 주세요.',
        code: 'PAYMENT_CANCELLATION_LOCKED',
        retryable: false
      });
    }
    await bestEffortMarkPaymentIntent(orderId,
      err.code === 'ACCOUNT_DELETION_IN_PROGRESS' || err.code === 'PAYMENT_USER_MISSING'
        ? 'approved_account_unavailable'
        : 'approved_reconciliation_required', {
      applyErrorCode: err.message || 'unknown',
      reconciliationCandidate: true,
      reconciliationRetryAtMs: Date.now(),
      providerCancellationRequired: err.code === 'ACCOUNT_DELETION_IN_PROGRESS' || err.code === 'PAYMENT_USER_MISSING'
    });
    logger.error('payment.apply_failed_reconciliation_required', {
      uid: verifiedUid,
      orderId,
      amount: safeAmount,
      reconciliationSource,
      err
    });
    return res.status(Number(err.status) || 503).json({
      error: '결제 승인은 확인됐습니다. 잠시 후 다시 시도하면 크레딧이 자동 반영됩니다.',
      code: 'PAYMENT_APPLY_PENDING',
      retryable: true
    });
  }

  logger.info(granted.deduped ? 'payment.confirm_deduped' : 'payment.confirmed', {
    uid: verifiedUid,
    orderId,
    amount: safeAmount,
    credits: granted.totalCredits,
    baseCredits: granted.baseCredits,
    packageBonusCredits: granted.packageBonusCredits,
    eventBonusCredits: granted.eventBonusCredits,
    creditEventId: granted.eventId,
    reconciliationSource
  });

  if (!granted.deduped) {
    discord.paymentDone({
      uid: verifiedUid,
      amount: safeAmount,
      credits: granted.totalCredits,
      kind: '크레딧 충전',
      name: verifiedCustomerEmail
    });
    void metaConversions.sendPurchase({
      eventId: `purchase_${orderId}`,
      orderId,
      value: safeAmount,
      itemId: `credits_${safeAmount}`,
      email: verifiedCustomerEmail,
      externalId: verifiedUid,
      clientIp: realClientIp(req),
      userAgent: req.get('user-agent'),
      context: meta
    });
  }

  return res.json(creditPaymentResponse(granted));
}

router.post('/checkout-context', async (req, res) => {
  const idToken = bearerToken(req);
  if (!idToken) return res.status(401).json({ error: '로그인이 필요합니다.' });

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(idToken, { checkRevoked: true });
    uid = decoded.uid;
    setLogContext({ uid });
  } catch (e) {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인해 주세요.' });
  }

  try {
    const [userSnap, orders] = await Promise.all([
      db.collection('users').doc(uid).get(),
      getCreditOrdersForUser(uid)
    ]);
    const user = userSnap.exists ? userSnap.data() : {};
    const latestOrder = [...orders]
      .filter(order => isRetainedPaidOrder(order) && getCreditProduct(Number(order.amount)))
      .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))[0] || null;
    let creditLots = [];
    if (latestOrder?.id) {
      const lotSnap = await db.collection('users').doc(uid).collection('creditLots').doc(latestOrder.id).get();
      if (lotSnap.exists) creditLots = [{ id: lotSnap.id, ...lotSnap.data() }];
    }
    return res.json({
      ok: true,
      ...buildCheckoutContext({
        uid,
        credits: user.credits,
        orders,
        creditLots,
        conversion: user.conversion || {}
      })
    });
  } catch (err) {
    logger.error('payment.checkout_context_failed', { uid, err });
    return res.status(500).json({ error: '결제 혜택을 불러오지 못했어요.' });
  }
});

// 결제창을 열기 전에 orderId를 인증된 UID에 선점한다. 성공 콜백 URL을 다른
// 계정이 먼저 제출해도 이미 고정된 소유자와 일치하지 않으면 confirm 단계가 409로
// 끝난다. PAYMENT_PRECLAIM_REQUIRED=1은 프런트 전환 완료 뒤 legacy callback 생성을
// 완전히 닫는 배포 스위치다.
router.post('/prepare-payment', async (req, res) => {
  const idToken = bearerToken(req);
  if (!idToken) return res.status(401).json({ error: '로그인이 필요합니다.' });
  let uid;
  try {
    uid = (await verifyFirebaseIdToken(idToken, { checkRevoked: true })).uid;
    setLogContext({ uid });
  } catch {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인해 주세요.' });
  }
  const body = req.body || {};
  const orderId = String(body.orderId || '');
  const amount = Number(body.amount);
  const purchaseKind = String(body.purchaseKind || 'credit_package');
  const sourceOrderId = String(body.sourceOrderId || '').trim();
  if (!validateConfirmInput({ paymentKey: 'checkout-preclaim', orderId }).ok || !Number.isInteger(amount)) {
    return res.status(400).json({ error: '주문 정보가 올바르지 않습니다.' });
  }
  let product = null;
  try {
    if (purchaseKind === STARTER_UPGRADE.kind) {
      if (amount !== STARTER_UPGRADE.additionalAmount
        || !validateConfirmInput({ paymentKey: 'upgrade-source', orderId: sourceOrderId }).ok) {
        return res.status(400).json({ error: '업그레이드 주문 정보가 올바르지 않습니다.' });
      }
      const sourceSnapshot = await db.collection('orders').doc(sourceOrderId).get();
      const sourceOrder = sourceSnapshot.exists
        ? { id: sourceSnapshot.id, ...sourceSnapshot.data() }
        : null;
      if (!sourceOrder || sourceOrder.uid !== uid) {
        return res.status(409).json({ error: '업그레이드할 스타터 주문을 확인할 수 없습니다.', code: 'UPGRADE_SOURCE_UNAVAILABLE' });
      }
      product = buildStarterUpgradeGrant(sourceOrder);
    } else if (purchaseKind === 'credit_package') {
      product = getCreditProduct(amount);
    }
    if (!product?.paidCredits) {
      return res.status(400).json({ error: '유효하지 않은 결제 상품입니다.' });
    }
    const prepared = await preclaimPaymentIntent({ orderId, uid, amount, creditGrant: product });
    return res.json({
      ok: true,
      orderId,
      amount,
      expiresAtMs: prepared.expiresAtMs,
      ownerClaimVersion: 2
    });
  } catch (error) {
    const status = Number(error.status) || 503;
    logger[status < 500 ? 'warn' : 'error']('payment.checkout_preclaim_failed', {
      uid,
      orderId,
      amount,
      code: error.code || error.message,
      err: error
    });
    return res.status(status).json({
      error: status === 409
        ? '이 주문번호는 이미 다른 결제 시도에 연결되어 있습니다.'
        : '결제를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      ...(error.code ? { code: error.code } : {})
    });
  }
});

router.post('/confirm-payment', handleCreditPaymentConfirmation);

// 승인 응답 유실·Firestore 적용 실패는 server-only intent에 남는다. 외부 스케줄러가
// 이 엔드포인트를 호출하면 결제사 주문을 다시 조회해 중복 지급 없이 적용하거나,
// 탈퇴 경합으로 지급할 수 없는 승인건은 결제사에서 자동 취소한다.
router.post('/cron/reconcile-payments', async (req, res) => {
  const auth = verifyCronRequest(req, { allowBearer: true, allowBody: false, allowQuery: false });
  if (auth.reason === 'secret_missing') {
    logger.error('payment.reconciliation_cron_secret_missing');
    return res.status(503).json({ error: 'cron disabled: CRON_SECRET is not configured' });
  }
  if (!auth.ok) {
    logger.warn('payment.reconciliation_cron_auth_rejected', authLogFields(auth));
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const result = await reconcilePendingApprovedPayments({ limit: req.body?.limit });
    logger.info('payment.reconciliation_cron_completed', result);
    return res.json({ ok: true, ...result });
  } catch (error) {
    logger.error('payment.reconciliation_cron_failed', { err: error });
    return res.status(500).json({ error: 'payment reconciliation failed' });
  }
});

// --- 환불 시스템 ---
// ADMIN_UIDS / verifyToken은 config.js에서 import (coupon.js와 단일 진실 원천 공유)

// 컬렉션 분기 헬퍼
function getOrderRef(kind, orderId) {
  return kind === 'subscription'
    ? db.collection('subscriptionOrders').doc(orderId)
    : db.collection('orders').doc(orderId);
}

async function requireAdmin(req, res) {
  const idToken = bearerToken(req);
  const adminUid = await verifyAdminToken(idToken);
  if (adminUid === false) {
    res.status(403).json({ error: '관리자 권한이 없습니다.' });
    return null;
  }
  if (!adminUid) {
    res.status(401).json({ error: '로그인이 필요합니다.' });
    return null;
  }
  setLogContext({ uid: adminUid, actorUid: adminUid });
  return adminUid;
}

function timestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (ts._seconds) return ts._seconds * 1000;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serializeCreditHistoryDoc(docSnap, userByUid) {
  const h = docSnap.data() || {};
  const uid = docSnap.ref.parent.parent ? docSnap.ref.parent.parent.id : '';
  const u = userByUid[uid] || {};
  return {
    id: docSnap.id,
    uid,
    type: h.type || null,
    mode: h.mode || null,
    evidence: typeof h.evidence === 'boolean' ? h.evidence : null,
    fallback: h.fallback === true,
    textLength: Number(h.textLength) || null,
    used: Number(h.used) || 0,
    amount: Number(h.amount) || 0,
    remaining: Number(h.remaining) || 0,
    plan: h.plan || null,
    orderId: h.orderId || null,
    requestId: h.requestId || null,
    detail: h.detail || '',
    adminUid: h.adminUid || null,
    orphanDebitResolved: h.orphanDebitResolved === true,
    orphanDebitResolution: h.orphanDebitResolution || null,
    restoredCredits: Number(h.restoredCredits) || 0,
    restoredAtMs: timestampMs(h.restoredAt || h.resolvedAt),
    restoredBy: h.restoredBy || h.resolvedBy || null,
    restoreCreditHistoryId: h.restoreCreditHistoryId || h.resolveCreditHistoryId || null,
    restoreReason: h.restoreReason || h.resolveReason || '',
    originalCreditHistoryId: h.originalCreditHistoryId || null,
    restoredDebitId: h.restoredDebitId || null,
    createdAtMs: timestampMs(h.createdAt),
    userName: u.name || '알 수 없음',
    userEmail: u.email || ''
  };
}

function serializeOrderDoc(docSnap, kind) {
  const o = docSnap.data() || {};
  const refundWindow = refundWindowState(o, kind);
  return {
    id: docSnap.id,
    kind,
    uid: o.uid || '',
    status: o.status || '',
    amount: Number(o.amount) || 0,
    safeCredits: Number(o.safeCredits ?? o.credits) || 0,
    totalGrantedCredits: Number(o.totalGrantedCredits ?? o.safeCredits ?? o.credits) || 0,
    paidCredits: Number(o.paidCredits) || 0,
    baseCredits: Number(o.baseCredits) || 0,
    bonusCredits: Number(o.bonusCredits ?? o.promotionalBonusCredits) || 0,
    packageBonusCredits: Number(o.packageBonusCredits) || 0,
    eventBonusCredits: Number(o.eventBonusCredits) || 0,
    firstPurchaseBonusCredits: Number(o.firstPurchaseBonusCredits) || 0,
    creditGrantPolicyVersion: o.creditGrantPolicyVersion || '',
    offerPolicyVersion: o.offerPolicyVersion || '',
    purchaseKind: o.purchaseKind || 'credit_package',
    sourceOrderId: o.sourceOrderId || null,
    upgradeOrderId: o.upgradeOrderId || null,
    activeUpgradeOrderId: o.activeUpgradeOrderId || null,
    creditLotPolicyVersion: o.creditLotPolicyVersion || '',
    refundPaidCreditsRemaining: Number.isFinite(Number(o.refundPaidCreditsRemaining))
      ? Math.max(0, Math.floor(Number(o.refundPaidCreditsRemaining)))
      : null,
    refundEventBonusCreditsRemaining: Number.isFinite(Number(o.refundEventBonusCreditsRemaining))
      ? Math.max(0, Math.floor(Number(o.refundEventBonusCreditsRemaining)))
      : null,
    refundCreditBasis: o.refundCreditBasis || '',
    refundCreditSettlementClosed: o.refundCreditSettlementClosed === true,
    refundPolicyVersion: o.refundPolicyVersion || '',
    refundPolicyVersionAtPurchase: o.refundPolicyVersionAtPurchase || '',
    refundWindowBasis: o.refundWindowBasis || '',
    refundWindowStartsAtMs: refundWindow.paidAtMs,
    refundWindowEndsAtMs: refundWindow.deadlineMs,
    refundEligibilityReviewRequired: o.refundEligibilityReviewRequired === true,
    refundEligibilityReviewed: o.refundEligibilityReviewed === true,
    refundEligibilityExceptionCode: o.refundEligibilityExceptionCode || '',
    refundEligibilityReviewNote: o.refundEligibilityReviewNote || '',
    refundEligibilityReviewedBy: o.refundEligibilityReviewedBy || '',
    refundEligibilityReviewedAtMs: timestampMs(o.refundEligibilityReviewedAt),
    requestedRefundAmount: Number(o.requestedRefundAmount) || 0,
    requestedRefundCredits: Number(o.requestedRefundCredits) || 0,
    refundReservationState: o.refundReservationState || '',
    refundRequestSequence: Number(o.refundRequestSequence) || 0,
    tier: o.tier || null,
    paymentKey: (o.paymentKey || o.paymentKeyPresent) ? 'present' : null,
    cancelReason: o.cancelReason || '',
    rejectReason: o.rejectReason || '',
    refundAmount: Number(o.refundAmount) || 0,
    refundedAmount: Number(o.refundedAmount) || 0,
    refundedCredits: Number(o.refundedCredits) || 0,
    createdAtMs: timestampMs(o.createdAt || o.approvedAt || o.requestedAt),
    refundRequestedAtMs: timestampMs(o.refundRequestedAt),
    refundedAtMs: timestampMs(o.refundedAt),
    customerEmail: o.customerEmail || ''
  };
}

function serializeUserDoc(userSnap) {
  const u = userSnap.data() || {};
  const sub = u.subscription || null;
  const coupon = u.coupon || null;
  return {
    uid: userSnap.id,
    email: u.email || '',
    name: u.name || '',
    credits: Number(u.credits) || 0,
    plan: u.plan || 'free',
    createdAtMs: timestampMs(u.createdAt),
    subscription: sub ? {
      tier: sub.tier || null,
      status: sub.status || null,
      nextBillingAtMs: timestampMs(sub.nextBillingAt),
      cancelledAtMs: timestampMs(sub.cancelledAt)
    } : null,
    coupon: coupon ? {
      tier: coupon.tier || null,
      remaining: Number(coupon.remaining) || 0,
      granted: Number(coupon.granted) || 0,
      used: Number(coupon.used) || 0
    } : null
  };
}

function serializeSavedHistoryDoc(docSnap) {
  const h = docSnap.data() || {};
  return {
    id: docSnap.id,
    type: h.type || null,
    credits: Number(h.credits) || 0,
    savedBy: h.savedBy || null,
    createdAtMs: timestampMs(h.createdAt),
    inputLength: typeof h.inputText === 'string' ? h.inputText.length : 0,
    outputLength: typeof h.outputText === 'string' ? h.outputText.length : 0
  };
}

function splitAdminCreditHistory(creditHistory, orders) {
  const ledgerRows = Array.isArray(creditHistory) ? creditHistory : [];
  const chargeRows = Array.isArray(orders) ? orders : [];
  return {
    creditUsageHistory: ledgerRows.filter(row => row && row.type !== 'charge'),
    chargeHistory: chargeRows
  };
}

function auditNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function creditRequestId(row) {
  if (row && row.requestId) return String(row.requestId);
  if (row && typeof row.id === 'string' && row.id.startsWith('req_')) return row.id.slice(4);
  return '';
}

const RESULT_DEBIT_TYPES = new Set(['humanize', 'restructure']);
const HISTORY_MATCH_WINDOW_MS = 60 * 60 * 1000;
const DUPLICATE_HINT_WINDOW_MS = 30 * 60 * 1000;
const MANUAL_RESTORE_HINT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function isAuditableResultDebit(row) {
  const type = String(row?.type || '');
  const requestId = creditRequestId(row);
  if (!RESULT_DEBIT_TYPES.has(type)) return false;
  if (type.endsWith('_restore')) return false;
  if (requestId.includes(':')) return false; // chunk calls are saved as one combined result by the client.
  return auditNumber(row?.used) > 0;
}

function buildCreditAudit({ user, orders, creditHistory, savedHistory }) {
  const sortedCreditHistory = [...(creditHistory || [])].sort((a, b) => auditNumber(a.createdAtMs) - auditNumber(b.createdAtMs));
  const sortedSavedHistory = [...(savedHistory || [])].sort((a, b) => auditNumber(a.createdAtMs) - auditNumber(b.createdAtMs));
  const chargeTimes = sortedCreditHistory
    .filter(h => h.type === 'charge' && auditNumber(h.amount) > 0 && auditNumber(h.createdAtMs) > 0)
    .map(h => auditNumber(h.createdAtMs));
  const orderTimes = (orders || [])
    .filter(o => o.kind === 'order' && auditNumber(o.amount) > 0 && auditNumber(o.safeCredits) > 0 && auditNumber(o.createdAtMs) > 0)
    .map(o => auditNumber(o.createdAtMs));
  const paidStartCandidates = [...chargeTimes, ...orderTimes].filter(Boolean);
  const firstPaidAtMs = paidStartCandidates.length ? Math.min(...paidStartCandidates) : 0;
  const ledgerDelta = sortedCreditHistory.reduce((sum, h) => sum + creditLedgerDelta(h), 0);
  const currentCredits = auditNumber(user?.credits);
  const debits = sortedCreditHistory.filter(isAuditableResultDebit);
  const resolutionByDebitId = new Map();
  const resolutionByRequestId = new Map();
  sortedCreditHistory.forEach(h => {
    const debitId = h.restoredDebitId || h.originalCreditHistoryId;
    const isResolution = h.orphanDebitResolved || String(h.type || '').endsWith('_restore');
    if (!isResolution) return;
    if (debitId) resolutionByDebitId.set(String(debitId), h);
    const requestId = creditRequestId(h);
    if (requestId) resolutionByRequestId.set(requestId, h);
  });
  const manualRestoreHints = sortedCreditHistory.filter(h => {
    if (h.type !== 'admin_adjust') return false;
    if (auditNumber(h.amount) <= 0) return false;
    const detail = String(h.detail || '');
    return /결과|저장|차감|복구|환급|환불|중복/.test(detail);
  });
  const savedMatches = sortedSavedHistory.filter(h => auditNumber(h.credits) > 0);
  const usedSavedIds = new Set();
  const matchedDebits = [];
  const orphanDebits = [];

  debits.forEach(debit => {
    const debitCredits = auditNumber(debit.used);
    const debitMs = auditNumber(debit.createdAtMs);
    const requestId = creditRequestId(debit);
    let matched = null;
    let matchReason = '';

    if (requestId) {
      matched = savedMatches.find(h => h.id === requestId);
      if (matched) matchReason = 'requestId';
    }

    if (!matched && debitMs > 0) {
      const candidates = savedMatches
        .filter(h => {
          if (usedSavedIds.has(h.id)) return false;
          if (auditNumber(h.credits) !== debitCredits) return false;
          const savedMs = auditNumber(h.createdAtMs);
          if (!savedMs) return false;
          if (savedMs < debitMs - 60 * 1000) return false;
          if (savedMs > debitMs + HISTORY_MATCH_WINDOW_MS) return false;
          return !h.type || !debit.type || h.type === debit.type || (debit.type === 'restructure' && h.type === 'humanize');
        })
        .sort((a, b) => Math.abs(auditNumber(a.createdAtMs) - debitMs) - Math.abs(auditNumber(b.createdAtMs) - debitMs));
      matched = candidates[0] || null;
      if (matched) matchReason = 'nearHistorySameCredits';
    }

    if (matched) {
      usedSavedIds.add(matched.id);
      matchedDebits.push({
        id: debit.id,
        type: debit.type,
        used: debitCredits,
        requestId: requestId || null,
        createdAtMs: debitMs,
        historyId: matched.id,
        matchReason
      });
      return;
    }

    const duplicatePeer = debits.find(other => {
      if (other.id === debit.id) return false;
      if (other.type !== debit.type) return false;
      if (auditNumber(other.used) !== debitCredits) return false;
      const otherMs = auditNumber(other.createdAtMs);
      return debitMs > 0 && otherMs > 0 && Math.abs(otherMs - debitMs) <= DUPLICATE_HINT_WINDOW_MS;
    });
    const resolution = resolutionByDebitId.get(debit.id) || (requestId ? resolutionByRequestId.get(requestId) : null) || null;
    const handled = !!(
      debit.orphanDebitResolved ||
      debit.restoredAtMs ||
      debit.restoreCreditHistoryId ||
      resolution
    );
    const restoredCredits = Math.max(
      auditNumber(debit.restoredCredits),
      resolution ? Math.abs(auditNumber(resolution.used)) : 0,
      resolution ? Math.max(0, auditNumber(resolution.amount)) : 0
    );
    const manualRestoreHint = handled ? null : manualRestoreHints
      .filter(h => {
        const adjustMs = auditNumber(h.createdAtMs);
        if (!debitMs || !adjustMs || adjustMs < debitMs - 60 * 1000) return false;
        if (adjustMs > debitMs + MANUAL_RESTORE_HINT_WINDOW_MS) return false;
        return auditNumber(h.amount) === debitCredits;
      })
      .sort((a, b) => auditNumber(a.createdAtMs) - auditNumber(b.createdAtMs))[0] || null;
    orphanDebits.push({
      id: debit.id,
      type: debit.type,
      mode: debit.mode || null,
      used: debitCredits,
      textLength: auditNumber(debit.textLength) || null,
      requestId: requestId || null,
      createdAtMs: debitMs,
      isAfterFirstPaid: !!(firstPaidAtMs && debitMs >= firstPaidAtMs),
      duplicateHint: !!duplicatePeer,
      handled,
      status: handled ? 'resolved' : 'open',
      resolution: debit.orphanDebitResolution || resolution?.orphanDebitResolution || (restoredCredits > 0 ? 'credit_restore' : null),
      restoredCredits,
      restoredAtMs: auditNumber(debit.restoredAtMs) || auditNumber(resolution?.createdAtMs),
      restoredBy: debit.restoredBy || resolution?.adminUid || null,
      restoreCreditHistoryId: debit.restoreCreditHistoryId || resolution?.id || null,
      restoreReason: debit.restoreReason || resolution?.detail || '',
      manualRestoreHint: manualRestoreHint ? {
        id: manualRestoreHint.id,
        amount: auditNumber(manualRestoreHint.amount),
        createdAtMs: auditNumber(manualRestoreHint.createdAtMs),
        detail: manualRestoreHint.detail || ''
      } : null
    });
  });

  const openOrphanDebits = orphanDebits.filter(h => !h.handled);
  const handledOrphanDebits = orphanDebits.filter(h => h.handled);
  const paidOrphanDebits = openOrphanDebits.filter(h => h.isAfterFirstPaid);
  const prePaidOrphanDebits = openOrphanDebits.filter(h => !h.isAfterFirstPaid);
  const skippedChunkDebits = sortedCreditHistory.filter(h => {
    const requestId = creditRequestId(h);
    return RESULT_DEBIT_TYPES.has(String(h.type || '')) && auditNumber(h.used) > 0 && requestId.includes(':');
  });

  return {
    checkedAtMs: Date.now(),
    currentCredits,
    ledgerDelta,
    balanceOffset: currentCredits - ledgerDelta,
    firstPaidAtMs,
    debitCount: debits.length,
    debitCredits: debits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    savedHistoryCount: savedMatches.length,
    savedHistoryCredits: savedMatches.reduce((sum, h) => sum + auditNumber(h.credits), 0),
    matchedDebitCount: matchedDebits.length,
    matchedDebitCredits: matchedDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    totalOrphanDebitCount: orphanDebits.length,
    totalOrphanDebitCredits: orphanDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    orphanDebitCount: openOrphanDebits.length,
    orphanDebitCredits: openOrphanDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    paidOrphanDebitCount: paidOrphanDebits.length,
    paidOrphanDebitCredits: paidOrphanDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    prePaidOrphanDebitCount: prePaidOrphanDebits.length,
    prePaidOrphanDebitCredits: prePaidOrphanDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    handledOrphanDebitCount: handledOrphanDebits.length,
    handledOrphanDebitCredits: handledOrphanDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    skippedChunkDebitCount: skippedChunkDebits.length,
    skippedChunkDebitCredits: skippedChunkDebits.reduce((sum, h) => sum + auditNumber(h.used), 0),
    orphanDebits: [...orphanDebits].reverse()
  };
}

async function getUserMap(uids) {
  const unique = Array.from(new Set(uids.filter(Boolean)));
  if (!unique.length) return {};
  const refs = unique.map(uid => db.collection('users').doc(uid));
  const snaps = await db.getAll(...refs);
  const out = {};
  snaps.forEach((snap, idx) => {
    out[unique[idx]] = snap.exists ? snap.data() : {};
  });
  return out;
}

async function loadCreditHistoryViaCollectionGroup(maxRows) {
  const snap = await db.collectionGroup('creditHistory')
    .orderBy('createdAt', 'desc')
    .limit(maxRows)
    .get();
  const uids = snap.docs.map(d => d.ref.parent.parent && d.ref.parent.parent.id);
  const userByUid = await getUserMap(uids);
  return snap.docs.map(d => serializeCreditHistoryDoc(d, userByUid));
}

async function loadCreditHistoryViaUsers(maxRows) {
  const usersSnap = await db.collection('users').get();
  const perUserLimit = Math.min(Math.max(maxRows, 1), 200);
  const rows = [];
  const userByUid = {};
  await Promise.all(usersSnap.docs.map(async userDoc => {
    const uid = userDoc.id;
    userByUid[uid] = userDoc.data() || {};
    const histSnap = await userDoc.ref.collection('creditHistory')
      .orderBy('createdAt', 'desc')
      .limit(perUserLimit)
      .get();
    histSnap.docs.forEach(d => rows.push(serializeCreditHistoryDoc(d, userByUid)));
  }));
  rows.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return rows.slice(0, maxRows);
}

async function getAdminCreditHistory(maxRows) {
  try {
    return {
      source: 'collectionGroup',
      rows: await loadCreditHistoryViaCollectionGroup(maxRows)
    };
  } catch (err) {
    logger.warn('admin.credit_history_collection_group_failed_fallback', { err });
    return {
      source: 'usersFallback',
      rows: await loadCreditHistoryViaUsers(maxRows)
    };
  }
}

async function loadAdminUserBundle(uid) {
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return null;

  const [creditSnap, subSnap, histSnap, savedHistSnap] = await Promise.all([
    db.collection('orders').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('subscriptionOrders').where('uid', '==', uid).limit(100).get(),
    userRef.collection('creditHistory').orderBy('createdAt', 'desc').get(),
    userRef.collection('history').orderBy('createdAt', 'desc').get()
  ]);

  const orders = [
    ...creditSnap.docs.map(d => serializeOrderDoc(d, 'order')),
    ...subSnap.docs.map(d => serializeOrderDoc(d, 'subscription'))
  ];
  orders.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

  const userByUid = { [uid]: userSnap.data() || {} };
  const creditHistory = histSnap.docs.map(d => serializeCreditHistoryDoc(d, userByUid));
  // 관리자 화면에서는 실제 사용·조정 원장과 결제 주문을 서로 다른 목록으로 보여준다.
  // charge 원장은 orders와 같은 충전을 중복 표현하므로 사용 내역에서는 제외한다.
  const { creditUsageHistory, chargeHistory } = splitAdminCreditHistory(creditHistory, orders);
  const savedHistory = savedHistSnap.docs.map(serializeSavedHistoryDoc);
  const user = serializeUserDoc(userSnap);
  const creditAudit = buildCreditAudit({ user, orders, creditHistory, savedHistory });

  return {
    user,
    orders,
    chargeHistory,
    creditHistory,
    creditUsageHistory,
    creditAudit
  };
}

async function findUserByQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return null;
  if (!q.includes('/')) {
    const directSnap = await db.collection('users').doc(q).get();
    if (directSnap.exists) return directSnap.id;
  }

  const email = q.toLowerCase();
  const emailSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!emailSnap.empty) return emailSnap.docs[0].id;

  const exactEmailSnap = await db.collection('users').where('email', '==', q).limit(1).get();
  if (!exactEmailSnap.empty) return exactEmailSnap.docs[0].id;

  return null;
}

// ★ C-04: 환불에 쓸 paymentKey는 서버전용 paymentSecrets에서 읽는다(없으면 기존 주문 문서 폴백 — 무파손 전환).
async function readPaymentKey(orderId, order) {
  try {
    const s = await db.collection('paymentSecrets').doc(orderId).get();
    if (s.exists && s.data().paymentKey) return s.data().paymentKey;
  } catch (e) { logger.warn('payment.secret_read_failed', { orderId, err: e && e.message }); }
  if (order && order.paymentKey) return order.paymentKey;

  // Early production orders predate paymentSecrets. Recover the key from the provider by
  // server-owned orderId so an admin refund does not depend on a client-readable legacy field.
  const basicToken = tossBasicToken();
  if (!basicToken) return null;
  const lookup = await queryTossOrder({ basicToken, orderId });
  const paymentKey = lookup.response?.ok
    && lookup.result?.orderId === orderId
    && typeof lookup.result?.paymentKey === 'string'
    ? lookup.result.paymentKey
    : null;
  if (!paymentKey) {
    logger.warn('payment.secret_recovery_unavailable', {
      orderId,
      providerStatus: lookup.response?.status || null,
      provider: providerResultSummary(lookup.result),
      networkError: lookup.networkError || null
    });
    return null;
  }
  try {
    await db.collection('paymentSecrets').doc(orderId).set({
      paymentKey,
      paymentKeyHash: paymentKeyHash(paymentKey),
      recoveredFromProvider: true,
      recoveredAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    logger.error('payment.secret_recovery_persist_failed', { orderId, err });
  }
  return paymentKey;
}

function resumableCreditRefund(order) {
  const value = order?.refundProcessing;
  if (!value || value.kind !== 'credit' || typeof value.operationId !== 'string') return null;
  const operation = {
    operationId: value.operationId,
    priorRefundedAmount: Math.max(0, Math.floor(Number(value.priorRefundedAmount) || 0)),
    priorRefundedCredits: Math.max(0, Math.floor(Number(value.priorRefundedCredits) || 0)),
    refundAmount: Math.max(0, Math.floor(Number(value.refundAmount) || 0)),
    creditsToDeduct: Math.max(0, Math.floor(Number(value.creditsToDeduct) || 0)),
    targetRefundedAmount: Math.max(0, Math.floor(Number(value.targetRefundedAmount) || 0)),
    targetRefundedCredits: Math.max(0, Math.floor(Number(value.targetRefundedCredits) || 0)),
    previousRefundPolicyVersion: typeof value.previousRefundPolicyVersion === 'string' ? value.previousRefundPolicyVersion : null,
    previousRefundCreditBasis: typeof value.previousRefundCreditBasis === 'string' ? value.previousRefundCreditBasis : null,
    previousRefundCreditSettlementClosed: value.previousRefundCreditSettlementClosed === true,
    previousOrderStatus: typeof value.previousOrderStatus === 'string' ? value.previousOrderStatus : null,
    // phase가 없는 과거 refundProcessing은 이미 결제사 취소 단계에 들어간 상태다.
    phase: value.phase === 'requested_reserved' ? 'requested_reserved' : 'provider_canceling',
    creditLotPolicyVersion: value.creditLotPolicyVersion === CREDIT_LOT_POLICY_VERSION
      ? CREDIT_LOT_POLICY_VERSION
      : null,
    reservedPaidCredits: Math.max(0, Math.floor(Number(value.reservedPaidCredits) || 0)),
    reservedBonusCredits: Math.max(0, Math.floor(Number(value.reservedBonusCredits) || 0))
  };
  if (!operation.refundAmount
      || operation.targetRefundedAmount !== operation.priorRefundedAmount + operation.refundAmount
      || operation.targetRefundedCredits !== operation.priorRefundedCredits + operation.creditsToDeduct) {
    return null;
  }
  return operation;
}

function creditRefundProcessing(operation, now, phase = 'provider_canceling') {
  return {
    kind: 'credit',
    phase: phase === 'requested_reserved' ? 'requested_reserved' : 'provider_canceling',
    operationId: operation.operationId,
    priorRefundedAmount: operation.priorRefundedAmount,
    priorRefundedCredits: operation.priorRefundedCredits,
    refundAmount: operation.refundAmount,
    creditsToDeduct: operation.creditsToDeduct,
    targetRefundedAmount: operation.targetRefundedAmount,
    targetRefundedCredits: operation.targetRefundedCredits,
    previousRefundPolicyVersion: operation.previousRefundPolicyVersion || null,
    previousRefundCreditBasis: operation.previousRefundCreditBasis || null,
    previousRefundCreditSettlementClosed: operation.previousRefundCreditSettlementClosed === true,
    previousOrderStatus: operation.previousOrderStatus || null,
    creditLotPolicyVersion: operation.creditLotPolicyVersion || null,
    reservedPaidCredits: Math.max(0, Math.floor(Number(operation.reservedPaidCredits) || 0)),
    reservedBonusCredits: Math.max(0, Math.floor(Number(operation.reservedBonusCredits) || 0)),
    startedAt: operation.startedAt || now,
    ...(phase === 'requested_reserved' ? { reservedAt: now } : { providerStartedAt: now })
  };
}

function creditLotMismatchError() {
  logger.error('credit_lot.inconsistent', { action: 'block_refund_and_reconcile' });
  return Object.assign(new Error('CREDIT_LOT_INCONSISTENT'), { status: 503, code: 'CREDIT_LOT_INCONSISTENT' });
}

function activeUpgradeRefundConflict(order) {
  const upgradeOrderId = String(order?.activeUpgradeOrderId || '');
  if (!upgradeOrderId) return null;
  return Object.assign(
    new Error('스탠다드 업그레이드 결제를 먼저 환불한 뒤 스타터 주문을 환불할 수 있습니다.'),
    {
      status: 409,
      code: 'UPGRADE_REFUND_ORDER_REQUIRED',
      upgradeOrderId
    }
  );
}

async function reserveCreditRefundCredits({
  transaction,
  orderRef,
  userRef,
  latestOrder,
  remainingOrderCredits,
  fieldValue = admin.firestore.FieldValue
}) {
  const userSnap = await transaction.get(userRef);
  if (!userSnap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const user = userSnap.data() || {};
  const prepared = calculateOrderCreditRefund({
    order: latestOrder,
    user,
    maxRefundableCredits: remainingOrderCredits
  });
  const { grant, wallet, calculation } = prepared;
  if (!wallet.consistent) throw creditLotMismatchError();
  const refundableCredits = calculation.refundableCredits;
  let lotRef = null;

  if (grant.usesTrackedLot) {
    lotRef = userRef.collection('creditLots').doc(orderRef.id);
    const lotSnap = await transaction.get(lotRef);
    const lot = lotSnap.exists ? (lotSnap.data() || {}) : null;
    if (!lot
      || lot.creditLotPolicyVersion !== CREDIT_LOT_POLICY_VERSION
      || lot.creditGrantPolicyVersion !== CREDIT_GRANT_POLICY_VERSION
      || Math.floor(Number(lot.refundPaidCreditsRemaining)) !== grant.remainingPaidCredits
      || Math.floor(Number(lot.refundEventBonusCreditsRemaining)) !== grant.remainingBonusCredits
      || wallet.tracked < refundableCredits
      || wallet.credits < refundableCredits) {
      throw creditLotMismatchError();
    }
  } else if (refundableCredits > wallet.untracked) {
    // A legacy/untracked refund must never consume balances owned by a v1 order.
    throw creditLotMismatchError();
  }

  if (refundableCredits > 0) {
    const userUpdate = { credits: wallet.credits - refundableCredits };
    if (grant.usesTrackedLot) {
      userUpdate.creditLotV1Balance = wallet.tracked - refundableCredits;
      transaction.update(lotRef, {
        refundPaidCreditsRemaining: 0,
        refundEventBonusCreditsRemaining: 0,
        active: false,
        creditLotUpdatedAt: fieldValue.serverTimestamp()
      });
    }
    transaction.update(userRef, userUpdate);
  }

  return {
    ...prepared,
    refundableCredits,
    orderLotUpdate: grant.usesTrackedLot ? {
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      creditLotActive: false,
      creditLotUpdatedAt: fieldValue.serverTimestamp()
    } : {},
    processingLotFields: grant.usesTrackedLot ? {
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      reservedPaidCredits: grant.remainingPaidCredits,
      reservedBonusCredits: grant.remainingBonusCredits
    } : {}
  };
}

async function restoreCreditRefundReservationInTransaction({
  transaction,
  orderRef,
  userRef,
  latestOrder,
  operationId,
  accountClaimRef = null,
  restoreReason = 'provider_cancel_failed',
  orderUpdate = {},
  fieldValue = admin.firestore.FieldValue
}) {
  const processing = resumableCreditRefund(latestOrder);
  if (!processing || processing.operationId !== operationId) {
    const alreadyRestored = latestOrder?.refundReservationState === 'restored'
      && latestOrder?.refundReservationOperationId === operationId;
    if (alreadyRestored && accountClaimRef) {
      transaction.set(
        accountClaimRef,
        paymentAccountClaimPatch({
          uid: userRef.id,
          lane: 'activeCreditRefunds',
          id: orderRef.id,
          status: 'restored',
          operationId,
          active: false
        }),
        { merge: true }
      );
    }
    return { restored: false, alreadyRestored };
  }

  const userSnap = await transaction.get(userRef);
  if (!userSnap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const user = userSnap.data() || {};
  const wallet = creditWalletBalances(user);
  if (!wallet.consistent) throw creditLotMismatchError();
  const usesTrackedLot = processing.creditLotPolicyVersion === CREDIT_LOT_POLICY_VERSION;
  const lotRef = usesTrackedLot ? userRef.collection('creditLots').doc(orderRef.id) : null;
  const lotSnap = lotRef ? await transaction.get(lotRef) : null;
  if (usesTrackedLot) {
    const lot = lotSnap?.exists ? (lotSnap.data() || {}) : null;
    if (!lot
      || lot.creditLotPolicyVersion !== CREDIT_LOT_POLICY_VERSION
      || Math.max(0, Math.floor(Number(lot.refundPaidCreditsRemaining) || 0)) !== 0
      || Math.max(0, Math.floor(Number(lot.refundEventBonusCreditsRemaining) || 0)) !== 0) {
      throw creditLotMismatchError();
    }
  }

  const restoredCredits = processing.creditsToDeduct;
  const userUpdate = { credits: wallet.credits + restoredCredits };
  const now = fieldValue.serverTimestamp();
  if (usesTrackedLot) {
    const restoredPaid = processing.reservedPaidCredits;
    const restoredBonus = processing.reservedBonusCredits;
    if (restoredPaid + restoredBonus !== restoredCredits) throw creditLotMismatchError();
    userUpdate.creditLotV1Balance = wallet.tracked + restoredCredits;
    transaction.update(lotRef, {
      refundPaidCreditsRemaining: restoredPaid,
      refundEventBonusCreditsRemaining: restoredBonus,
      active: restoredCredits > 0,
      creditLotUpdatedAt: now
    });
  }
  transaction.update(userRef, userUpdate);
  transaction.update(orderRef, {
    refundAmount: processing.priorRefundedAmount > 0
      ? processing.priorRefundedAmount
      : fieldValue.delete(),
    refundedAmount: processing.priorRefundedAmount > 0
      ? processing.priorRefundedAmount
      : fieldValue.delete(),
    refundedCredits: processing.priorRefundedCredits > 0
      ? processing.priorRefundedCredits
      : fieldValue.delete(),
    refundUsedPaidCredits: fieldValue.delete(),
    refundablePaidCredits: fieldValue.delete(),
    recoveredBonusCredits: fieldValue.delete(),
    refundPolicyVersion: processing.previousRefundPolicyVersion || fieldValue.delete(),
    refundCreditBasis: processing.previousRefundCreditBasis || fieldValue.delete(),
    refundCreditSettlementClosed: processing.previousRefundCreditSettlementClosed || fieldValue.delete(),
    ...(usesTrackedLot ? {
      refundPaidCreditsRemaining: processing.reservedPaidCredits,
      refundEventBonusCreditsRemaining: processing.reservedBonusCredits,
      creditLotActive: restoredCredits > 0,
      creditLotUpdatedAt: now
    } : {}),
    refundReservationState: 'restored',
    refundReservationOperationId: operationId,
    refundReservationRestoreReason: restoreReason,
    refundReservationRestoredAt: now,
    refundProcessing: fieldValue.delete(),
    ...(processing.previousOrderStatus && !Object.prototype.hasOwnProperty.call(orderUpdate, 'status')
      ? { status: processing.previousOrderStatus }
      : {}),
    ...orderUpdate
  });
  if (accountClaimRef) {
    transaction.set(
      accountClaimRef,
      paymentAccountClaimPatch({
        uid: userRef.id,
        lane: 'activeCreditRefunds',
        id: orderRef.id,
        status: 'restored',
        operationId,
        active: false
      }),
      { merge: true }
    );
  }
  return { restored: true, alreadyRestored: false, restoredCredits };
}

async function compensateCreditRefundReservation({
  orderRef,
  userRef,
  operationId,
  restoreReason = 'provider_cancel_failed',
  orderUpdate = {}
}) {
  return db.runTransaction(async transaction => {
    const latestOrderSnapshot = await transaction.get(orderRef);
    if (!latestOrderSnapshot.exists) return { restored: false, alreadyRestored: false };
    return restoreCreditRefundReservationInTransaction({
      transaction,
      orderRef,
      userRef,
      latestOrder: latestOrderSnapshot.data() || {},
      operationId,
      accountClaimRef: db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(userRef.id),
      restoreReason,
      orderUpdate
    });
  });
}

async function processRefund({ orderRef, orderSnap, kind, adminUid, reason, mode, customAmount }) {
  const order = orderSnap.data();
  if (kind === 'order') {
    const upgradeConflict = activeUpgradeRefundConflict(order);
    if (upgradeConflict) throw upgradeConflict;
  }
  const paymentKey = await readPaymentKey(orderRef.id, order);   // ★ C-04
  if (!['paid', 'refund_requested', 'refund_rejected', 'partially_refunded'].includes(order.status)) {
    throw Object.assign(new Error('환불할 수 없는 주문 상태입니다. 현재: ' + order.status), { status: 400 });
  }
  if (!paymentKey) {
    throw Object.assign(new Error('paymentKey가 없어 환불할 수 없습니다. (이전 결제건)'), { status: 400 });
  }

  const userRef = db.collection('users').doc(order.uid);
  const deletionJobRef = db.collection('accountDeletionJobs').doc(order.uid);
  const accountClaimRef = db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(order.uid);
  const basicToken = tossBasicToken();
  if (!basicToken) {
    throw Object.assign(new Error('결제 서버 설정이 완료되지 않았습니다.'), { status: 503, code: 'TOSS_SECRET_MISSING' });
  }
  const tossUrl = `https://api.tosspayments.com/v1/payments/${paymentKey}/cancel`;
  const cancelReason = String(reason || order.cancelReason || '관리자 직접 환불').trim();

  if (kind === 'subscription') {
    const subscriptionRefundAmount = Number(order.amount) || 0;
    const operationId = refundOperationId(orderRef.id, 0, subscriptionRefundAmount, 0);
    const tossRes = await outboundFetch('toss', tossUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': refundIdempotencyKey(operationId)
      },
      body: JSON.stringify({ cancelReason })
    });
    const tossResult = await tossRes.json();
    if (!tossRes.ok) {
      throw Object.assign(new Error('토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')), {
        status: tossRes.status,
        toss: tossResult
      });
    }

    await db.runTransaction(async (t) => {
      const [latestOrderSnapshot, latestUserSnapshot] = await Promise.all([
        t.get(orderRef),
        t.get(userRef)
      ]);
      if (!latestOrderSnapshot.exists) {
        throw Object.assign(new Error('ORDER_NOT_FOUND'), { status: 404, code: 'ORDER_NOT_FOUND' });
      }
      const latestOrder = latestOrderSnapshot.data() || {};
      const latestUser = latestUserSnapshot.exists ? latestUserSnapshot.data() || {} : {};
      const generationContext = currentSubscriptionRefundContext(
        latestUser,
        latestOrder,
        refundPaidAtMs(latestOrder, 'subscription'),
        orderRef.id
      );
      const generationClosed = latestUserSnapshot.exists && generationContext.sameCycle;
      const now = admin.firestore.FieldValue.serverTimestamp();
      t.update(orderRef, {
        status: 'refunded',
        cancelReason,
        refundedAt: now,
        refundedBy: adminUid,
        subscriptionGenerationClosed: generationClosed
      });
      if (generationClosed) {
        t.update(userRef, {
          'subscription.status': 'refunded',
          'subscription.cancelledAt': now,
          'plan': 'free',
          'coupon.remaining': 0,
          'coupon.used': 0
        });
      }
      if (latestUserSnapshot.exists) {
        t.set(userRef.collection('couponHistory').doc(cancellationLedgerId(orderRef.id, subscriptionRefundAmount)), {
          type: 'refund',
          tier: latestOrder.tier,
          amount: 0,
          remaining: generationClosed ? 0 : Math.max(0, Math.floor(Number(latestUser.coupon?.remaining) || 0)),
          orderId: orderRef.id,
          detail: '관리자 직접 환불',
          generationClosed,
          createdAt: now
        }, { merge: true });
      }
    });
    return {
      refundAmount: subscriptionRefundAmount,
      refundedCredits: 0,
      message: '정기결제 환불이 완료되었습니다.'
    };
  }

  const orderAmount = parseInt(order.amount, 10);
  const safeCreditsTotal = creditRefundGrant(order).totalCredits;
  if (!Number.isFinite(orderAmount) || orderAmount <= 0 ||
      !Number.isFinite(safeCreditsTotal) || safeCreditsTotal <= 0) {
    throw Object.assign(new Error('주문 데이터가 올바르지 않아 환불 계산이 불가합니다.'), { status: 400 });
  }

  // 환불 모드: 'remaining'(미사용분 비례·기본) | 'full'(잔액 전부) | 'custom'(금액 직접 입력)
  // 누적 부분환불 지원: 이미 환불된 금액/크레딧을 빼고 "남은 잔액" 기준으로 계산한다.
  const refundMode = mode === 'policy'
    ? 'remaining'
    : (['remaining', 'full', 'custom'].includes(mode) ? mode : 'remaining');
  const reqAmount = parseInt(customAmount, 10);
  if (refundMode === 'custom' && (!Number.isFinite(reqAmount) || reqAmount <= 0)) {
    throw Object.assign(new Error('직접 입력 환불 금액은 1원 이상이어야 합니다.'), { status: 400 });
  }

  let refundAmount, refundableCredits;
  let priorRefundedAmount, priorRefundedCredits, cumulativeRefundAmount, cumulativeRefundCredits, operationId;
  let previousRefundPolicyVersion, previousRefundCreditBasis, previousRefundCreditSettlementClosed;
  try {
    const result = await db.runTransaction(async (transaction) => {
      const [latestOrderSnapshot, deletionJobSnapshot] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(deletionJobRef)
      ]);
      if (!latestOrderSnapshot.exists) throw new Error('ORDER_NOT_FOUND');
      if (deletionJobSnapshot.exists && accountDeletionBlocksPayment(deletionJobSnapshot.data())) {
        throw paymentAccountUnavailableError();
      }
      const latestOrder = latestOrderSnapshot.data() || {};
      const latestGrant = creditRefundGrant(latestOrder);
      const resumable = resumableCreditRefund(latestOrder);
      if (resumable) {
        if (resumable.phase === 'requested_reserved') {
          transaction.update(orderRef, {
            'refundProcessing.phase': 'provider_canceling',
            'refundProcessing.providerStartedAt': admin.firestore.FieldValue.serverTimestamp(),
            refundReservationState: 'provider_canceling'
          });
        }
        transaction.set(accountClaimRef, paymentAccountClaimPatch({
          uid: order.uid,
          lane: 'activeCreditRefunds',
          id: orderRef.id,
          status: 'provider_canceling',
          operationId: resumable.operationId,
          active: true
        }), { merge: true });
        return {
          ...resumable,
          amount: resumable.refundAmount,
          creditsToDeduct: resumable.creditsToDeduct,
          fully: resumable.targetRefundedAmount >= orderAmount,
          resumed: true
        };
      }
      if (!['paid', 'refund_requested', 'refund_rejected', 'partially_refunded'].includes(latestOrder.status)) {
        throw Object.assign(new Error('REFUND_STATE_CHANGED'), { latestStatus: latestOrder.status || 'unknown' });
      }
      const upgradeConflict = activeUpgradeRefundConflict(latestOrder);
      if (upgradeConflict) throw upgradeConflict;

      const priorAmount = Math.max(0, Math.floor(Number(latestOrder.refundedAmount ?? latestOrder.refundAmount) || 0));
      const priorCredits = Math.max(0, Math.floor(Number(latestOrder.refundedCredits) || 0));
      const remainingMoney = orderAmount - priorAmount;
      const remainingOrderCredits = Math.max(0, safeCreditsTotal - priorCredits);
      if (remainingMoney <= 0) throw new Error('ALREADY_REFUNDED');
      if (refundMode !== 'remaining') {
        throw new Error('POLICY_MODE_ONLY');
      }
      if (latestGrant.usesBaseCreditPolicy && (priorAmount > 0 || latestOrder.refundCreditSettlementClosed === true)) {
        throw new Error('REFUND_SETTLED');
      }
      if (refundMode === 'custom' && reqAmount > remainingMoney) {
        throw Object.assign(new Error('INVALID_CUSTOM_AMOUNT'), { remainingMoney });
      }

      const reserved = await reserveCreditRefundCredits({
        transaction,
        orderRef,
        userRef,
        latestOrder,
        remainingOrderCredits
      });
      const policyCalculation = reserved.calculation;
      const amount = Math.min(remainingMoney, policyCalculation.refundAmount);
      const creditsToDeduct = reserved.refundableCredits;
      if (amount <= 0 || creditsToDeduct <= 0) throw new Error('NO_REFUNDABLE');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');

      const newRefundedAmount = priorAmount + amount;
      const newRefundedCredits = priorCredits + creditsToDeduct;
      const directAttemptSequence = Math.max(
        0,
        Math.floor(Number(latestOrder.refundDirectAttemptSequence) || 0)
      ) + 1;
      const nextOperationId = refundOperationId(
        orderRef.id,
        priorAmount,
        amount,
        creditsToDeduct,
        `direct-${directAttemptSequence}`
      );
      const operation = {
        operationId: nextOperationId,
        priorRefundedAmount: priorAmount,
        priorRefundedCredits: priorCredits,
        refundAmount: amount,
        creditsToDeduct,
        targetRefundedAmount: newRefundedAmount,
        targetRefundedCredits: newRefundedCredits,
        previousRefundPolicyVersion: latestOrder.refundPolicyVersion || null,
        previousRefundCreditBasis: latestOrder.refundCreditBasis || null,
        previousRefundCreditSettlementClosed: latestOrder.refundCreditSettlementClosed === true,
        previousOrderStatus: latestOrder.status || 'paid',
        ...reserved.processingLotFields
      };
      transaction.update(orderRef, {
        cancelReason,
        refundMode,
        refundAmount: newRefundedAmount,    // 누적(레거시 표시 호환)
        refundedAmount: newRefundedAmount,  // 누적 환불 금액
        refundedCredits: newRefundedCredits, // 누적 환불 크레딧
        refundPolicyVersion: refundPolicyVersionForOrder(latestOrder, latestGrant.usesBaseCreditPolicy),
        refundCreditBasis: latestGrant.refundCreditBasis,
        refundUsedPaidCredits: policyCalculation ? policyCalculation.usedPaidCredits : admin.firestore.FieldValue.delete(),
        refundablePaidCredits: policyCalculation ? policyCalculation.refundablePaidCredits : admin.firestore.FieldValue.delete(),
        recoveredBonusCredits: policyCalculation ? policyCalculation.recoveredBonusCredits : admin.firestore.FieldValue.delete(),
        refundCreditSettlementClosed: policyCalculation ? true : admin.firestore.FieldValue.delete(),
        refundDirectAttemptSequence: directAttemptSequence,
        ...reserved.orderLotUpdate,
        refundProcessing: creditRefundProcessing(operation, admin.firestore.FieldValue.serverTimestamp())
      });
      transaction.set(accountClaimRef, paymentAccountClaimPatch({
        uid: order.uid,
        lane: 'activeCreditRefunds',
        id: orderRef.id,
        status: 'provider_canceling',
        operationId: nextOperationId,
        active: true
      }), { merge: true });
      return {
        ...operation,
        amount,
        creditsToDeduct,
        fully: newRefundedAmount >= orderAmount,
        recoveredBonusCredits: policyCalculation ? policyCalculation.recoveredBonusCredits : 0,
        resumed: false
      };
    });
    refundAmount = result.amount;
    refundableCredits = result.creditsToDeduct;
    priorRefundedAmount = result.priorRefundedAmount;
    priorRefundedCredits = result.priorRefundedCredits;
    cumulativeRefundAmount = result.targetRefundedAmount;
    cumulativeRefundCredits = result.targetRefundedCredits;
    operationId = result.operationId;
    previousRefundPolicyVersion = result.previousRefundPolicyVersion;
    previousRefundCreditBasis = result.previousRefundCreditBasis;
    previousRefundCreditSettlementClosed = result.previousRefundCreditSettlementClosed === true;
  } catch (e) {
    if (e.message === 'NO_REFUNDABLE') {
      throw Object.assign(new Error('기준 크레딧 사용량을 반영하면 환불 가능 금액이 없습니다.'), { status: 400 });
    }
    if (e.message === 'INVALID_AMOUNT') {
      throw Object.assign(new Error('환불 금액 계산 오류'), { status: 400 });
    }
    if (e.message === 'ALREADY_REFUNDED') {
      throw Object.assign(new Error('이미 전액 환불된 주문입니다.'), { status: 400 });
    }
    if (e.message === 'POLICY_MODE_ONLY') {
      throw Object.assign(new Error('크레딧 주문은 정책에 따라 계산된 환불만 사용할 수 있습니다.'), { status: 400 });
    }
    if (e.message === 'REFUND_SETTLED') {
      throw Object.assign(new Error('이 주문의 기준 크레딧 환불 정산은 이미 완료됐습니다.'), { status: 400 });
    }
    if (e.message === 'REFUND_STATE_CHANGED') {
      throw Object.assign(new Error(`환불 처리 중 주문 상태가 변경됐습니다. 현재: ${e.latestStatus || 'unknown'}`), {
        status: 409,
        code: 'REFUND_STATE_CHANGED'
      });
    }
    if (e.message === 'INVALID_CUSTOM_AMOUNT') {
      throw Object.assign(new Error(`직접 입력 환불 금액은 환불 가능액(${Number(e.remainingMoney || 0).toLocaleString('ko-KR')}원) 이하여야 합니다.`), { status: 400 });
    }
    throw e;
  }

  const cancellation = await requestTossCancel({
    tossUrl,
    basicToken,
    operationId,
    cancelReason,
    cancelAmount: refundAmount
  });
  const tossRes = cancellation.response;
  const tossResult = cancellation.result;
  let cancellationLookup = null;
  if (!tossRes?.ok) {
    cancellationLookup = await queryTossOrder({ basicToken, orderId: orderRef.id });
  }
  const cancellationState = tossCancellationState({
    response: tossRes,
    lookup: cancellationLookup,
    targetRefundedAmount: cumulativeRefundAmount
  });
  if (cancellationState.unknown) {
    logger.error('refund.toss_cancel_status_unknown', {
      orderId: orderRef.id,
      uid: order.uid,
      operationId,
      status: tossRes?.status || null,
      networkError: cancellation.networkError?.message || null,
      toss: providerResultSummary(tossResult),
      lookupStatus: cancellationLookup?.response?.status || null,
      providerCanceledAmount: cancellationState.lookupCanceledAmount
    });
    throw Object.assign(new Error('결제사 환불 결과 확인이 지연되고 있습니다. 같은 주문을 다시 처리하면 중복 차감 없이 이어서 확인합니다.'), {
      status: 502,
      code: 'REFUND_STATUS_UNKNOWN',
      retryable: true
    });
  }
  if (!cancellationState.confirmed) {
    try {
      await compensateCreditRefundReservation({
        orderRef,
        userRef,
        operationId,
        restoreReason: 'provider_cancel_failed',
        orderUpdate: {
          refundApprovalFailedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      });
    } catch (compErr) {
      logger.error('refund.compensation_failed_manual_action', {
        orderId: orderRef.id, uid: order.uid, refundableCredits, refundAmount, compErr
      });
    }
    throw Object.assign(new Error('토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')), {
      status: tossRes.status,
      toss: providerResultSummary(tossResult)
    });
  }

  const finalized = await db.runTransaction(async (transaction) => {
    const latestOrderSnapshot = await transaction.get(orderRef);
    if (!latestOrderSnapshot.exists) throw Object.assign(new Error('ORDER_NOT_FOUND'), { status: 404 });
    const latestOrder = latestOrderSnapshot.data() || {};
    const decision = creditRefundFinalizeDecision(latestOrder, {
      operationId,
      targetRefundedAmount: cumulativeRefundAmount,
      orderAmount
    });
    const userSnap = await transaction.get(userRef);
    const sourceOrderRef = latestOrder.purchaseKind === STARTER_UPGRADE.kind && latestOrder.sourceOrderId
      ? db.collection('orders').doc(latestOrder.sourceOrderId)
      : null;
    const sourceOrderSnap = sourceOrderRef ? await transaction.get(sourceOrderRef) : null;
    const remainingCredits = userSnap.exists ? (Number(userSnap.data().credits) || 0) : 0;
    if (!decision.ok) {
      throw Object.assign(new Error('REFUND_FINALIZE_CONFLICT'), { status: 409 });
    }
    if (decision.alreadyFinalized) {
      const finalRefundedCredits = Math.max(
        0,
        Math.floor(Number(latestOrder.refundedCredits) || 0),
        Math.floor(Number(cumulativeRefundCredits) || 0)
      );
      if (latestOrder.refundProcessing
        || latestOrder.refundReservationState !== 'settled'
        || Number(latestOrder.refundedCredits) !== finalRefundedCredits) {
        transaction.update(orderRef, {
          refundedCredits: finalRefundedCredits,
          refundReservationState: 'settled',
          refundReservationOperationId: operationId,
          refundReservationSettledAt: admin.firestore.FieldValue.serverTimestamp(),
          refundProcessing: admin.firestore.FieldValue.delete()
        });
      }
      transaction.set(accountClaimRef, paymentAccountClaimPatch({
        uid: order.uid,
        lane: 'activeCreditRefunds',
        id: orderRef.id,
        status: 'settled',
        operationId,
        active: false
      }), { merge: true });
      return {
        alreadyFinalized: true,
        refundedAmount: decision.finalRefundedAmount,
        fullyRefunded: decision.fullyRefunded
      };
    }
    const finalRefundedAmount = decision.finalRefundedAmount;
    const fullyRefunded = decision.fullyRefunded;
    transaction.update(orderRef, {
      status: fullyRefunded ? 'refunded' : 'partially_refunded',
      refundAmount: finalRefundedAmount,
      refundedAmount: finalRefundedAmount,
      refundedCredits: Math.max(0, Math.floor(Number(cumulativeRefundCredits) || 0)),
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundedBy: adminUid,
      refundReservationState: 'settled',
      refundReservationOperationId: operationId,
      refundReservationSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      refundProcessing: admin.firestore.FieldValue.delete()
    });
    transaction.set(accountClaimRef, paymentAccountClaimPatch({
      uid: order.uid,
      lane: 'activeCreditRefunds',
      id: orderRef.id,
      status: 'settled',
      operationId,
      active: false
    }), { merge: true });
    if (fullyRefunded && sourceOrderRef && sourceOrderSnap?.exists
      && sourceOrderSnap.data()?.activeUpgradeOrderId === orderRef.id) {
      transaction.update(sourceOrderRef, {
        activeUpgradeOrderId: admin.firestore.FieldValue.delete(),
        upgradeRefundedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    transaction.set(userRef.collection('creditHistory').doc(cancellationLedgerId(orderRef.id, finalRefundedAmount)), {
      type: 'refund',
      used: 0,
      amount: -refundableCredits,
      remaining: remainingCredits,
      orderId: orderRef.id,
      detail: fullyRefunded ? '관리자 직접 환불' : '관리자 부분 환불',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { alreadyFinalized: false, refundedAmount: finalRefundedAmount, fullyRefunded };
  });

  return {
    refundAmount,
    refundedCredits: refundableCredits,
    fullyRefunded: finalized.fullyRefunded,
    message: finalized.fullyRefunded ? '크레딧 결제 환불이 완료되었습니다.' : '부분 환불이 완료되었습니다.'
  };
}

// 관리자: 전체 사용자 크레딧 내역
router.post('/admin/credit-history', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;

  const rawLimit = parseInt(req.body && req.body.limit, 10);
  const maxRows = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 1000;

  try {
    const { rows, source } = await getAdminCreditHistory(maxRows);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const dailyUsed = {};
    rows.forEach(h => {
      if (!h.createdAtMs || h.createdAtMs < sevenDaysAgo.getTime()) return;
      if (h.type === 'charge' || h.type === 'refund') return;
      const day = new Date(h.createdAtMs).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
      dailyUsed[day] = (dailyUsed[day] || 0) + (Number(h.used) || 0);
    });

    logger.info('admin.credit_history_loaded', { adminUid, count: rows.length, source });
    res.json({ ok: true, history: rows, dailyUsed, source });
  } catch (err) {
    logger.error('admin.credit_history_failed', { adminUid, err });
    res.status(500).json({ error: '전체 사용자 내역을 불러오지 못했습니다.' });
  }
});

// detect requestId의 서버 계약은 `:`를 허용한다(analyze/detectreport와 동일).
// Firestore 경로 구분자인 `/`는 계속 금지해 body 식별자가 다른 문서 경로로
// 해석될 여지는 없앤다.
const ADMIN_LEDGER_TASK_ID_RE = /^[A-Za-z0-9_:-]{1,180}$/u;
const ADMIN_LEDGER_TASK_CODE_RE = /^[a-z][a-z0-9_.:-]{0,79}$/u;

function adminLedgerTaskCodes(value, maxItems = 30) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => ADMIN_LEDGER_TASK_CODE_RE.test(item)))]
    .slice(0, maxItems);
}

function adminLedgerTaskFinite(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function classifyAdminLedgerTask(ledger) {
  const row = ledger && typeof ledger === 'object' ? ledger : {};
  const type = String(row.type || '').trim().toLowerCase();
  const requestId = String(row.requestId || '').trim();
  if (!requestId) return { available: false, reason: 'legacy_missing_request_id' };
  if (!ADMIN_LEDGER_TASK_ID_RE.test(requestId)) return { available: false, reason: 'invalid_request_id' };
  if (type === 'humanize_refine'
      || (['humanize', 'restructure'].includes(type) && /_refine\d+$/u.test(requestId))) {
    return { available: false, reason: 'refine_result_not_archived' };
  }
  if (type === 'humanize' || type === 'restructure') {
    const match = /^job_([A-Za-z0-9_-]{1,128})$/u.exec(requestId);
    return match
      ? { available: true, kind: 'transform', historyId: requestId, jobId: match[1] }
      : { available: false, reason: 'transform_request_id_mismatch' };
  }
  if (type === 'detect') {
    if (/^job_/u.test(requestId)) return { available: false, reason: 'detect_request_id_mismatch' };
    return { available: true, kind: 'detect', historyId: requestId, jobId: null };
  }
  return { available: false, reason: 'non_task_ledger' };
}

function serializeAdminLedgerTaskLedger(id, uid, ledger) {
  const row = ledger && typeof ledger === 'object' ? ledger : {};
  return {
    id,
    uid,
    type: row.type || null,
    mode: row.mode || null,
    used: Number(row.used) || 0,
    amount: Number(row.amount) || 0,
    remaining: Number(row.remaining) || 0,
    textLength: Number(row.textLength) || null,
    requestId: row.requestId || null,
    createdAtMs: timestampMs(row.createdAt)
  };
}

function serializeAdminLedgerTaskEngineMeta(value) {
  const meta = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {
    schemaVersion: adminLedgerTaskFinite(meta.schemaVersion),
    engineVersion: typeof meta.engineVersion === 'string' ? meta.engineVersion.slice(0, 80) : '',
    requestedMode: typeof meta.requestedMode === 'string' ? meta.requestedMode.slice(0, 40) : '',
    effectiveMode: typeof meta.effectiveMode === 'string' ? meta.effectiveMode.slice(0, 40) : '',
    documentProfile: typeof meta.documentProfile === 'string' ? meta.documentProfile.slice(0, 80) : '',
    profileConfidence: adminLedgerTaskFinite(meta.profileConfidence),
    deliveryDecision: typeof meta.deliveryDecision === 'string' ? meta.deliveryDecision.slice(0, 80) : '',
    deliveryReasonCodes: adminLedgerTaskCodes(meta.deliveryReasonCodes),
    effectStatus: typeof meta.effectStatus === 'string' ? meta.effectStatus.slice(0, 40) : '',
    effectNoticeCodes: adminLedgerTaskCodes(meta.effectNoticeCodes),
    billingDisposition: typeof meta.billingDisposition === 'string' ? meta.billingDisposition.slice(0, 80) : '',
    semanticJudgeRan: typeof meta.semanticJudgeRan === 'boolean' ? meta.semanticJudgeRan : null,
    repairCount: adminLedgerTaskFinite(meta.repairCount),
    chunkCount: adminLedgerTaskFinite(meta.chunkCount),
    fallbackCount: adminLedgerTaskFinite(meta.fallbackCount),
    editableChunkCount: adminLedgerTaskFinite(meta.editableChunkCount),
    approvedModelChunkCount: adminLedgerTaskFinite(meta.approvedModelChunkCount),
    modelFailureChunkCount: adminLedgerTaskFinite(meta.modelFailureChunkCount),
    structureSignaturePass: typeof meta.structureSignaturePass === 'boolean' ? meta.structureSignaturePass : null,
    sectionPathErrorCount: adminLedgerTaskFinite(meta.sectionPathErrorCount),
    lengthRatio: adminLedgerTaskFinite(meta.lengthRatio),
    substantiveEditRatio: adminLedgerTaskFinite(meta.substantiveEditRatio),
    structuralChangedSentenceRatio: adminLedgerTaskFinite(meta.structuralChangedSentenceRatio),
    rhetoricalRemediationCoverage: adminLedgerTaskFinite(meta.rhetoricalRemediationCoverage),
    humanizationDepthPass: typeof meta.humanizationDepthPass === 'boolean' ? meta.humanizationDepthPass : null,
    koreanRefinementPass: typeof meta.koreanRefinementPass === 'boolean' ? meta.koreanRefinementPass : null,
    koreanRefinementIssueCodes: adminLedgerTaskCodes(meta.koreanRefinementIssueCodes),
    sourceReviewWarningCodes: adminLedgerTaskCodes(meta.sourceReviewWarningCodes),
    finalSourceIntegrityRestoreCodes: adminLedgerTaskCodes(meta.finalSourceIntegrityRestoreCodes),
    unsupportedSpecificityPass: typeof meta.unsupportedSpecificityPass === 'boolean'
      ? meta.unsupportedSpecificityPass
      : null,
    unsupportedSpecificityIssueCount: adminLedgerTaskFinite(meta.unsupportedSpecificityIssueCount),
    unsupportedSpecificityResidualCount: adminLedgerTaskFinite(meta.unsupportedSpecificityResidualCount),
    unsupportedSpecificityRestoreCount: adminLedgerTaskFinite(meta.unsupportedSpecificityRestoreCount),
    unsupportedSpecificityRemovalCount: adminLedgerTaskFinite(meta.unsupportedSpecificityRemovalCount),
    estimatedUsd: adminLedgerTaskFinite(meta.estimatedUsd)
  };
  return Object.fromEntries(Object.entries(out).filter(([, item]) => item !== '' && item !== null));
}

function serializeAdminLedgerTaskArchive(value, jobId) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const createdAtNumber = adminLedgerTaskFinite(row.createdAt);
  const createdAtTimestamp = row.createdAt == null ? null : timestampMs(row.createdAt);
  const out = {
    jobId,
    status: typeof row.status === 'string' ? row.status.slice(0, 40) : '',
    stage: typeof row.stage === 'string' ? row.stage.slice(0, 80) : '',
    engineVersion: typeof row.engineVersion === 'string' ? row.engineVersion.slice(0, 80) : '',
    requestedMode: typeof row.requestedMode === 'string' ? row.requestedMode.slice(0, 40) : '',
    effectiveMode: typeof row.effectiveMode === 'string' ? row.effectiveMode.slice(0, 40) : '',
    documentProfile: typeof row.documentProfile === 'string' ? row.documentProfile.slice(0, 80) : '',
    billingDisposition: typeof row.billingDisposition === 'string' ? row.billingDisposition.slice(0, 80) : '',
    qualityStatus: typeof row.qualityStatus === 'string' ? row.qualityStatus.slice(0, 40) : '',
    qualityWarningCodes: adminLedgerTaskCodes(row.qualityWarningCodes),
    koreanRefinementIssueCodes: adminLedgerTaskCodes(row.koreanRefinementIssueCodes),
    sourceReviewWarningCodes: adminLedgerTaskCodes(row.sourceReviewWarningCodes),
    finalSourceIntegrityRestoreCodes: adminLedgerTaskCodes(row.finalSourceIntegrityRestoreCodes),
    effectStatus: typeof row.effectStatus === 'string' ? row.effectStatus.slice(0, 40) : '',
    effectNoticeCodes: adminLedgerTaskCodes(row.effectNoticeCodes),
    deliveryDecision: typeof row.deliveryDecision === 'string' ? row.deliveryDecision.slice(0, 80) : '',
    deliveryReasonCodes: adminLedgerTaskCodes(row.deliveryReasonCodes),
    createdAtMs: createdAtNumber ?? (createdAtTimestamp || null),
    updatedAtMs: adminLedgerTaskFinite(row.updatedAtMs),
    processingDurationMs: adminLedgerTaskFinite(row.processingDurationMs),
    totalDurationMs: adminLedgerTaskFinite(row.totalDurationMs),
    textLength: adminLedgerTaskFinite(row.textLength),
    resultLength: adminLedgerTaskFinite(row.resultLength),
    estimatedUsd: adminLedgerTaskFinite(row.estimatedUsd),
    substantiveEditRatio: adminLedgerTaskFinite(row.substantiveEditRatio),
    editableChunkCount: adminLedgerTaskFinite(row.editableChunkCount),
    approvedModelChunkCount: adminLedgerTaskFinite(row.approvedModelChunkCount),
    modelFailureChunkCount: adminLedgerTaskFinite(row.modelFailureChunkCount),
    structureSignaturePass: typeof row.structureSignaturePass === 'boolean' ? row.structureSignaturePass : null,
    sectionPathErrorCount: adminLedgerTaskFinite(row.sectionPathErrorCount),
    unsupportedSpecificityPass: typeof row.unsupportedSpecificityPass === 'boolean'
      ? row.unsupportedSpecificityPass
      : null,
    unsupportedSpecificityIssueCount: adminLedgerTaskFinite(row.unsupportedSpecificityIssueCount),
    unsupportedSpecificityResidualCount: adminLedgerTaskFinite(row.unsupportedSpecificityResidualCount),
    unsupportedSpecificityRestoreCount: adminLedgerTaskFinite(row.unsupportedSpecificityRestoreCount),
    unsupportedSpecificityRemovalCount: adminLedgerTaskFinite(row.unsupportedSpecificityRemovalCount)
  };
  return Object.fromEntries(Object.entries(out).filter(([, item]) => item !== '' && item !== null));
}

function serializeAdminLedgerTaskHistory(id, history) {
  const row = history && typeof history === 'object' ? history : {};
  const asText = value => (typeof value === 'string' ? value : (value ? JSON.stringify(value) : ''));
  const calibration = row.probabilityCalibration && typeof row.probabilityCalibration === 'object'
    ? {
        applied: row.probabilityCalibration.applied === true,
        match: typeof row.probabilityCalibration.match === 'string' ? row.probabilityCalibration.match.slice(0, 40) : '',
        matchSimilarity: adminLedgerTaskFinite(row.probabilityCalibration.matchSimilarity),
        matchLengthRatio: adminLedgerTaskFinite(row.probabilityCalibration.matchLengthRatio)
      }
    : null;
  return {
    id,
    type: row.type || 'unknown',
    status: typeof row.status === 'string' ? row.status.slice(0, 40) : '',
    mode: row.mode || null,
    createdAtMs: timestampMs(row.createdAt),
    credits: Number(row.credits) || 0,
    billingDisposition: row.billingDisposition || '',
    qualityStatus: row.qualityStatus || '',
    qualityWarningCodes: adminLedgerTaskCodes(row.qualityWarningCodes),
    effectStatus: typeof row.effectStatus === 'string' ? row.effectStatus.slice(0, 40) : '',
    effectNoticeCodes: adminLedgerTaskCodes(
      row.effectNoticeCodes || (Array.isArray(row.effectNotices)
        ? row.effectNotices.map(item => item && item.code)
        : [])
    ),
    deliveryDecision: typeof row.deliveryDecision === 'string' ? row.deliveryDecision.slice(0, 80) : '',
    sourceReviewWarningCodes: adminLedgerTaskCodes(row.sourceReviewWarningCodes),
    probability: typeof row.probability === 'number' ? row.probability : null,
    rawProbability: typeof row.rawProbability === 'number' ? row.rawProbability : null,
    ...(calibration ? { probabilityCalibration: Object.fromEntries(Object.entries(calibration).filter(([, item]) => item !== '' && item !== null)) } : {}),
    summary: asText(row.summary),
    detail: asText(row.detail),
    inputText: String(row.inputText || ''),
    outputText: String(row.outputText || ''),
    humanSummary: asText(row.humanSummary),
    humanDetail: asText(row.humanDetail),
    savedBy: row.savedBy || null
  };
}

function serializeAdminLedgerTaskOps(id, value) {
  const row = value && typeof value === 'object' ? value : {};
  return {
    id,
    event: typeof row.event === 'string' ? row.event.slice(0, 160) : 'operation',
    severity: typeof row.severity === 'string' ? row.severity.slice(0, 20) : '',
    domain: typeof row.domain === 'string' ? row.domain.slice(0, 40) : '',
    message: typeof row.message === 'string' ? row.message.slice(0, 600) : '',
    code: typeof row.code === 'string' ? row.code.slice(0, 80) : '',
    stage: typeof row.stage === 'string' ? row.stage.slice(0, 80) : '',
    reason: typeof row.reason === 'string' ? row.reason.slice(0, 300) : '',
    createdAtMs: adminLedgerTaskFinite(row.createdMs),
    count: Math.max(1, Number(row.count) || 1),
    acked: row.acked === true
  };
}

async function loadAdminLedgerTaskOps({ uid, link, firestore = db } = {}) {
  const lookups = [];
  if (link?.jobId) lookups.push(['jobId', link.jobId]);
  if (link?.historyId) lookups.push(['requestId', link.historyId]);
  if (!lookups.length) return { status: 'empty', items: [] };
  try {
    // equality+createdMs orderBy는 별도 복합 인덱스를 요구할 수 있다. 작업별
    // 로그는 30일 TTL과 1분 병합이 적용되므로 일치 문서를 모두 받은 뒤
    // 정렬해야, Firestore의 기본 문서 ID 순서에 의해 최신 로그가 잘리는
    // 문제가 없다.
    const snapshots = await Promise.all(lookups.map(([field, value]) => (
      firestore.collection('opsLogs').where(field, '==', value).get()
    )));
    const byId = new Map();
    snapshots.forEach(snapshot => snapshot.forEach(doc => {
      const row = doc.data() || {};
      if (row.uid && String(row.uid) !== uid) return;
      byId.set(doc.id, serializeAdminLedgerTaskOps(doc.id, row));
    }));
    const items = [...byId.values()]
      .sort((left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0))
      .slice(0, 30);
    return { status: items.length ? 'ok' : 'empty', items };
  } catch (error) {
    logger.warn('admin.credit_history_task_ops_failed', {
      targetUid: uid,
      jobId: link?.jobId || '',
      requestId: link?.historyId || '',
      err: error,
      noAlert: true
    });
    return { status: 'error', items: [] };
  }
}

// 관리자 원장 행에서만 진입하는 작업 상세. 클라이언트가 requestId를 직접 지정하지 못하게
// 원장 문서를 먼저 읽고, 그 문서의 소유 경로와 requestId로 history/archive를 결합한다.
router.post('/admin/credit-history-item', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const uid = String(req.body && req.body.uid || '').trim();
  const creditHistoryId = String(req.body && req.body.creditHistoryId || '').trim();
  if (!ADMIN_LEDGER_TASK_ID_RE.test(uid) || !ADMIN_LEDGER_TASK_ID_RE.test(creditHistoryId)) {
    return res.status(400).json({ error: '유효한 uid와 creditHistoryId가 필요합니다.', code: 'INVALID_LEDGER_TASK_REFERENCE' });
  }
  try {
    const ledgerRef = db.collection('users').doc(uid).collection('creditHistory').doc(creditHistoryId);
    const ledgerSnap = await ledgerRef.get();
    if (!ledgerSnap.exists) return res.status(404).json({ error: '원장 내역을 찾을 수 없습니다.', code: 'LEDGER_NOT_FOUND' });
    const ledgerData = ledgerSnap.data() || {};
    const ledger = serializeAdminLedgerTaskLedger(creditHistoryId, uid, ledgerData);
    const link = classifyAdminLedgerTask(ledgerData);
    if (!link.available) {
      logger.info('admin.credit_history_task_unavailable', { adminUid, targetUid: uid, creditHistoryId, reason: link.reason });
      return res.json({ ok: true, available: false, reason: link.reason, ledger });
    }

    const historySnap = await db.collection('users').doc(uid).collection('history').doc(link.historyId).get();
    if (!historySnap.exists) {
      return res.json({ ok: true, available: false, reason: 'history_not_found', ledger, link });
    }
    const historyData = historySnap.data() || {};
    const expectedType = link.kind === 'detect' ? 'detect' : 'humanize';
    if (String(historyData.type || '') !== expectedType) {
      logger.warn('admin.credit_history_task_type_mismatch', { adminUid, targetUid: uid, creditHistoryId, expectedType });
      return res.status(409).json({ error: '원장과 작업 기록의 유형이 일치하지 않습니다.', code: 'TASK_TYPE_MISMATCH' });
    }

    let archive = null;
    if (link.kind === 'transform' && link.jobId) {
      const archiveSnap = await db.collection(JOB_ARCHIVE_COLLECTION).doc(link.jobId).get();
      if (archiveSnap.exists) {
        const archiveData = archiveSnap.data() || {};
        if (String(archiveData.uid || '') !== uid) {
          logger.warn('admin.credit_history_task_owner_mismatch', { adminUid, targetUid: uid, creditHistoryId, jobId: link.jobId });
          return res.status(409).json({ error: '원장과 작업 기록의 소유자가 일치하지 않습니다.', code: 'TASK_OWNER_MISMATCH' });
        }
        archive = serializeAdminLedgerTaskArchive(archiveData, link.jobId);
      }
    }

    const opsResult = await loadAdminLedgerTaskOps({ uid, link });
    logger.info('admin.credit_history_task_loaded', { adminUid, targetUid: uid, creditHistoryId, kind: link.kind });
    return res.json({
      ok: true,
      available: true,
      ledger,
      link,
      history: serializeAdminLedgerTaskHistory(link.historyId, historyData),
      engine: {
        engineMeta: serializeAdminLedgerTaskEngineMeta(historyData.engineMeta),
        archive
      },
      ops: opsResult.items,
      opsStatus: opsResult.status
    });
  } catch (err) {
    logger.error('admin.credit_history_task_failed', { adminUid, targetUid: uid, creditHistoryId, err });
    return res.status(500).json({ error: '원장 관련 작업을 불러오지 못했습니다.' });
  }
});

// 관리자: 특정 사용자의 작업 기록(users/{uid}/history) 목록 — 미리보기 + 커서 페이지네이션
function historyPreview(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
router.post('/admin/user-history', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    let uid = String((req.body && req.body.uid) || '').trim();
    if (!uid) uid = await findUserByQuery(req.body && req.body.query);
    if (!uid) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    const rawLimit = parseInt(req.body && req.body.limit, 10);
    const pageSize = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 20;
    const cursorMs = Number(req.body && req.body.cursorMs) || 0;

    let q = db.collection('users').doc(uid).collection('history')
      .orderBy('createdAt', 'desc');
    if (cursorMs > 0) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursorMs));
    const snap = await q.limit(pageSize + 1).get();

    const docs = snap.docs.slice(0, pageSize);
    const hasMore = snap.docs.length > pageSize;
    const items = docs.map(d => {
      const h = d.data() || {};
      return {
        id: d.id,
        type: h.type || 'unknown',
        createdAtMs: timestampMs(h.createdAt),
        credits: Number(h.credits) || 0,
        billingDisposition: h.billingDisposition || '',
        qualityStatus: h.qualityStatus || '',
        qualityWarningCodes: Array.isArray(h.qualityWarningCodes) ? h.qualityWarningCodes.slice(0, 20) : [],
        probability: typeof h.probability === 'number' ? h.probability : null,
        rawProbability: typeof h.rawProbability === 'number' ? h.rawProbability : null,
        calibrated: !!(h.probabilityCalibration && h.probabilityCalibration.applied),
        summaryPreview: historyPreview(h.summary, 160),
        inputPreview: historyPreview(h.inputText, 160),
        outputPreview: historyPreview(h.outputText, 160),
        inputLen: String(h.inputText || '').length,
        outputLen: String(h.outputText || '').length,
        savedBy: h.savedBy || null
      };
    });
    const last = docs[docs.length - 1];
    const nextCursorMs = hasMore && last ? timestampMs(last.data().createdAt) : null;
    logger.info('admin.user_history_loaded', { adminUid, targetUid: uid, count: items.length });
    res.json({ ok: true, uid, items, nextCursorMs });
  } catch (err) {
    logger.error('admin.user_history_failed', { adminUid, err });
    res.status(500).json({ error: '작업 기록을 불러오지 못했습니다.' });
  }
});

// 관리자: 작업 기록 1건 전체(원문·결과·탐지 상세) — 문의/환불 근거 확인용
router.post('/admin/user-history-item', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const uid = String((req.body && req.body.uid) || '').trim();
    const id = String((req.body && req.body.id) || '').trim();
    if (!uid || !id) return res.status(400).json({ error: 'uid와 id가 필요합니다.' });
    const snap = await db.collection('users').doc(uid).collection('history').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
    const h = snap.data() || {};
    const asText = (v) => (typeof v === 'string' ? v : (v ? JSON.stringify(v) : ''));
    logger.info('admin.user_history_item_loaded', { adminUid, targetUid: uid, id });
    res.json({ ok: true, item: {
      id,
      type: h.type || 'unknown',
      createdAtMs: timestampMs(h.createdAt),
      credits: Number(h.credits) || 0,
      billingDisposition: h.billingDisposition || '',
      qualityStatus: h.qualityStatus || '',
      qualityWarningCodes: Array.isArray(h.qualityWarningCodes) ? h.qualityWarningCodes.slice(0, 20) : [],
      probability: typeof h.probability === 'number' ? h.probability : null,
      rawProbability: typeof h.rawProbability === 'number' ? h.rawProbability : null,
      probabilityCalibration: h.probabilityCalibration || null,
      summary: asText(h.summary),
      detail: asText(h.detail),
      inputText: String(h.inputText || ''),
      outputText: String(h.outputText || ''),
      humanSummary: asText(h.humanSummary),
      humanDetail: asText(h.humanDetail),
      savedBy: h.savedBy || null
    } });
  } catch (err) {
    logger.error('admin.user_history_item_failed', { adminUid, err });
    res.status(500).json({ error: '기록 상세를 불러오지 못했습니다.' });
  }
});

// 관리자: 작업(transformJobs) 모니터 — 전체 사용자의 실패·중단·진행 작업을 상태·기간으로 조회.
// 영향 사용자 일괄 식별용. createdAt은 ms(number)로 저장되어 단일필드 범위쿼리(복합 인덱스 불필요).
// 장기 목록은 transformJobs(6시간 TTL)가 아니라 원문·결과가 빠진 transformJobArchive에서 조회한다.
const JOB_STATUS_SETS = {
  issues: ['error', 'blocked', 'cancelled', 'awaiting_approval'],
  active: ['queued', 'running', 'awaiting_approval'],
  all: null
};
function serializeAdminJobDoc(docSnap) {
  const j = docSnap.data() || {};
  const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const safeCodes = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => /^[a-z][a-z0-9_.:-]{1,79}$/u.test(item)))]
    .slice(0, 30);
  const safeCodeCountMap = (value) => {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [rawCode, rawCount] of Object.entries(value).slice(0, 30)) {
      const [code] = safeCodes([rawCode]);
      const count = Math.max(0, Math.trunc(Number(rawCount) || 0));
      if (code && count > 0) out[code] = count;
    }
    return out;
  };
  return {
    id: j.id || docSnap.id,
    uid: j.uid || '',
    status: j.status || '',
    stage: j.stage || '',
    mode: j.mode || '',
    adminHumanizeLab: j.adminHumanizeLab === true,
    needed: Number(j.needed) || 0,
    deducted: !!j.deducted,
    billingDisposition: j.billingDisposition || '',
    effectExpectation: j.effectExpectation || '',
    effectNoticeCode: j.effectNoticeCode || '',
    effectStatus: j.effectStatus || '',
    effectNoticeCodes: safeCodes(j.effectNoticeCodes),
    createdAtMs: Number(j.createdAt) || timestampMs(j.createdAt),
    updatedAtMs: Number(j.updatedAtMs) || 0,
    processingDurationMs: finiteOrNull(j.processingDurationMs),
    totalDurationMs: finiteOrNull(j.totalDurationMs),
    textLength: Number(j.textLength) || 0,
    resultLength: Number(j.resultLength) || 0,
    candidatesCount: Number(j.candidatesCount) || 0,
    error: j.error || '',
    gates: safeCodes(j.gates),
    qualityStatus: j.qualityStatus || '',
    qualityWarningCodes: safeCodes(j.qualityWarningCodes),
    engineVersion: j.engineVersion || '',
    requestedMode: j.requestedMode || j.mode || '',
    effectiveMode: j.effectiveMode || '',
    requestStrength: j.requestStrength || '',
    documentProfile: j.documentProfile || '',
    profileConfidence: finiteOrNull(j.profileConfidence),
    profileDecisionSource: j.profileDecisionSource || '',
    profileMargin: finiteOrNull(j.profileMargin),
    detectedDocumentProfile: j.detectedDocumentProfile || '',
    detectedProfileConfidence: finiteOrNull(j.detectedProfileConfidence),
    requestedDocumentProfile: j.requestedDocumentProfile || '',
    profileOverrideApplied: j.profileOverrideApplied === true,
    profileOverrideIgnoredReason: j.profileOverrideIgnoredReason || '',
    tonePolicy: j.tonePolicy || '',
    targetRegister: j.targetRegister || '',
    targetRegisterSource: j.targetRegisterSource || '',
    niklAdvisorVersion: j.niklAdvisorVersion || '',
    niklLocalResourceEnabled: j.niklLocalResourceEnabled === true,
    niklLocalResourceApplied: j.niklLocalResourceApplied === true,
    niklLocalCandidateCount: finiteOrNull(j.niklLocalCandidateCount),
    niklLocalAppliedCount: finiteOrNull(j.niklLocalAppliedCount),
    niklLocalErrorCount: finiteOrNull(j.niklLocalErrorCount),
    niklExternalApiEnabled: j.niklExternalApiEnabled === true,
    niklExternalProviderCount: finiteOrNull(j.niklExternalProviderCount),
    niklExternalCandidateCount: finiteOrNull(j.niklExternalCandidateCount),
    niklExternalLookupCount: finiteOrNull(j.niklExternalLookupCount),
    niklExternalHitCount: finiteOrNull(j.niklExternalHitCount),
    niklExternalAppliedCount: finiteOrNull(j.niklExternalAppliedCount),
    niklExternalCacheHitCount: finiteOrNull(j.niklExternalCacheHitCount),
    niklExternalErrorCount: finiteOrNull(j.niklExternalErrorCount),
    niklExternalTimeoutCount: finiteOrNull(j.niklExternalTimeoutCount),
    deliveryDecision: j.deliveryDecision || '',
    deliveryReasonCodes: safeCodes(j.deliveryReasonCodes),
    editableChunkCount: finiteOrNull(j.editableChunkCount),
    approvedModelChunkCount: finiteOrNull(j.approvedModelChunkCount),
    modelFailureChunkCount: finiteOrNull(j.modelFailureChunkCount),
    chunkConcurrency: finiteOrNull(j.chunkConcurrency),
    structureSignaturePass: typeof j.structureSignaturePass === 'boolean'
      ? j.structureSignaturePass
      : null,
    sectionPathErrorCount: finiteOrNull(j.sectionPathErrorCount),
    semanticJudgeRan: j.semanticJudgeRan === true,
    humanizationDepthApplicable: j.humanizationDepthApplicable === true,
    humanizationDepthPass: typeof j.humanizationDepthPass === 'boolean' ? j.humanizationDepthPass : null,
    humanizationOverallDepthPass: typeof j.humanizationOverallDepthPass === 'boolean'
      ? j.humanizationOverallDepthPass
      : null,
    humanizationMinimumEffectPass: typeof j.humanizationMinimumEffectPass === 'boolean' ? j.humanizationMinimumEffectPass : null,
    humanizationDepthSoftDelivered: j.humanizationDepthSoftDelivered === true,
    humanizationNoBenefitDelivered: j.humanizationNoBenefitDelivered === true,
    humanizationNoEffectRetryAttemptCount: finiteOrNull(j.humanizationNoEffectRetryAttemptCount),
    conservativeSentenceRetryAttemptCount: finiteOrNull(j.conservativeSentenceRetryAttemptCount),
    conservativeSentenceRetryModelCallCount: finiteOrNull(j.conservativeSentenceRetryModelCallCount),
    conservativeSentenceRetryAppliedCount: finiteOrNull(j.conservativeSentenceRetryAppliedCount),
    conservativeSentenceRetryStoppedNoProgress:
      j.conservativeSentenceRetryStoppedNoProgress === true,
    conservativeSentenceRetryMarginalGainCount:
      finiteOrNull(j.conservativeSentenceRetryMarginalGainCount),
    conservativeSentenceRetrySubstantiveEditGain:
      finiteOrNull(j.conservativeSentenceRetrySubstantiveEditGain),
    conservativeSentenceRetryRejectionCodes: safeCodes(j.conservativeSentenceRetryRejectionCodes),
    humanizationDeliveryDepthBand: j.humanizationDeliveryDepthBand || '',
    humanizationTargetDepthMet: typeof j.humanizationTargetDepthMet === 'boolean'
      ? j.humanizationTargetDepthMet
      : null,
    humanizationEditTargetMet: typeof j.humanizationEditTargetMet === 'boolean'
      ? j.humanizationEditTargetMet
      : null,
    humanizationTargetDepthGap: finiteOrNull(j.humanizationTargetDepthGap),
    substantiveEditRatio: finiteOrNull(j.substantiveEditRatio),
    postSemanticSubstantiveEditRatio: finiteOrNull(j.postSemanticSubstantiveEditRatio),
    finalStageSubstantiveEditRatio: finiteOrNull(j.finalStageSubstantiveEditRatio),
    postSemanticToFinalSubstantiveEditDelta: finiteOrNull(j.postSemanticToFinalSubstantiveEditDelta),
    depthTugTrigger: j.depthTugTrigger || '',
    depthTugFinalSide: j.depthTugFinalSide || '',
    humanizationDepthRetryRejectionCodes: safeCodes(j.humanizationDepthRetryRejectionCodes),
    recoveryBudgetSkippedCodes: safeCodes(j.recoveryBudgetSkippedCodes),
    substantiveChangedSentenceRatio: finiteOrNull(j.substantiveChangedSentenceRatio),
    substantiveCarryoverCount: finiteOrNull(j.substantiveCarryoverCount),
    substantiveCarryoverRatio: finiteOrNull(j.substantiveCarryoverRatio),
    substantiveCarryoverEligibleSentenceCount: finiteOrNull(j.substantiveCarryoverEligibleSentenceCount),
    substantiveCarryoverMaximum: finiteOrNull(j.substantiveCarryoverMaximum),
    humanizationTargetCoverage: finiteOrNull(j.humanizationTargetCoverage),
    structuralChangedSentenceCount: finiteOrNull(j.structuralChangedSentenceCount),
    structuralChangedSentenceRatio: finiteOrNull(j.structuralChangedSentenceRatio),
    materiallyRecastSentenceCount: finiteOrNull(j.materiallyRecastSentenceCount),
    effectiveStructuralChangedSentenceCount: finiteOrNull(j.effectiveStructuralChangedSentenceCount),
    clauseLevelStructuralAlternative: j.clauseLevelStructuralAlternative === true,
    rhetoricalRemediationTargetCount: finiteOrNull(j.rhetoricalRemediationTargetCount),
    rhetoricalRemediationAchievedCount: finiteOrNull(j.rhetoricalRemediationAchievedCount),
    rhetoricalRemediationCoverage: finiteOrNull(j.rhetoricalRemediationCoverage),
    macroDiscourseApplicable: j.macroDiscourseApplicable === true,
    macroDiscourseScore: finiteOrNull(j.macroDiscourseScore),
    macroDiscoursePass: typeof j.macroDiscoursePass === 'boolean' ? j.macroDiscoursePass : null,
    macroDiscourseOrderPass: typeof j.macroDiscourseOrderPass === 'boolean'
      ? j.macroDiscourseOrderPass
      : null,
    macroDiscourseSourceParagraphCount: finiteOrNull(j.macroDiscourseSourceParagraphCount),
    macroDiscourseOutputParagraphCount: finiteOrNull(j.macroDiscourseOutputParagraphCount),
    macroDiscourseRecomposedParagraphCount: finiteOrNull(j.macroDiscourseRecomposedParagraphCount),
    macroDiscourseRepeatedEvaluationReduction: finiteOrNull(j.macroDiscourseRepeatedEvaluationReduction),
    macroDiscourseRoleOrderRetention: finiteOrNull(j.macroDiscourseRoleOrderRetention),
    macroDiscourseIdeaOrderRetention: finiteOrNull(j.macroDiscourseIdeaOrderRetention),
    sourceRedundancyApplicable: j.sourceRedundancyApplicable === true,
    sourceRedundancyPass: typeof j.sourceRedundancyPass === 'boolean' ? j.sourceRedundancyPass : null,
    sourceRedundancySourceSentenceCount: finiteOrNull(j.sourceRedundancySourceSentenceCount),
    sourceRedundancyOutputSentenceCount: finiteOrNull(j.sourceRedundancyOutputSentenceCount),
    sourceRedundancyRequiredReduction: finiteOrNull(j.sourceRedundancyRequiredReduction),
    sourceRedundancyAchievedReduction: finiteOrNull(j.sourceRedundancyAchievedReduction),
    sectionRecoveryEnabled: j.sectionRecoveryEnabled === true,
    sectionRecoveryAttemptCount: finiteOrNull(j.sectionRecoveryAttemptCount),
    sectionRecoveryTargetOnlyCount: finiteOrNull(j.sectionRecoveryTargetOnlyCount),
    sectionRecoveryAppliedCount: finiteOrNull(j.sectionRecoveryAppliedCount),
    sectionRecoveryEscalationCount: finiteOrNull(j.sectionRecoveryEscalationCount),
    sectionRecoveryRejectedAttemptCount: finiteOrNull(j.sectionRecoveryRejectedAttemptCount),
    sectionRecoveryRejectionCodes: safeCodes(j.sectionRecoveryRejectionCodes),
    sectionRecoveryRejectionCodeCounts: safeCodeCountMap(j.sectionRecoveryRejectionCodeCounts),
    sectionRecoveryMiniAppliedCount: finiteOrNull(j.sectionRecoveryMiniAppliedCount),
    sectionRecoveryEscalationAppliedCount: finiteOrNull(j.sectionRecoveryEscalationAppliedCount),
    fingerprintPass: typeof j.fingerprintPass === 'boolean' ? j.fingerprintPass : null,
    fingerprintIssueCodes: safeCodes(j.fingerprintIssueCodes),
    fingerprintIntroducedCount: finiteOrNull(j.fingerprintIntroducedCount),
    semanticRelationShiftCount: finiteOrNull(j.semanticRelationShiftCount),
    semanticRelationShiftFamilies: safeCodes(j.semanticRelationShiftFamilies),
    fingerprintRepairCount: finiteOrNull(j.fingerprintRepairCount),
    fingerprintSourceRestoreCount: finiteOrNull(j.fingerprintSourceRestoreCount),
    unsupportedSpecificityPass: typeof j.unsupportedSpecificityPass === 'boolean'
      ? j.unsupportedSpecificityPass
      : null,
    unsupportedSpecificityIssueCount: finiteOrNull(j.unsupportedSpecificityIssueCount),
    unsupportedSpecificityResidualCount: finiteOrNull(j.unsupportedSpecificityResidualCount),
    unsupportedSpecificityRestoreCount: finiteOrNull(j.unsupportedSpecificityRestoreCount),
    unsupportedSpecificityRemovalCount: finiteOrNull(j.unsupportedSpecificityRemovalCount),
    fingerprintShadowPositiveCodes: safeCodes(j.fingerprintShadowPositiveCodes),
    fingerprintShadowPositiveCount: finiteOrNull(j.fingerprintShadowPositiveCount),
    endingStylePass: typeof j.endingStylePass === 'boolean' ? j.endingStylePass : null,
    endingStyleIssueCount: finiteOrNull(j.endingStyleIssueCount),
    endingStyleIntroducedOtherCount: finiteOrNull(j.endingStyleIntroducedOtherCount),
    resumeCoverageApplicable: j.resumeCoverageApplicable === true,
    resumeCoveragePass: typeof j.resumeCoveragePass === 'boolean' ? j.resumeCoveragePass : null,
    resumeClaimCount: finiteOrNull(j.resumeClaimCount),
    resumeCoveredClaimCount: finiteOrNull(j.resumeCoveredClaimCount),
    resumeCoverageRatio: finiteOrNull(j.resumeCoverageRatio),
    humanizationDepthReasonCodes: safeCodes(j.humanizationDepthReasonCodes),
    koreanRefinementPass: typeof j.koreanRefinementPass === 'boolean' ? j.koreanRefinementPass : null,
    koreanRefinementIssueCodes: safeCodes(j.koreanRefinementIssueCodes),
    formalRegisterResidualCount: finiteOrNull(j.formalRegisterResidualCount),
    koreanDeterministicRepairCount: finiteOrNull(j.koreanDeterministicRepairCount),
    koreanRefinementRetryCount: finiteOrNull(j.koreanRefinementRetryCount),
    koreanSourceRestoreCount: finiteOrNull(j.koreanSourceRestoreCount),
    quoteIntegrityPass: typeof j.quoteIntegrityPass === 'boolean' ? j.quoteIntegrityPass : null,
    quoteCountChanged: j.quoteCountChanged === true,
    quoteDuplicateReductionBenign: j.quoteDuplicateReductionBenign === true,
    quoteDuplicateReductionCount: finiteOrNull(j.quoteDuplicateReductionCount),
    quoteMissingUniqueCount: finiteOrNull(j.quoteMissingUniqueCount),
    quoteContentChangedCount: finiteOrNull(j.quoteContentChangedCount),
    quoteIntegrityRestoreCount: finiteOrNull(j.quoteIntegrityRestoreCount),
    finalGeneratedDedupeApplied: j.finalGeneratedDedupeApplied === true,
    finalGeneratedDedupeRejected: j.finalGeneratedDedupeRejected === true,
    finalGeneratedDedupeReasonCodes: safeCodes(j.finalGeneratedDedupeReasonCodes),
    finalGeneratedDedupeBlockCount: finiteOrNull(j.finalGeneratedDedupeBlockCount),
    finalGeneratedDedupeSentenceCount: finiteOrNull(j.finalGeneratedDedupeSentenceCount),
    sourcePreflightChanged: j.sourcePreflightChanged === true,
    sourceArtifactRemovedCount: finiteOrNull(j.sourceArtifactRemovedCount),
    sourcePreflightNoticeCount: finiteOrNull(j.sourcePreflightNoticeCount),
    sourcePreflightIssueCodes: safeCodes(j.sourcePreflightIssueCodes),
    sourceReviewWarningCodes: safeCodes(j.sourceReviewWarningCodes),
    sourceReviewWarningCount: finiteOrNull(j.sourceReviewWarningCount),
    naturalnessRiskIncreased: j.naturalnessRiskIncreased === true,
    naturalnessOverallRiskDelta: finiteOrNull(j.naturalnessOverallRiskDelta),
    rhythmUniformityDelta: finiteOrNull(j.rhythmUniformityDelta),
    lengthRatio: finiteOrNull(j.lengthRatio),
    estimatedUsd: finiteOrNull(j.estimatedUsd)
  };
}
router.post('/admin/jobs', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const filterKey = (req.body && req.body.filter) || 'issues';
    const allowed = JOB_STATUS_SETS[filterKey] !== undefined ? JOB_STATUS_SETS[filterKey] : JOB_STATUS_SETS.issues;
    const hoursRaw = parseInt(req.body && req.body.hours, 10);
    const hours = Number.isInteger(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 2160) : 24;
    const sinceMs = Date.now() - hours * 3600 * 1000;
    const rawLimit = parseInt(req.body && req.body.limit, 10);
    const cap = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
    const requestedCursorMs = Number(req.body && req.body.cursorMs) || 0;
    let scanCursorMs = requestedCursorMs > 0 ? requestedCursorMs : 0;
    const scanLimit = Math.min(Math.max(cap * 4, 80), 500);
    const rows = [];
    let lastIncludedCursorMs = 0;
    let lastScannedCursorMs = 0;
    let sawExtra = false;
    let moreRaw = false;

    for (let guard = 0; guard < 8 && !sawExtra; guard++) {
      let q = db.collection(JOB_ARCHIVE_COLLECTION)
        .where('createdAt', '>=', sinceMs);
      if (scanCursorMs > 0) q = q.where('createdAt', '<', scanCursorMs);
      q = q.orderBy('createdAt', 'desc');
      const snap = await q.limit(scanLimit).get();
      if (snap.empty) { moreRaw = false; break; }

      for (const d of snap.docs) {
        const row = serializeAdminJobDoc(d);
        if (!row.createdAtMs) continue;
        lastScannedCursorMs = row.createdAtMs;
        if (allowed && !allowed.includes(row.status)) continue;
        if (rows.length >= cap) { sawExtra = true; break; }
        rows.push(row);
        lastIncludedCursorMs = row.createdAtMs;
      }

      if (sawExtra) break;
      if (snap.docs.length < scanLimit) { moreRaw = false; break; }
      scanCursorMs = lastScannedCursorMs;
      moreRaw = true;
    }

    const nextCursorMs = sawExtra
      ? lastIncludedCursorMs
      : (moreRaw ? lastScannedCursorMs : null);
    const hasMore = !!nextCursorMs && (sawExtra || moreRaw);

    // 이메일 매핑(중복 uid 제거 후 일괄 조회)
    const uids = [...new Set(rows.map(r => r.uid).filter(Boolean))];
    const emailByUid = {};
    await Promise.all(uids.map(async u => {
      try { const us = await db.collection('users').doc(u).get(); if (us.exists) emailByUid[u] = us.data().email || ''; } catch (_) {}
    }));
    rows.forEach(r => { r.email = emailByUid[r.uid] || ''; });

    const summary = {};
    rows.forEach(r => { summary[r.status] = (summary[r.status] || 0) + 1; });
    const chargedCount = rows.filter(r => r.deducted).length;
    const affectedUids = [...new Set(rows.map(r => r.uid).filter(Boolean))];

    logger.info('admin.jobs_loaded', { adminUid, filter: filterKey, hours, count: rows.length, chargedCount, cursorMs: requestedCursorMs || null, hasMore });
    res.json({ ok: true, rows, summary, count: rows.length, chargedCount, affectedUids, nextCursorMs, hasMore, source: JOB_ARCHIVE_COLLECTION });
  } catch (err) {
    logger.error('admin.jobs_failed', { adminUid, err });
    res.status(500).json({ error: '작업 목록을 불러오지 못했습니다. (transformJobArchive 색인 확인)' });
  }
});

// 관리자: 휴머나이징 품질 집계. 원문·결과·프롬프트는 읽거나 응답하지 않고
// transformJobArchive의 축약 관측 필드만 사용한다.
router.post('/admin/humanize-quality', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const hoursRaw = parseInt(req.body && req.body.hours, 10);
    const hours = Number.isInteger(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 2160) : 24;
    const limitRaw = parseInt(req.body && req.body.limit, 10);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 1000;
    const sinceMs = Date.now() - hours * 3600 * 1000;
    const snap = await db.collection(JOB_ARCHIVE_COLLECTION)
      .where('createdAt', '>=', sinceMs)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const rows = snap.docs.map(serializeAdminJobDoc).filter(row => row.createdAtMs >= sinceMs);
    const report = buildHumanizeQualityReport(rows, {
      hours,
      sinceMs,
      generatedAtMs: Date.now(),
      recentLimit: Math.min(limit, 200)
    });
    logger.info('admin.humanize_quality_loaded', {
      adminUid,
      hours,
      limit,
      count: rows.length,
      truncated: snap.docs.length >= limit
    });
    res.json({
      ok: true,
      source: JOB_ARCHIVE_COLLECTION,
      truncated: snap.docs.length >= limit,
      report
    });
  } catch (err) {
    logger.error('admin.humanize_quality_failed', { adminUid, err });
    res.status(500).json({ error: '휴머나이징 품질 통계를 불러오지 못했습니다. (transformJobArchive 색인 확인)' });
  }
});

// 관리자: AI 감지 보정 설정 조회/수정.
// Firestore 설정이 있으면 env보다 우선 적용되고, 없으면 env 기본값이 사용된다.
router.post('/admin/detect-calibration', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const config = await detectCalibration.getRuntimeConfig({ db, logger, force: true });
    res.json({
      ok: true,
      config,
      envConfig: detectCalibration.publicConfig(detectCalibration.config(), 'env')
    });
  } catch (err) {
    logger.error('admin.detect_calibration_load_failed', { adminUid, err });
    res.status(500).json({ error: '감지 보정 설정을 불러오지 못했습니다.' });
  }
});

router.post('/admin/update-detect-calibration', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const patch = detectCalibration.sanitizeConfig(req.body && req.body.config);
    await db.collection(detectCalibration.SETTINGS_COLLECTION).doc(detectCalibration.SETTINGS_DOC).set({
      ...patch,
      version: detectCalibration.VERSION,
      updatedBy: adminUid,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    detectCalibration.clearRuntimeConfigCache();
    const config = await detectCalibration.getRuntimeConfig({ db, logger, force: true });
    logger.info('admin.detect_calibration_updated', {
      adminUid,
      enabled: config.enabled,
      limit: config.limit,
      factor: config.factor,
      maxReduction: config.maxReduction,
      floor: config.floor
    });
    res.json({ ok: true, config });
  } catch (err) {
    logger.error('admin.detect_calibration_update_failed', { adminUid, err });
    res.status(500).json({ error: '감지 보정 설정 저장에 실패했습니다.' });
  }
});

// 구형 관리자 화면 호환. 이 토글은 값을 저장해도 운영 변환 경로가 읽지 않아
// "켜짐"으로 보이기만 하던 죽은 설정이었다. 단일 엔진 전환 뒤에는 항상
// retired/disabled를 반환하고 Firestore를 더 이상 쓰지 않는다.
router.post('/admin/basic-humanize-experiment', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  res.json({
    ok: true,
    retired: true,
    config: RETIRED_BASIC_EXPERIMENT_CONFIG,
    envConfig: RETIRED_BASIC_EXPERIMENT_CONFIG
  });
});

router.post('/admin/update-basic-humanize-experiment', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  logger.info('admin.basic_humanize_experiment_retired_request_ignored', { adminUid });
  res.json({
    ok: true,
    retired: true,
    config: RETIRED_BASIC_EXPERIMENT_CONFIG,
    notice: '운영 휴머나이징 엔진이 단일화되어 이 개발테스트 토글은 종료되었습니다.'
  });
});

// 관리자: 운영 LLM 런타임 설정. Firestore 값이 env보다 우선하고 15초 캐시된다.
router.post('/admin/gpt-runtime-config', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const config = await gptRuntimeConfig.getRuntimeConfig({ db, logger, force: true });
    res.json({
      ok: true,
      config,
      envConfig: gptRuntimeConfig.publicConfig(gptRuntimeConfig.envConfig(), 'env')
    });
  } catch (err) {
    logger.error('admin.gpt_runtime_config_load_failed', { adminUid, err });
    res.status(500).json({ error: '운영 LLM 설정을 불러오지 못했습니다.' });
  }
});

router.post('/admin/update-gpt-runtime-config', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const requestedConfig = req.body && req.body.config || {};
    if (requestedConfig.activeProvider != null && String(requestedConfig.activeProvider).toLowerCase() !== 'gpt') {
      logger.warn('admin.gpt_runtime_provider_change_blocked', { adminUid, requested: String(requestedConfig.activeProvider).slice(0, 30) });
      return res.status(409).json({
        error: '운영 공급자는 GPT로 고정되어 있습니다. 롤백은 엔진 플래그와 직전 배포로 수행해 주세요.',
        code: 'PROVIDER_CHANGE_REQUIRES_DEPLOYMENT'
      });
    }
    const patch = { ...gptRuntimeConfig.sanitizeConfig(requestedConfig), activeProvider: 'gpt' };
    await db.collection(gptRuntimeConfig.SETTINGS_COLLECTION).doc(gptRuntimeConfig.SETTINGS_DOC).set({
      ...patch,
      version: gptRuntimeConfig.VERSION,
      updatedBy: adminUid,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    gptRuntimeConfig.clearRuntimeConfigCache();
    const config = await gptRuntimeConfig.getRuntimeConfig({ db, logger, force: true });
    logger.info('admin.gpt_runtime_config_updated', {
      adminUid,
      activeProvider: config.activeProvider,
      humanizePrimary: config.models.humanizePrimary,
      humanizeEscalation: config.models.humanizeEscalation,
      judgeEscalation: config.models.judgeEscalation,
      detect: config.models.detect,
      cacheEnabled: config.cache.enabled,
      models: config.models,
      reasoning: config.reasoning,
      escalation: config.escalation
    });
    res.json({
      ok: true,
      config,
      envConfig: gptRuntimeConfig.publicConfig(gptRuntimeConfig.envConfig(), 'env')
    });
  } catch (err) {
    logger.error('admin.gpt_runtime_config_update_failed', { adminUid, err });
    res.status(500).json({ error: '운영 LLM 설정 저장에 실패했습니다.' });
  }
});

router.post('/admin/test-gpt-runtime-config', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY가 설정되어 있지 않습니다.' });
  }
  if (req.body?.config?.activeProvider != null && String(req.body.config.activeProvider).toLowerCase() !== 'gpt') {
    return res.status(409).json({
      error: '운영 테스트 공급자는 GPT만 지원합니다.',
      code: 'UNSUPPORTED_PROVIDER'
    });
  }
  try {
    const base = await gptRuntimeConfig.getRuntimeConfig({ db, logger, force: true });
    const config = gptRuntimeConfig.publicConfig({
      ...base,
      ...(req.body && req.body.config ? gptRuntimeConfig.sanitizeConfig(req.body.config) : {})
    }, 'admin_test');
    const sampleText = String((req.body && req.body.sampleText) || '이번 설정은 운영 엔진 라우팅과 모델 응답 형식을 확인하기 위한 관리자 테스트 문장입니다.').slice(0, 1200);
    const task = String((req.body && req.body.task) || 'detect').toLowerCase();
    const startedAt = Date.now();
    const result = task === 'humanize'
      ? await gptAnalyze.runHumanizeChunked({ text: sampleText, mode: 'polish', lang: 'ko', config, allowPolish: true, uid: adminUid })
      : await gptAnalyze.runDetect(sampleText, 'ko', { config, route: 'admin_test_gpt_runtime', allowLocalFallback: false, uid: adminUid });
    logger.info('admin.gpt_runtime_config_tested', {
      adminUid,
      task,
      activeProvider: config.activeProvider,
      humanizePrimary: config.models.humanizePrimary,
      elapsedMs: Date.now() - startedAt
    });
    res.json({
      ok: true,
      task,
      elapsedMs: Date.now() - startedAt,
      config,
      envConfig: gptRuntimeConfig.publicConfig(gptRuntimeConfig.envConfig(), 'env'),
      result: task === 'humanize'
        ? {
            status: result.status,
            outputText: result.result?.outputText || '',
            meta: result.gptEngine || result.result?.humanizeMeta || null
          }
        : result
    });
  } catch (err) {
    logger.error('admin.gpt_runtime_config_test_failed', { adminUid, err });
    res.status(500).json({ error: err && err.message || '운영 LLM 테스트 호출에 실패했습니다.' });
  }
});

// 관리자: 영향 사용자에게 인앱 알림 일괄 발송 (users/{uid}/notifications)
// 고정 docId(clientId)로 멱등 — 같은 공지 재발송 시 중복 안 쌓임.
router.post('/admin/notify-users', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const uids = Array.isArray(req.body && req.body.uids) ? [...new Set(req.body.uids.filter(Boolean))].slice(0, 500) : [];
  const title = String((req.body && req.body.title) || '').trim().slice(0, 60);
  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  const clientId = (String((req.body && req.body.clientId) || '').trim() || ('admin_notice_' + Date.now())).slice(0, 80);
  if (!uids.length) return res.status(400).json({ error: '대상 사용자가 없습니다.' });
  if (title.length < 1 || message.length < 2) return res.status(400).json({ error: '제목과 메시지를 입력해주세요.' });
  try {
    let sent = 0;
    await Promise.all(uids.map(async (uid) => {
      try {
        await db.collection('users').doc(uid).collection('notifications').doc(clientId).set({
          clientId,
          type: 'notice',
          title,
          message,
          action: { tab: 'main' },
          postId: null,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAtMs: Date.now()
        }, { merge: true });
        sent++;
      } catch (_) {}
    }));
    logger.info('admin.notify_users', { adminUid, total: uids.length, sent, clientId });
    res.json({ ok: true, sent, total: uids.length });
  } catch (err) {
    logger.error('admin.notify_users_failed', { adminUid, err });
    res.status(500).json({ error: '알림 발송에 실패했습니다.' });
  }
});

// 관리자: 대시보드 매출 요약 (오늘 + 이번 달) — 관리자 페이지 상단 개요 바
router.post('/admin/revenue-summary', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  try {
    const [today, month] = await Promise.all([getRevenue('today'), getRevenue('month')]);
    const slim = (r) => ({
      totalPaid: r.totalPaid,
      totalCount: r.totalCount,
      refundAmount: r.refundAmount,
      refundCount: r.refundCount
    });
    res.json({ ok: true, today: slim(today), month: slim(month) });
  } catch (err) {
    logger.error('admin.revenue_summary_failed', { adminUid, err });
    res.status(500).json({ error: '매출 요약을 불러오지 못했습니다.' });
  }
});

// 관리자: 사용자 검색 + 결제/크레딧 요약
router.post('/admin/user-summary', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;

  try {
    const uid = await findUserByQuery(req.body && req.body.query);
    if (!uid) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    const bundle = await loadAdminUserBundle(uid);
    if (!bundle) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    logger.info('admin.user_summary_loaded', {
      adminUid,
      targetUid: uid,
      paidOrphanDebitCount: bundle.creditAudit?.paidOrphanDebitCount || 0,
      paidOrphanDebitCredits: bundle.creditAudit?.paidOrphanDebitCredits || 0
    });
    res.json({ ok: true, ...bundle });
  } catch (err) {
    logger.error('admin.user_summary_failed', { adminUid, err });
    res.status(500).json({ error: '사용자 정보를 불러오지 못했습니다.' });
  }
});

// 관리자: 크레딧 수동 추가/차감
router.post('/admin/adjust-credits', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;

  const targetUid = String((req.body && req.body.uid) || '').trim();
  const delta = parseInt(req.body && req.body.delta, 10);
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!targetUid) return res.status(400).json({ error: '대상 UID가 필요합니다.' });
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
    return res.status(400).json({ error: '크레딧 변동값은 -100000~100000 사이의 0이 아닌 정수여야 합니다.' });
  }
  if (reason.length < 2) return res.status(400).json({ error: '조정 사유를 2자 이상 입력해주세요.' });

  const userRef = db.collection('users').doc(targetUid);
  try {
    const result = delta < 0
      ? await commitCreditDeduct(targetUid, Math.abs(delta), 'admin_adjust', null, {
        detail: reason,
        adminUid,
        respectUnlimited: false
      })
      : await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw Object.assign(new Error('사용자를 찾을 수 없습니다.'), { status: 404 });
      const current = Number(userSnap.data().credits) || 0;
      const next = current + delta;
      if (next < 0) throw Object.assign(new Error('보유 크레딧보다 많이 차감할 수 없습니다.'), { status: 400 });
      t.update(userRef, {
        credits: next,
        lastAdminCreditAdjustedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.set(userRef.collection('creditHistory').doc(), {
        type: 'admin_adjust',
        used: delta < 0 ? Math.abs(delta) : 0,
        amount: delta,
        remaining: next,
        detail: reason,
        adminUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { current, next };
      });
    logger.info('admin.credits_adjusted', { adminUid, targetUid, delta, before: result.current, after: result.next });
    res.json({ ok: true, before: result.current, after: result.next, delta });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('admin.credits_adjust_failed', { adminUid, targetUid, delta, err });
    res.status(500).json({ error: '크레딧 조정에 실패했습니다.' });
  }
});

function safeCreditHistoryId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.includes('/') || id.length > 500) return '';
  return id;
}

function orphanResolveDefaultReason(action, credits) {
  const amount = auditNumber(credits).toLocaleString('ko-KR');
  return action === 'mark'
    ? `결과 저장 없는 유료 차감 ${amount}크레딧 수동 처리완료 표시`
    : `결과 저장 없는 유료 차감 ${amount}크레딧 환급`;
}

// 관리자: 결과 저장 없이 차감된 유료 크레딧을 원장 항목에 연결해 환급/처리완료 표시
router.post('/admin/resolve-orphan-debit', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;

  const targetUid = String((req.body && req.body.uid) || '').trim();
  const creditHistoryId = safeCreditHistoryId(req.body && req.body.creditHistoryId);
  const action = (req.body && req.body.action) === 'mark' ? 'mark' : 'restore';
  if (!targetUid) return res.status(400).json({ error: '대상 UID가 필요합니다.' });
  if (!creditHistoryId) return res.status(400).json({ error: '처리할 차감 원장 ID가 필요합니다.' });

  try {
    const bundle = await loadAdminUserBundle(targetUid);
    if (!bundle) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    const auditDebit = (bundle.creditAudit?.orphanDebits || []).find(d => d.id === creditHistoryId);
    if (!auditDebit) {
      return res.status(400).json({ error: '현재 결과 없는 차감 목록에 없는 항목입니다. 이미 결과와 매칭됐거나 목록을 새로고침해야 합니다.' });
    }
    if (!auditDebit.isAfterFirstPaid) {
      return res.status(400).json({ error: '결제 전 차감은 유료 차감 환급 대상이 아닙니다.' });
    }
    if (auditDebit.handled) {
      return res.json({
        ok: true,
        alreadyHandled: true,
        action: auditDebit.resolution || 'resolved',
        restoredCredits: auditNumber(auditDebit.restoredCredits),
        message: '이미 처리완료로 표시된 차감입니다.'
      });
    }

    const reason = String((req.body && req.body.reason) || '').trim() || orphanResolveDefaultReason(action, auditDebit.used);
    const userRef = db.collection('users').doc(targetUid);
    const debitRef = userRef.collection('creditHistory').doc(creditHistoryId);
    const restoreRef = userRef.collection('creditHistory').doc('orphan_restore_' + creditHistoryId);

    if (action === 'restore') {
      const restored = await commitCreditRestoreFromHistory(
        targetUid,
        auditNumber(auditDebit.used),
        auditDebit.type || 'credit',
        creditHistoryId,
        restoreRef.id,
        {
          detail: reason,
          adminUid,
          orphanDebitResolved: true,
          requireUnresolved: true,
          respectUnlimited: false,
          mode: auditDebit.mode,
          evidence: auditDebit.evidence,
          fallback: auditDebit.fallback
        }
      );
      const result = {
        alreadyHandled: restored.alreadyHandled === true,
        before: restored.current,
        after: restored.next,
        restoredCredits: restored.alreadyHandled ? auditNumber(auditDebit.restoredCredits) : restored.restoredCredits,
        resolveCreditHistoryId: restored.restoreHistoryId
      };
      logger.info('admin.orphan_debit_resolved', {
        adminUid,
        targetUid,
        creditHistoryId,
        action,
        restoredCredits: result.restoredCredits,
        alreadyHandled: result.alreadyHandled
      });
      return res.json({
        ok: true,
        action,
        ...result,
        message: result.alreadyHandled
          ? '이미 처리완료로 표시된 차감입니다.'
          : '크레딧 환급 및 처리완료 표시가 끝났습니다.'
      });
    }

    const result = await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const debitSnap = await t.get(debitRef);
      if (!userSnap.exists) throw Object.assign(new Error('사용자를 찾을 수 없습니다.'), { status: 404 });
      if (!debitSnap.exists) throw Object.assign(new Error('차감 원장을 찾을 수 없습니다.'), { status: 404 });

      const debit = debitSnap.data() || {};
      const row = {
        id: debitSnap.id,
        type: debit.type,
        requestId: debit.requestId,
        used: debit.used
      };
      if (!isAuditableResultDebit(row)) {
        throw Object.assign(new Error('휴머나이저/재구성 유료 차감 항목만 처리할 수 있습니다.'), { status: 400 });
      }

      const alreadyHandled = debit.orphanDebitResolved === true ||
        !!debit.restoredAt ||
        !!debit.resolvedAt ||
        !!debit.restoreCreditHistoryId ||
        !!debit.resolveCreditHistoryId;
      const current = auditNumber(userSnap.data().credits);
      const used = auditNumber(debit.used);
      if (alreadyHandled) {
        return {
          alreadyHandled: true,
          before: current,
          after: current,
          restoredCredits: auditNumber(debit.restoredCredits) || used,
          resolveCreditHistoryId: debit.restoreCreditHistoryId || debit.resolveCreditHistoryId || null
        };
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      t.update(userRef, {
        lastAdminOrphanDebitResolvedAt: now
      });
      t.update(debitRef, {
        orphanDebitResolved: true,
        orphanDebitResolution: 'manual_handled',
        restoredCredits: 0,
        resolvedAt: now,
        resolvedBy: adminUid,
        resolveReason: reason
      });
      return {
        alreadyHandled: false,
        before: current,
        after: current,
        restoredCredits: 0,
        resolveCreditHistoryId: null
      };
    });

    logger.info('admin.orphan_debit_resolved', {
      adminUid,
      targetUid,
      creditHistoryId,
      action,
      restoredCredits: result.restoredCredits,
      alreadyHandled: result.alreadyHandled
    });
    res.json({
      ok: true,
      action,
      ...result,
      message: result.alreadyHandled
        ? '이미 처리완료로 표시된 차감입니다.'
        : action === 'restore'
        ? '크레딧 환급 및 처리완료 표시가 끝났습니다.'
        : '처리완료 표시가 끝났습니다.'
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('admin.orphan_debit_resolve_failed', { adminUid, targetUid, creditHistoryId, action, err });
    res.status(500).json({ error: '결과 없는 차감 처리에 실패했습니다.' });
  }
});

// 관리자: 고객 요청 없이 결제건 직접 환불
router.post('/admin/direct-refund', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;

  const orderId = String((req.body && req.body.orderId) || '').trim();
  const kind = (req.body && (req.body.kind === 'sub' || req.body.kind === 'subscription')) ? 'subscription' : 'order';
  const reason = String((req.body && req.body.reason) || '').trim();
  const mode = (req.body && req.body.mode) || 'remaining';
  const customAmount = req.body && req.body.amount;
  if (!orderId) return res.status(400).json({ error: '주문번호가 필요합니다.' });
  if (reason.length < 2) return res.status(400).json({ error: '환불 사유를 2자 이상 입력해주세요.' });

  try {
    const orderRef = getOrderRef(kind, orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    const result = await processRefund({ orderRef, orderSnap, kind, adminUid, reason, mode, customAmount });
    logger.info('admin.direct_refund_approved', {
      adminUid, orderId, kind, uid: orderSnap.data().uid,
      refundAmount: result.refundAmount, refundedCredits: result.refundedCredits
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) {
      logger.warn('admin.direct_refund_rejected', { adminUid, orderId, kind, status: err.status, err });
      return res.status(err.status).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.retryable === true ? { retryable: true } : {})
      });
    }
    logger.error('admin.direct_refund_failed', { adminUid, orderId, kind, err });
    res.status(500).json({ error: '환불 처리에 실패했습니다.' });
  }
});

function refundRequestProcessingConflict(order) {
  if (!order?.refundProcessing) return null;
  return {
    status: 409,
    code: 'REFUND_PROCESSING',
    message: '이미 환불 처리가 진행 중입니다. 잠시 후 상태를 다시 확인해 주세요.'
  };
}

function creditRefundGrant(order) {
  const totalCredits = Math.max(0, Math.floor(Number(order && (order.totalGrantedCredits ?? order.safeCredits ?? order.credits)) || 0));
  const explicitPaidCredits = Math.max(0, Math.floor(Number(order && order.paidCredits) || 0));
  const usesBaseCreditPolicy = String(order && order.creditGrantPolicyVersion || '') === CREDIT_GRANT_POLICY_VERSION
    && explicitPaidCredits > 0
    && totalCredits >= explicitPaidCredits;
  const usesTrackedLot = usesBaseCreditPolicy
    && String(order && order.creditLotPolicyVersion || '') === CREDIT_LOT_POLICY_VERSION
    && hasNumericLotBalances(order);
  // 과거 주문은 주문 당시의 총 지급량 비례 정책을 유지한다. 새 정책을 소급해 환불액을 바꾸지 않는다.
  const paidCredits = usesBaseCreditPolicy ? explicitPaidCredits : totalCredits;
  return {
    usesBaseCreditPolicy,
    usesTrackedLot,
    paidCredits,
    totalCredits,
    bonusCredits: Math.max(0, totalCredits - paidCredits),
    remainingPaidCredits: usesTrackedLot
      ? Math.min(paidCredits, Math.max(0, Math.floor(Number(order.refundPaidCreditsRemaining) || 0)))
      : null,
    remainingBonusCredits: usesTrackedLot
      ? Math.min(
        Math.max(0, totalCredits - paidCredits),
        Math.max(0, Math.floor(Number(order.refundEventBonusCreditsRemaining) || 0))
      )
      : null,
    refundCreditBasis: usesBaseCreditPolicy ? 'paid_credits_first' : 'legacy_total_grant'
  };
}

function refundPolicyVersionForOrder(order, usesBaseCreditPolicy) {
  return order?.refundPolicyVersionAtPurchase
    || order?.refundPolicyVersion
    || (usesBaseCreditPolicy ? REFUND_POLICY_VERSION : 'legacy-total-grant-v1');
}

function creditRefundFinalizeDecision(order, { operationId, targetRefundedAmount, orderAmount }) {
  const latest = order || {};
  const latestAmount = Math.max(0, Math.floor(Number(latest.refundedAmount ?? latest.refundAmount) || 0));
  const targetAmount = Math.max(0, Math.floor(Number(targetRefundedAmount) || 0));
  const totalAmount = Math.max(0, Math.floor(Number(orderAmount) || 0));
  const processing = resumableCreditRefund(latest);
  if (!processing) {
    if (latestAmount >= targetAmount) {
      return {
        ok: true,
        alreadyFinalized: true,
        finalRefundedAmount: latestAmount,
        fullyRefunded: latest.status === 'refunded' || latestAmount >= totalAmount
      };
    }
    return { ok: false, reason: 'processing_missing', latestAmount };
  }
  if (processing.operationId !== operationId) {
    return { ok: false, reason: 'operation_mismatch', latestAmount };
  }
  const finalRefundedAmount = Math.max(latestAmount, targetAmount);
  return {
    ok: true,
    alreadyFinalized: false,
    finalRefundedAmount,
    fullyRefunded: latest.status === 'refunded' || finalRefundedAmount >= totalAmount
  };
}

async function requestTossCancel({ tossUrl, basicToken, operationId, cancelReason, cancelAmount }) {
  try {
    const body = { cancelReason };
    if (Number.isFinite(Number(cancelAmount))) body.cancelAmount = Number(cancelAmount);
    const response = await outboundFetch('toss', tossUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': refundIdempotencyKey(operationId)
      },
      body: JSON.stringify(body)
    });
    return { response, result: await parseProviderJson(response), networkError: null };
  } catch (networkError) {
    return { response: null, result: {}, networkError };
  }
}

function tossCancellationState({ response, lookup, targetRefundedAmount }) {
  const lookupCanceledAmount = lookup?.response?.ok
    ? providerCanceledAmount(lookup.result)
    : 0;
  const confirmed = Boolean(
    (response && response.ok)
    || lookupCanceledAmount >= Math.max(0, Number(targetRefundedAmount) || 0)
  );
  const status = Number(response && response.status) || 0;
  const unknown = !confirmed && (
    !response
    || status === 408
    || status === 429
    || status >= 500
  );
  return { confirmed, unknown, lookupCanceledAmount };
}

function refundWindowSnapshotAnchorMs(order) {
  if (!order) return 0;
  // 전자계약 문서를 받은 때와 서비스를 실제 이용할 수 있게 된 때가 다르면
  // 소비자에게 불리하게 앞선 시각을 택하지 않는다. 저장된 startsAt도 더 늦은
  // 약정 시각일 수 있으므로 세 값 중 최댓값을 권위 기산점으로 삼는다.
  return Math.max(
    timestampMs(order.refundWindowStartsAt),
    timestampMs(order.serviceAvailableAt),
    timestampMs(order.contractDocumentDeliveredAt),
    timestampMs(order.termsSnapshotRecordedAt)
  );
}

const REFUND_ELIGIBILITY_EXCEPTION_CODES = new Set([
  'service_not_provided',
  'service_not_as_described',
  'remaining_balance_settlement',
  'other_statutory_ground'
]);

function refundEligibilityReviewDecision(order, body = {}) {
  if (order?.refundEligibilityReviewRequired !== true) {
    return { required: false, accepted: true, persisted: false };
  }
  if (order.refundEligibilityReviewed === true
    && REFUND_ELIGIBILITY_EXCEPTION_CODES.has(String(order.refundEligibilityExceptionCode || ''))
    && String(order.refundEligibilityReviewNote || '').trim().length >= 2) {
    return {
      required: true,
      accepted: true,
      persisted: true,
      exceptionCode: String(order.refundEligibilityExceptionCode),
      note: String(order.refundEligibilityReviewNote).trim().slice(0, 500)
    };
  }
  const exceptionCode = String(body?.statutoryExceptionCode || '').trim();
  const note = String(body?.eligibilityReviewNote || '').trim().slice(0, 500);
  const accepted = body?.eligibilityReviewed === true
    && REFUND_ELIGIBILITY_EXCEPTION_CODES.has(exceptionCode)
    && note.length >= 2;
  return { required: true, accepted, persisted: false, exceptionCode, note };
}

function refundEligibilityReviewUpdate(review, adminUid, now) {
  if (!review?.required || review.persisted || !review.accepted) return {};
  return {
    refundEligibilityReviewed: true,
    refundEligibilityExceptionCode: review.exceptionCode,
    refundEligibilityReviewNote: review.note,
    refundEligibilityReviewedBy: adminUid,
    refundEligibilityReviewedAt: now
  };
}

function refundPaidAtMs(order, kind) {
  if (!order) return 0;
  const explicitStartMs = refundWindowSnapshotAnchorMs(order);
  if (explicitStartMs > 0) return explicitStartMs;
  return kind === 'subscription'
    ? timestampMs(order.approvedAt || order.cycleStartedAt || order.requestedAt)
    : timestampMs(order.createdAt || order.approvedAt || order.requestedAt);
}

function refundWindowState(order, kind, nowMs = Date.now()) {
  const explicitStartMs = refundWindowSnapshotAnchorMs(order);
  const explicitDeadlineMs = timestampMs(order?.refundWindowEndsAt);
  const snapshotDays = Math.max(1, Math.floor(Number(order?.refundWindowDaysAtPurchase) || REFUND_WINDOW_DAYS));
  const paidAtMs = explicitStartMs || refundPaidAtMs(order, kind);
  const legalDeadlineMs = refundWindowLegalDeadlineMs(paidAtMs, snapshotDays);
  // 초기 배포 주문에 168시간 마감이 저장됐더라도 법정 일 단위 말일보다 앞당겨
  // 닫지 않는다. 명시 기한이 더 길다면 구매 당시 약속을 그대로 존중한다.
  const deadlineMs = Math.max(explicitDeadlineMs, legalDeadlineMs);
  if (!paidAtMs || !deadlineMs) {
    return {
      eligible: false,
      paidAtMs: 0,
      deadlineMs: 0,
      source: 'legacy_fallback',
      reason: 'PAYMENT_DATE_MISSING'
    };
  }
  const elapsedMs = Math.max(0, Number(nowMs) - paidAtMs);
  const eligible = Number(nowMs) <= deadlineMs;
  return {
    eligible,
    paidAtMs,
    deadlineMs,
    elapsedMs,
    source: explicitStartMs || explicitDeadlineMs ? 'purchase_snapshot' : 'legacy_fallback',
    reason: eligible ? null : 'REFUND_WINDOW_EXPIRED'
  };
}

function calculateCreditPolicyRefund({
  orderAmount,
  purchasedCredits,
  paidCredits,
  grantedCredits,
  currentCredits,
  remainingPaidCredits,
  remainingBonusCredits
}) {
  const amount = Math.max(0, Math.floor(Number(orderAmount) || 0));
  const granted = Math.max(0, Math.floor(Number(grantedCredits ?? purchasedCredits) || 0));
  const paid = Math.min(granted, Math.max(0, Math.floor(Number(paidCredits ?? purchasedCredits) || 0)));
  const balance = Math.max(0, Math.floor(Number(currentCredits) || 0));
  const hasTrackedRemainder = typeof remainingPaidCredits === 'number'
    && Number.isFinite(remainingPaidCredits)
    && remainingPaidCredits >= 0
    && typeof remainingBonusCredits === 'number'
    && Number.isFinite(remainingBonusCredits)
    && remainingBonusCredits >= 0;
  const trackedPaid = hasTrackedRemainder
    ? Math.min(paid, Math.max(0, Math.floor(Number(remainingPaidCredits) || 0)))
    : null;
  const trackedBonus = hasTrackedRemainder
    ? Math.min(
      Math.max(0, granted - paid),
      Math.max(0, Math.floor(Number(remainingBonusCredits) || 0))
    )
    : null;
  const refundableCredits = hasTrackedRemainder
    ? trackedPaid + trackedBonus
    : Math.min(balance, granted);
  const usedCredits = Math.max(0, granted - refundableCredits);
  // 환불 정산에서 사용량은 기준(유료) 크레딧부터 차감한다. 그래야 이벤트 보너스만
  // 사용한 뒤 결제금액을 전액 환불하는 악용이 불가능하다.
  const refundablePaidCredits = hasTrackedRemainder
    ? trackedPaid
    : Math.max(0, paid - Math.min(paid, usedCredits));
  const usedPaidCredits = Math.max(0, paid - refundablePaidCredits);
  const refundAmount = paid > 0
    ? Math.min(amount, Math.floor(amount * refundablePaidCredits / paid))
    : 0;
  return {
    refundAmount,
    refundableCredits,
    usedCredits,
    usedPaidCredits,
    refundablePaidCredits,
    purchasedCredits: granted,
    grantedCredits: granted,
    paidCredits: paid,
    bonusCredits: Math.max(0, granted - paid),
    recoveredBonusCredits: hasTrackedRemainder
      ? trackedBonus
      : Math.min(Math.max(0, granted - paid), refundableCredits),
    usesTrackedLot: hasTrackedRemainder
  };
}

function creditWalletBalances(user) {
  const credits = Math.max(0, Math.floor(Number(user && user.credits) || 0));
  const tracked = Math.max(0, Math.floor(Number(user && user.creditLotV1Balance) || 0));
  return {
    credits,
    tracked,
    untracked: Math.max(0, credits - Math.min(credits, tracked)),
    consistent: tracked <= credits
  };
}

function calculateOrderCreditRefund({ order, user, maxRefundableCredits = null }) {
  const grant = creditRefundGrant(order);
  const wallet = creditWalletBalances(user);
  const untrackedForOrder = typeof maxRefundableCredits === 'number' && Number.isFinite(maxRefundableCredits)
    ? Math.min(wallet.untracked, Math.max(0, Math.floor(maxRefundableCredits)))
    : wallet.untracked;
  const calculation = calculateCreditPolicyRefund({
    orderAmount: order && order.amount,
    paidCredits: grant.paidCredits,
    grantedCredits: grant.totalCredits,
    // Tracked orders use their immutable per-order remainder. Legacy/untracked
    // orders may only use the wallet portion not owned by another v1 order.
    currentCredits: grant.usesTrackedLot ? wallet.credits : untrackedForOrder,
    ...(grant.usesTrackedLot ? {
      remainingPaidCredits: grant.remainingPaidCredits,
      remainingBonusCredits: grant.remainingBonusCredits
    } : {})
  });
  return { grant, wallet, calculation };
}

function calculateSubscriptionPolicyRefund({ orderAmount, tier, coupon }) {
  const amount = Math.max(0, Math.floor(Number(orderAmount) || 0));
  const grantedValue = Number(coupon && coupon.granted);
  const remainingValue = Number(coupon && coupon.remaining);
  const granted = Number.isFinite(grantedValue) ? Math.floor(grantedValue) : 0;
  const remaining = Number.isFinite(remainingValue) ? Math.floor(remainingValue) : -1;
  const recordedUsed = Math.max(0, Math.floor(Number(coupon && coupon.used) || 0));
  const settlementUses = tier === 'unlimited' || granted <= 0
    ? UNLIMITED_REFUND_SETTLEMENT_USES
    : granted;
  const derivedUsed = granted > 0 && remaining >= 0 ? Math.max(0, granted - remaining) : 0;
  const usedCount = Math.min(settlementUses, Math.max(recordedUsed, derivedUsed));
  const refundableUses = Math.max(0, settlementUses - usedCount);
  const refundAmount = settlementUses > 0
    ? Math.min(amount, Math.floor(amount * refundableUses / settlementUses))
    : 0;
  return { refundAmount, usedCount, refundableUses, settlementUses };
}

function currentSubscriptionRefundContext(user, order, paidAtMs, orderId = '') {
  const subscription = user && user.subscription;
  const coupon = user && user.coupon;
  const cycleStartedAtMs = timestampMs(subscription && subscription.cycleStartedAt);
  const currentOrderId = String(subscription && subscription.currentOrderId || '');
  const expectedOrderId = String(orderId || order && order.orderId || '');
  // New subscription generations have a durable order id. Once it exists it is
  // the only authoritative generation key; falling back to timestamps here can
  // make an old refund close a newly purchased subscription of the same tier.
  const generationMatches = currentOrderId
    ? Boolean(expectedOrderId && currentOrderId === expectedOrderId)
    : Boolean(
      cycleStartedAtMs && paidAtMs
      && Math.abs(cycleStartedAtMs - paidAtMs) < 60 * 1000
    );
  const sameCycle = !!(
    subscription && coupon &&
    subscription.tier === order.tier &&
    coupon.tier === order.tier &&
    generationMatches
  );
  return {
    sameCycle,
    subscription,
    coupon,
    cycleStartedAtMs,
    currentOrderId,
    expectedOrderId,
    generationKeySource: currentOrderId ? 'current_order_id' : 'legacy_cycle_timestamp'
  };
}

function activeSubscriptionRefundClaim(claim, order, orderId) {
  const value = claim && typeof claim === 'object' ? claim : {};
  const processing = order && order.subscriptionRefundProcessing;
  const active = ['provider_canceling', 'provider_status_unknown'].includes(String(value.status || ''));
  return active
    && Boolean(value.operationId)
    && value.operationId === processing?.operationId
    && value.orderId === String(orderId || '')
    && value.uid === String(order?.uid || '');
}

function subscriptionRefundGenerationCanMutateUser(user, claim) {
  const value = user && typeof user === 'object' ? user : {};
  const lock = value.subscriptionRefundLock;
  if (!lock || lock.operationId !== claim?.operationId || lock.orderId !== claim?.orderId) return false;
  const currentOrderId = String(value.subscription?.currentOrderId || '');
  return !currentOrderId || currentOrderId === String(claim?.generationOrderId || claim?.orderId || '');
}

async function claimSubscriptionRefund({ orderRef, userRef, orderId, adminUid, requestBody = {} }) {
  const claimRef = db.collection('subscriptionRefundClaims').doc(orderId);
  const accountClaimRef = db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(userRef.id);
  const deletionJobRef = db.collection('accountDeletionJobs').doc(userRef.id);
  return db.runTransaction(async transaction => {
    const [orderSnapshot, userSnapshot, claimSnapshot, deletionJobSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(userRef),
      transaction.get(claimRef),
      transaction.get(deletionJobRef)
    ]);
    if (deletionJobSnapshot.exists && accountDeletionBlocksPayment(deletionJobSnapshot.data())) {
      throw paymentAccountUnavailableError();
    }
    if (!orderSnapshot.exists) {
      throw Object.assign(new Error('ORDER_NOT_FOUND'), { status: 404, code: 'ORDER_NOT_FOUND' });
    }
    const latestOrder = orderSnapshot.data() || {};
    const existingClaim = claimSnapshot.exists ? claimSnapshot.data() || {} : null;
    if (activeSubscriptionRefundClaim(existingClaim, latestOrder, orderId)) {
      const review = refundEligibilityReviewDecision(latestOrder, requestBody);
      const reviewUpdate = refundEligibilityReviewUpdate(
        review,
        adminUid,
        admin.firestore.FieldValue.serverTimestamp()
      );
      if (Object.keys(reviewUpdate).length) transaction.update(orderRef, reviewUpdate);
      transaction.set(accountClaimRef, paymentAccountClaimPatch({
        uid: userRef.id,
        lane: 'activeSubscriptionRefunds',
        id: orderId,
        status: existingClaim.status,
        operationId: existingClaim.operationId,
        active: true
      }), { merge: true });
      return { ...existingClaim, resumed: true, claimRef };
    }
    if (latestOrder.status !== 'refund_requested') {
      throw Object.assign(new Error('REFUND_STATE_CHANGED'), {
        status: 409,
        code: 'REFUND_STATE_CHANGED',
        latestStatus: latestOrder.status || 'unknown'
      });
    }
    if (!userSnapshot.exists) {
      throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404, code: 'USER_NOT_FOUND' });
    }
    const latestUser = userSnapshot.data() || {};
    if (latestOrder.uid !== userRef.id) {
      throw Object.assign(new Error('ORDER_OWNER_MISMATCH'), { status: 409, code: 'ORDER_OWNER_MISMATCH' });
    }
    if (latestUser.subscriptionRefundLock) {
      throw Object.assign(new Error('SUBSCRIPTION_REFUND_LOCKED'), { status: 409, code: 'SUBSCRIPTION_REFUND_LOCKED' });
    }
    const paidAtMs = refundPaidAtMs(latestOrder, 'subscription');
    const context = currentSubscriptionRefundContext(latestUser, latestOrder, paidAtMs, orderId);
    if (!context.sameCycle) {
      throw Object.assign(new Error('SUBSCRIPTION_CYCLE_MISMATCH'), {
        status: 409,
        code: 'SUBSCRIPTION_CYCLE_MISMATCH'
      });
    }
    const calculation = calculateSubscriptionPolicyRefund({
      orderAmount: latestOrder.amount,
      tier: latestOrder.tier,
      coupon: context.coupon
    });
    if (calculation.refundAmount <= 0) {
      throw Object.assign(new Error('NO_REFUNDABLE_SUBSCRIPTION_AMOUNT'), {
        status: 400,
        code: 'NO_REFUNDABLE_SUBSCRIPTION_AMOUNT'
      });
    }
    const orderAmount = Math.max(0, Math.floor(Number(latestOrder.amount) || 0));
    const requestSequence = Math.max(1, Math.floor(Number(latestOrder.refundRequestSequence) || 1));
    const approvalAttempt = existingClaim?.status === 'provider_failed'
      ? Math.max(1, Math.floor(Number(existingClaim.approvalAttempt) || 1) + 1)
      : 1;
    const operationId = refundOperationId(
      orderId,
      0,
      calculation.refundAmount,
      0,
      `subscription-${requestSequence}-${approvalAttempt}`
    );
    const generationOrderId = context.currentOrderId || orderId;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const claim = {
      operationId,
      orderId,
      uid: latestOrder.uid,
      status: 'provider_canceling',
      refundAmount: calculation.refundAmount,
      usedCount: calculation.usedCount,
      settlementUses: calculation.settlementUses,
      isFullRefund: calculation.refundAmount >= orderAmount,
      generationOrderId,
      generationCycleStartedAtMs: context.cycleStartedAtMs,
      requestSequence,
      approvalAttempt,
      priorPlan: latestUser.plan || 'free',
      priorSubscription: context.subscription,
      priorCoupon: context.coupon,
      claimedBy: adminUid,
      createdAt: now,
      updatedAt: now
    };
    const review = refundEligibilityReviewDecision(latestOrder, requestBody);
    transaction.set(claimRef, claim);
    transaction.set(accountClaimRef, paymentAccountClaimPatch({
      uid: latestOrder.uid,
      lane: 'activeSubscriptionRefunds',
      id: orderId,
      status: 'provider_canceling',
      operationId,
      active: true
    }), { merge: true });
    transaction.update(orderRef, {
      status: 'refund_processing',
      subscriptionRefundProcessing: {
        operationId,
        phase: 'provider_canceling',
        refundAmount: calculation.refundAmount,
        usedCount: calculation.usedCount,
        settlementUses: calculation.settlementUses,
        generationOrderId,
        requestSequence,
        claimedAt: now,
        claimedBy: adminUid
      },
      ...refundEligibilityReviewUpdate(review, adminUid, now)
    });
    // Remove the subscription object while the provider cancellation is in flight.
    // commitCouponUsage reads this same document and fails when it is absent, which
    // also closes the unlimited-plan race that coupon.remaining alone cannot close.
    transaction.update(userRef, {
      plan: 'free',
      subscription: admin.firestore.FieldValue.delete(),
      coupon: {
        ...(context.coupon || {}),
        remaining: 0,
        used: calculation.usedCount
      },
      subscriptionRefundLock: {
        operationId,
        orderId,
        generationOrderId,
        lockedAt: now
      }
    });
    return { ...claim, resumed: false, claimRef };
  });
}

async function markSubscriptionRefundUnknown({ orderRef, claimRef, operationId, providerStatus }) {
  return db.runTransaction(async transaction => {
    const [orderSnapshot, claimSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(claimRef)
    ]);
    if (!orderSnapshot.exists || !claimSnapshot.exists) return false;
    const order = orderSnapshot.data() || {};
    const claim = claimSnapshot.data() || {};
    if (claim.operationId !== operationId || order.subscriptionRefundProcessing?.operationId !== operationId) {
      return false;
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.update(claimRef, {
      status: 'provider_status_unknown',
      providerStatus: providerStatus || null,
      updatedAt: now
    });
    transaction.update(orderRef, {
      'subscriptionRefundProcessing.phase': 'provider_status_unknown',
      'subscriptionRefundProcessing.providerStatus': providerStatus || null,
      'subscriptionRefundProcessing.updatedAt': now
    });
    transaction.set(
      db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(claim.uid),
      paymentAccountClaimPatch({
        uid: claim.uid,
        lane: 'activeSubscriptionRefunds',
        id: orderRef.id,
        status: 'provider_status_unknown',
        operationId,
        active: true
      }),
      { merge: true }
    );
    return true;
  });
}

async function compensateSubscriptionRefundClaim({ orderRef, userRef, claimRef, operationId, failureCode }) {
  return db.runTransaction(async transaction => {
    const [orderSnapshot, userSnapshot, claimSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(userRef),
      transaction.get(claimRef)
    ]);
    if (!orderSnapshot.exists || !claimSnapshot.exists) return { restored: false };
    const order = orderSnapshot.data() || {};
    const claim = claimSnapshot.data() || {};
    if (claim.operationId !== operationId || order.subscriptionRefundProcessing?.operationId !== operationId) {
      return { restored: false };
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    let restored = false;
    if (userSnapshot.exists) {
      const user = userSnapshot.data() || {};
      if (subscriptionRefundGenerationCanMutateUser(user, claim)) {
        transaction.update(userRef, {
          plan: claim.priorPlan || 'free',
          subscription: claim.priorSubscription || admin.firestore.FieldValue.delete(),
          coupon: claim.priorCoupon || admin.firestore.FieldValue.delete(),
          subscriptionRefundLock: admin.firestore.FieldValue.delete()
        });
        restored = true;
      } else if (user.subscriptionRefundLock?.operationId === operationId) {
        transaction.update(userRef, {
          subscriptionRefundLock: admin.firestore.FieldValue.delete()
        });
      }
    }
    transaction.update(orderRef, {
      status: 'refund_requested',
      subscriptionRefundProcessing: admin.firestore.FieldValue.delete(),
      refundApprovalFailureCode: String(failureCode || 'PROVIDER_CANCEL_FAILED').slice(0, 80),
      refundApprovalFailedAt: now
    });
    transaction.update(claimRef, {
      status: 'provider_failed',
      failureCode: String(failureCode || 'PROVIDER_CANCEL_FAILED').slice(0, 80),
      entitlementRestored: restored,
      updatedAt: now
    });
    transaction.set(
      db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(claim.uid),
      paymentAccountClaimPatch({
        uid: claim.uid,
        lane: 'activeSubscriptionRefunds',
        id: orderRef.id,
        status: 'provider_failed',
        operationId,
        active: false
      }),
      { merge: true }
    );
    return { restored };
  });
}

async function finalizeSubscriptionRefund({ orderRef, userRef, claimRef, operationId, adminUid }) {
  return db.runTransaction(async transaction => {
    const [orderSnapshot, userSnapshot, claimSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(userRef),
      transaction.get(claimRef)
    ]);
    if (!orderSnapshot.exists || !claimSnapshot.exists) {
      throw Object.assign(new Error('SUBSCRIPTION_REFUND_CLAIM_MISSING'), {
        status: 409,
        code: 'SUBSCRIPTION_REFUND_CLAIM_MISSING'
      });
    }
    const order = orderSnapshot.data() || {};
    const claim = claimSnapshot.data() || {};
    if (claim.operationId !== operationId) {
      throw Object.assign(new Error('SUBSCRIPTION_REFUND_OPERATION_CONFLICT'), {
        status: 409,
        code: 'SUBSCRIPTION_REFUND_OPERATION_CONFLICT'
      });
    }
    if (claim.status === 'finalized' && ['refunded', 'partially_refunded'].includes(order.status)) {
      return {
        alreadyFinalized: true,
        refundAmount: claim.refundAmount,
        isFullRefund: claim.isFullRefund === true,
        generationClosed: claim.generationClosed === true
      };
    }
    if (order.subscriptionRefundProcessing?.operationId !== operationId) {
      throw Object.assign(new Error('SUBSCRIPTION_REFUND_OPERATION_CONFLICT'), {
        status: 409,
        code: 'SUBSCRIPTION_REFUND_OPERATION_CONFLICT'
      });
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    let generationClosed = false;
    if (userSnapshot.exists) {
      const user = userSnapshot.data() || {};
      if (subscriptionRefundGenerationCanMutateUser(user, claim)) {
        transaction.update(userRef, {
          plan: 'free',
          subscription: {
            ...(claim.priorSubscription || {}),
            status: 'refunded',
            cancelledAt: now
          },
          coupon: {
            ...(claim.priorCoupon || {}),
            remaining: 0,
            used: claim.usedCount
          },
          subscriptionRefundLock: admin.firestore.FieldValue.delete()
        });
        generationClosed = true;
      } else if (user.subscriptionRefundLock?.operationId === operationId) {
        transaction.update(userRef, {
          subscriptionRefundLock: admin.firestore.FieldValue.delete()
        });
      }
      transaction.set(userRef.collection('couponHistory').doc(cancellationLedgerId(orderRef.id, claim.refundAmount)), {
        type: 'refund',
        tier: order.tier,
        amount: 0,
        remaining: generationClosed ? 0 : Math.max(0, Math.floor(Number(user.coupon?.remaining) || 0)),
        orderId: orderRef.id,
        used: claim.usedCount,
        refundAmount: claim.refundAmount,
        settlementUses: claim.settlementUses,
        generationClosed,
        createdAt: now
      }, { merge: true });
    }
    transaction.update(orderRef, {
      status: claim.isFullRefund ? 'refunded' : 'partially_refunded',
      refundAmount: claim.refundAmount,
      refundedAmount: claim.refundAmount,
      refundUsedCount: claim.usedCount,
      refundSettlementUses: claim.settlementUses,
      refundedAt: now,
      refundedBy: adminUid,
      subscriptionGenerationClosed: generationClosed,
      subscriptionRefundProcessing: admin.firestore.FieldValue.delete()
    });
    transaction.update(claimRef, {
      status: 'finalized',
      generationClosed,
      finalizedAt: now,
      updatedAt: now
    });
    transaction.set(
      db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(claim.uid),
      paymentAccountClaimPatch({
        uid: claim.uid,
        lane: 'activeSubscriptionRefunds',
        id: orderRef.id,
        status: 'finalized',
        operationId,
        active: false
      }),
      { merge: true }
    );
    return {
      alreadyFinalized: false,
      refundAmount: claim.refundAmount,
      isFullRefund: claim.isFullRefund === true,
      generationClosed
    };
  });
}

// 환불 요청 (사용자용) — kind: 'order' (기본, 크레딧 일회성) | 'subscription' (정기결제)
router.post('/request-refund', async (req, res) => {
  const { orderId, cancelReason, kind: rawKind } = req.body;
  const idToken = bearerToken(req);
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const uid = await verifyToken(idToken, { checkRevoked: true });
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });
  // 단순변심 청약철회에서 사용자 사유는 선택 입력이다. 관리자 직접 환불·거절
  // 사유는 운영 감사상 기존 필수 정책을 그대로 유지한다.
  const normalizedCancelReason = typeof cancelReason === 'string'
    ? cancelReason.trim().slice(0, 500)
    : '';

  try {
    const orderRef = getOrderRef(kind, orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

    const order = orderSnap.data();
    if (order.uid !== uid) return res.status(403).json({ error: '본인의 주문만 환불 요청할 수 있습니다.' });
    if (order.status === 'refund_requested') return res.status(400).json({ error: '이미 환불 요청 중입니다.' });
    if (order.status === 'refunded') return res.status(400).json({ error: '이미 환불 완료된 주문입니다.' });
    if (order.status !== 'paid') return res.status(400).json({ error: '환불할 수 없는 주문 상태입니다.' });
    const processingConflict = refundRequestProcessingConflict(order);
    if (processingConflict) {
      return res.status(409).json({
        error: processingConflict.message,
        code: processingConflict.code
      });
    }
    if (kind === 'order') {
      const upgradeConflict = activeUpgradeRefundConflict(order);
      if (upgradeConflict) {
        return res.status(upgradeConflict.status).json({
          error: upgradeConflict.message,
          code: upgradeConflict.code,
          upgradeOrderId: upgradeConflict.upgradeOrderId
        });
      }
      // 크레딧을 먼저 예약한 뒤 결제 참조가 없어 승인을 영구히 못 하는 상태를
      // 만들지 않는다. 서버 전용 보관소/공급자 복구까지 확인한 뒤에만 예약한다.
      const refundablePaymentKey = await readPaymentKey(orderRef.id, order);
      if (!refundablePaymentKey) {
        return res.status(409).json({
          error: '온라인 환불 처리에 필요한 결제정보를 확인할 수 없습니다. 크레딧은 차감되지 않았으며 고객센터에서 확인해 드립니다.',
          code: 'REFUND_PAYMENT_REFERENCE_UNAVAILABLE'
        });
      }
    }

    const windowState = refundWindowState(order, kind);
    if (!windowState.eligible && windowState.reason === 'PAYMENT_DATE_MISSING') {
      return res.status(400).json({
        error: '환불 신청 기간의 시작일을 확인할 수 없어 온라인으로 접수할 수 없습니다. 고객센터로 문의해 주세요.',
        code: windowState.reason
      });
    }
    // 7일 경과는 단순변심 자동 기준이 지났다는 뜻일 뿐, 표시·광고와 다른 제공이나
    // 잔액 환급 등 법령상 사유까지 일률적으로 배제하지 않는다. 요청은 접수하되
    // 관리자가 별도 자격을 확인할 수 있도록 플래그를 남긴다.
    let requiresEligibilityReview = !windowState.eligible
      && windowState.reason === 'REFUND_WINDOW_EXPIRED';

    let policySnapshot;
    let requestRefundPolicyVersion;
    let reservationOperationId = null;
    const requestStartedAtMs = Date.now();
    const refundUserRef = db.collection('users').doc(uid);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(uid);
    const accountClaimRef = db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(uid);

    // 정기결제 환불 자격: 결제일 7일 이내 + 이번 결제주기의 사용분 비례 공제
    if (kind === 'subscription') {
      requestRefundPolicyVersion = SUBSCRIPTION_REFUND_POLICY_VERSION;
      const subscriptionRequest = await db.runTransaction(async (transaction) => {
        const userRef = db.collection('users').doc(uid);
        const [latestSnap, latestUserSnap] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(userRef)
        ]);
        if (!latestSnap.exists) {
          throw Object.assign(new Error('주문을 찾을 수 없습니다.'), { status: 404, code: 'ORDER_NOT_FOUND' });
        }
        if (!latestUserSnap.exists) {
          throw Object.assign(new Error('사용자 계정을 찾을 수 없습니다.'), { status: 404, code: 'USER_NOT_FOUND' });
        }
        const latestOrder = latestSnap.data() || {};
        const latestUser = latestUserSnap.data() || {};
        if (latestOrder.uid !== uid) {
          throw Object.assign(new Error('본인의 주문만 환불 요청할 수 있습니다.'), { status: 403, code: 'ORDER_OWNER_MISMATCH' });
        }
        if (latestOrder.status !== 'paid') {
          throw Object.assign(new Error(`환불 요청 중 주문 상태가 변경됐습니다. 현재: ${latestOrder.status || 'unknown'}`), {
            status: 409,
            code: 'REFUND_STATE_CHANGED'
          });
        }
        const latestWindow = refundWindowState(latestOrder, kind, requestStartedAtMs);
        if (!latestWindow.eligible && latestWindow.reason === 'PAYMENT_DATE_MISSING') {
          throw Object.assign(new Error('환불 신청 기간의 시작일을 확인할 수 없습니다. 고객센터로 문의해 주세요.'), {
            status: 400,
            code: latestWindow.reason
          });
        }
        const latestContext = currentSubscriptionRefundContext(
          latestUser,
          latestOrder,
          latestWindow.paidAtMs,
          orderId
        );
        if (!latestContext.sameCycle) {
          throw Object.assign(new Error('현재 결제주기의 구독만 온라인 환불을 요청할 수 있습니다. 고객센터로 문의해주세요.'), {
            status: 409,
            code: 'SUBSCRIPTION_CYCLE_MISMATCH'
          });
        }
        const calculation = calculateSubscriptionPolicyRefund({
          orderAmount: latestOrder.amount,
          tier: latestOrder.tier,
          coupon: latestContext.coupon
        });
        if (calculation.refundAmount <= 0) {
          throw Object.assign(new Error(
            `이번 결제주기의 정산 기준 ${calculation.settlementUses}회를 모두 사용해 일반 환불 가능 금액이 없습니다. 서비스 오류는 고객센터로 문의해주세요.`
          ), { status: 400, code: 'NO_REFUNDABLE_SUBSCRIPTION_AMOUNT' });
        }
        const latestPolicySnapshot = {
          requestedRefundAmount: calculation.refundAmount,
          refundUsedCount: calculation.usedCount,
          refundSettlementUses: calculation.settlementUses
        };
        const refundRequestSequence = Math.max(0, Math.floor(Number(latestOrder.refundRequestSequence) || 0)) + 1;
        const latestRequiresEligibilityReview = !latestWindow.eligible
          && latestWindow.reason === 'REFUND_WINDOW_EXPIRED';
        transaction.update(orderRef, {
          status: 'refund_requested',
          cancelReason: normalizedCancelReason || admin.firestore.FieldValue.delete(),
          kind,
          refundPolicyVersion: requestRefundPolicyVersion,
          refundEligibilityReviewRequired: latestRequiresEligibilityReview,
          ...latestPolicySnapshot,
          refundRequestSequence,
          refundRequestSnapshot: {
            version: requestRefundPolicyVersion,
            requestedAtMs: requestStartedAtMs,
            requestedRefundAmount: latestPolicySnapshot.requestedRefundAmount,
            refundUsedCount: latestPolicySnapshot.refundUsedCount,
            refundSettlementUses: latestPolicySnapshot.refundSettlementUses,
            generationOrderId: orderId,
            generationCycleStartedAtMs: latestContext.cycleStartedAtMs
          },
          refundRequestedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return {
          requiresEligibilityReview: latestRequiresEligibilityReview,
          policySnapshot: latestPolicySnapshot
        };
      });
      requiresEligibilityReview = subscriptionRequest.requiresEligibilityReview;
      policySnapshot = subscriptionRequest.policySnapshot;
    } else {
      const result = await db.runTransaction(async (transaction) => {
        const [latestSnap, deletionJobSnapshot] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(deletionJobRef)
        ]);
        if (!latestSnap.exists) {
          throw Object.assign(new Error('주문을 찾을 수 없습니다.'), { status: 404, code: 'ORDER_NOT_FOUND' });
        }
        const latestOrder = latestSnap.data() || {};
        if (latestOrder.uid !== uid) {
          throw Object.assign(new Error('본인의 주문만 환불 요청할 수 있습니다.'), { status: 403, code: 'ORDER_OWNER_MISMATCH' });
        }
        if (deletionJobSnapshot.exists && accountDeletionBlocksPayment(deletionJobSnapshot.data())) {
          throw paymentAccountUnavailableError();
        }
        if (latestOrder.status !== 'paid') {
          throw Object.assign(new Error(`환불 요청 중 주문 상태가 변경됐습니다. 현재: ${latestOrder.status || 'unknown'}`), {
            status: 409,
            code: 'REFUND_STATE_CHANGED'
          });
        }
        const latestProcessingConflict = refundRequestProcessingConflict(latestOrder);
        if (latestProcessingConflict) {
          throw Object.assign(new Error(latestProcessingConflict.message), {
            status: latestProcessingConflict.status,
            code: latestProcessingConflict.code
          });
        }
        const latestWindow = refundWindowState(latestOrder, kind, requestStartedAtMs);
        if (!latestWindow.eligible && latestWindow.reason === 'PAYMENT_DATE_MISSING') {
          throw Object.assign(new Error('환불 신청 기간의 시작일을 확인할 수 없습니다. 고객센터로 문의해 주세요.'), {
            status: 400,
            code: latestWindow.reason
          });
        }
        const latestRequiresEligibilityReview = !latestWindow.eligible
          && latestWindow.reason === 'REFUND_WINDOW_EXPIRED';
        const upgradeConflict = activeUpgradeRefundConflict(latestOrder);
        if (upgradeConflict) throw upgradeConflict;

        const orderAmount = Math.max(0, Math.floor(Number(latestOrder.amount) || 0));
        const grant = creditRefundGrant(latestOrder);
        const priorRefundedAmount = Math.max(0, Math.floor(Number(latestOrder.refundedAmount ?? latestOrder.refundAmount) || 0));
        const priorRefundedCredits = Math.max(0, Math.floor(Number(latestOrder.refundedCredits) || 0));
        const remainingMoney = Math.max(0, orderAmount - priorRefundedAmount);
        const remainingOrderCredits = Math.max(0, grant.totalCredits - priorRefundedCredits);
        if (!orderAmount || !grant.totalCredits || !remainingMoney) {
          throw Object.assign(new Error('주문 데이터가 올바르지 않아 환불 계산이 불가합니다.'), {
            status: 400,
            code: 'INVALID_REFUND_ORDER'
          });
        }
        if (grant.usesBaseCreditPolicy
          && (priorRefundedAmount > 0 || latestOrder.refundCreditSettlementClosed === true)) {
          throw Object.assign(new Error('이 주문의 기준 크레딧 환불 정산은 이미 완료됐습니다.'), {
            status: 400,
            code: 'REFUND_SETTLED'
          });
        }

        const reserved = await reserveCreditRefundCredits({
          transaction,
          orderRef,
          userRef: refundUserRef,
          latestOrder,
          remainingOrderCredits
        });
        const calculation = reserved.calculation;
        const refundableCredits = reserved.refundableCredits;
        const refundAmount = Math.min(remainingMoney, calculation.refundAmount);
        if (refundAmount <= 0 || refundableCredits <= 0) {
          throw Object.assign(new Error('구매한 기준 크레딧을 모두 사용해 일반 환불 가능 금액이 없습니다. 서비스 오류는 고객센터로 문의해 주세요.'), {
            status: 400,
            code: 'NO_REFUNDABLE_CREDITS'
          });
        }

        const requestSequence = Math.max(0, Math.floor(Number(latestOrder.refundRequestSequence) || 0)) + 1;
        const operationId = refundOperationId(
          orderId,
          priorRefundedAmount,
          refundAmount,
          refundableCredits,
          `request-${requestSequence}`
        );
        // 구매 시 저장한 정책 버전을 요청 시점의 최신 상수로 덮지 않는다.
        // 구매 스냅샷이 없는 레거시 주문만 기존 문서 값/명시적 호환 버전으로 폴백한다.
        const requestPolicyVersion = latestOrder.refundPolicyVersionAtPurchase
          || latestOrder.refundPolicyVersion
          || (grant.usesBaseCreditPolicy ? REFUND_POLICY_VERSION : 'legacy-total-grant-v1');
        const snapshot = {
          requestedRefundAmount: refundAmount,
          requestedRefundCredits: refundableCredits,
          refundUsedCredits: calculation.usedCredits,
          refundUsedPaidCredits: calculation.usedPaidCredits,
          refundablePaidCredits: calculation.refundablePaidCredits,
          refundPaidCredits: calculation.paidCredits,
          refundBonusCredits: calculation.bonusCredits,
          recoveredBonusCredits: calculation.recoveredBonusCredits,
          refundCreditBasis: grant.refundCreditBasis,
          refundCalculationBasis: latestOrder.refundCalculationBasisAtPurchase
            || (grant.usesBaseCreditPolicy ? REFUND_CALCULATION_BASIS : 'legacy-total-grant-ratio-floor-v1'),
          refundBonusTreatment: latestOrder.refundBonusTreatmentAtPurchase
            || (grant.usesBaseCreditPolicy ? REFUND_BONUS_TREATMENT : 'legacy-proportional-total-grant-v1')
        };
        const operation = {
          operationId,
          priorRefundedAmount,
          priorRefundedCredits,
          refundAmount,
          creditsToDeduct: refundableCredits,
          targetRefundedAmount: priorRefundedAmount + refundAmount,
          targetRefundedCredits: priorRefundedCredits + refundableCredits,
          previousRefundPolicyVersion: latestOrder.refundPolicyVersion || null,
          previousRefundCreditBasis: latestOrder.refundCreditBasis || null,
          previousRefundCreditSettlementClosed: latestOrder.refundCreditSettlementClosed === true,
          previousOrderStatus: latestOrder.status || 'paid',
          ...reserved.processingLotFields
        };
        const now = admin.firestore.FieldValue.serverTimestamp();
        transaction.update(orderRef, {
          status: 'refund_requested',
          cancelReason: normalizedCancelReason || admin.firestore.FieldValue.delete(),
          kind,
          refundPolicyVersion: requestPolicyVersion || admin.firestore.FieldValue.delete(),
          refundEligibilityReviewRequired: latestRequiresEligibilityReview,
          ...snapshot,
          refundCreditSettlementClosed: true,
          ...reserved.orderLotUpdate,
          refundRequestSequence: requestSequence,
          refundRequestSnapshot: {
            version: requestPolicyVersion,
            sequence: requestSequence,
            requestedAtMs: requestStartedAtMs,
            operationId,
            ...snapshot,
            reservedPaidCredits: Math.max(0, Math.floor(Number(operation.reservedPaidCredits) || 0)),
            reservedBonusCredits: Math.max(0, Math.floor(Number(operation.reservedBonusCredits) || 0))
          },
          refundReservationState: 'reserved',
          refundReservationOperationId: operationId,
          refundRequestedAt: now,
          refundProcessing: creditRefundProcessing(operation, now, 'requested_reserved')
        });
        transaction.set(accountClaimRef, paymentAccountClaimPatch({
          uid,
          lane: 'activeCreditRefunds',
          id: orderId,
          status: 'requested_reserved',
          operationId,
          active: true
        }), { merge: true });
        return {
          policySnapshot: snapshot,
          requestPolicyVersion,
          operationId,
          requiresEligibilityReview: latestRequiresEligibilityReview
        };
      });
      policySnapshot = result.policySnapshot;
      requestRefundPolicyVersion = result.requestPolicyVersion;
      reservationOperationId = result.operationId;
      requiresEligibilityReview = result.requiresEligibilityReview;
    }

    logger.info('refund.requested', {
      uid,
      orderId,
      kind,
      reasonLength: normalizedCancelReason.length,
      reservationOperationId,
      requiresEligibilityReview
    });
    discord.refundRequest({
      uid,
      amount: order.amount,
      credits: order.safeCredits,
      reason: normalizedCancelReason || '사유 미입력',
      name: order.customerEmail
    });
    res.json({
      ok: true,
      message: '환불 요청이 접수되었습니다.',
      estimatedRefundAmount: policySnapshot.requestedRefundAmount,
      refundPolicyVersion: requestRefundPolicyVersion,
      requiresEligibilityReview
    });
  } catch (err) {
    logger.error('refund.request_failed', { uid, orderId, kind, err });
    const status = Number(err.status) || 500;
    res.status(status).json({
      error: status < 500 ? err.message : '서버 에러 발생',
      ...(err.code ? { code: err.code } : {})
    });
  }
});

// 환불 승인 (관리자용)
router.post('/approve-refund', async (req, res) => {
  const { orderId, kind: rawKind } = req.body;
  const idToken = bearerToken(req);
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const adminUid = await verifyAdminToken(idToken);
  if (adminUid === false) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid: adminUid, actorUid: adminUid });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });

  try {
    const orderRef = getOrderRef(kind, orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

    const order = orderSnap.data();
    if (kind === 'order') {
      const upgradeConflict = activeUpgradeRefundConflict(order);
      if (upgradeConflict) {
        return res.status(upgradeConflict.status).json({
          error: upgradeConflict.message,
          code: upgradeConflict.code,
          upgradeOrderId: upgradeConflict.upgradeOrderId
        });
      }
    }
    const paymentKey = await readPaymentKey(orderRef.id, order);   // ★ C-04
    const resumableSubscriptionApproval = kind === 'subscription'
      && order.status === 'refund_processing'
      && Boolean(order.subscriptionRefundProcessing?.operationId);
    if (order.status !== 'refund_requested' && !resumableSubscriptionApproval) {
      return res.status(400).json({ error: '환불 요청 상태가 아닙니다. 현재: ' + order.status });
    }
    if (!paymentKey) {
      return res.status(400).json({ error: 'paymentKey가 없어 환불할 수 없습니다. (이전 결제건)' });
    }
    const initialEligibilityReview = refundEligibilityReviewDecision(order, req.body || {});
    if (initialEligibilityReview.required && !initialEligibilityReview.accepted) {
      // 구형 관리자 화면은 검토 필드를 보내지 않는다. 승인을 새로 차단하지 않고
      // 미확인 상태를 그대로 보존·관측해 UI 배포 뒤 명시 검토로 전환한다.
      logger.warn('refund.eligibility_review_not_recorded', { orderId, kind, adminUid });
    }

    const userRef = db.collection('users').doc(order.uid);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(order.uid);
    const accountClaimRef = db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(order.uid);
    const basicToken = tossBasicToken(res);
    if (!basicToken) return;
    const tossUrl = `https://api.tosspayments.com/v1/payments/${paymentKey}/cancel`;

    if (kind === 'subscription') {
      // 환불 금액 계산과 이용권 동결을 같은 트랜잭션에서 수행한다. 사용 커밋도
      // users/{uid}를 읽고 쓰므로 동시 실행되면 한쪽이 재시도되고, 환불 계산 뒤
      // 추가 사용이 끼어들 수 없다. 동일 operationId는 관리자 중복 클릭과 응답
      // 유실 재시도에서도 결제사 취소를 한 번으로 수렴시킨다.
      let claim;
      try {
        claim = await claimSubscriptionRefund({
          orderRef,
          userRef,
          orderId,
          adminUid,
          requestBody: req.body || {}
        });
      } catch (claimError) {
        if (claimError.code === 'NO_REFUNDABLE_SUBSCRIPTION_AMOUNT') {
          return res.status(400).json({ error: '승인 전 추가 사용으로 환불 가능 금액이 남지 않았습니다.', code: claimError.code });
        }
        if (claimError.code === 'SUBSCRIPTION_CYCLE_MISMATCH') {
          return res.status(409).json({
            error: '현재 결제주기와 일치하지 않아 자동 환불할 수 없습니다. 과거 주문은 현재 구독에 영향을 주지 않습니다.',
            code: claimError.code
          });
        }
        if (claimError.code === 'REFUND_STATE_CHANGED') {
          return res.status(409).json({
            error: `환불 처리 중 주문 상태가 변경됐습니다. 현재: ${claimError.latestStatus || 'unknown'}`,
            code: claimError.code
          });
        }
        throw claimError;
      }
      const cancellation = await requestTossCancel({
        tossUrl,
        basicToken,
        operationId: claim.operationId,
        cancelReason: order.cancelReason || '고객 요청 환불',
        ...(claim.isFullRefund ? {} : { cancelAmount: claim.refundAmount })
      });
      const tossRes = cancellation.response;
      const tossResult = cancellation.result;
      const cancellationLookup = tossRes?.ok
        ? null
        : await queryTossOrder({ basicToken, orderId });
      const cancellationState = tossCancellationState({
        response: tossRes,
        lookup: cancellationLookup,
        targetRefundedAmount: claim.refundAmount
      });
      if (cancellationState.unknown) {
        await markSubscriptionRefundUnknown({
          orderRef,
          claimRef: claim.claimRef,
          operationId: claim.operationId,
          providerStatus: tossRes?.status || null
        });
        logger.error('refund.subscription_cancel_status_unknown', {
          orderId,
          uid: order.uid,
          operationId: claim.operationId,
          status: tossRes?.status || null,
          networkError: cancellation.networkError?.message || null,
          lookupStatus: cancellationLookup?.response?.status || null
        });
        return res.status(502).json({
          error: '결제사 환불 결과 확인이 지연되고 있습니다. 다시 승인하면 중복 환불 없이 이어서 확인합니다.',
          code: 'REFUND_STATUS_UNKNOWN',
          retryable: true
        });
      }
      if (!cancellationState.confirmed) {
        const failureCode = String(tossResult?.code || `TOSS_${tossRes?.status || 0}`);
        await compensateSubscriptionRefundClaim({
          orderRef,
          userRef,
          claimRef: claim.claimRef,
          operationId: claim.operationId,
          failureCode
        });
        logger.error('refund.toss_cancel_failed', {
          orderId,
          kind,
          uid: order.uid,
          status: tossRes?.status || null,
          operationId: claim.operationId,
          toss: providerResultSummary(tossResult)
        });
        return res.status(tossRes?.status || 502).json({
          error: '토스 환불 처리 실패: ' + (tossResult?.message || '알 수 없는 오류')
        });
      }

      const finalized = await finalizeSubscriptionRefund({
        orderRef,
        userRef,
        claimRef: claim.claimRef,
        operationId: claim.operationId,
        adminUid
      });
      logger.info('refund.subscription_approved', {
        orderId,
        uid: order.uid,
        adminUid,
        tier: order.tier,
        refundAmount: claim.refundAmount,
        usedCount: claim.usedCount,
        settlementUses: claim.settlementUses,
        generationClosed: finalized.generationClosed,
        resumed: claim.resumed
      });
      return res.json({
        ok: true,
        message: '환불이 완료되었습니다.',
        refundAmount: claim.refundAmount,
        partiallyRefunded: !claim.isFullRefund
      });
    }

    // 크레딧 부분환불: 토스 호출 전에 트랜잭션으로 선차감 → 토스 → 확정/보상
    const orderAmount = parseInt(order.amount);
    const safeCreditsTotal = creditRefundGrant(order).totalCredits;
    if (!Number.isFinite(orderAmount) || orderAmount <= 0 ||
        !Number.isFinite(safeCreditsTotal) || safeCreditsTotal <= 0) {
      return res.status(400).json({ error: '주문 데이터가 올바르지 않아 환불 계산이 불가합니다.' });
    }
    let refundAmount, refundableCredits, priorRefundedAmount, priorRefundedCredits;
    let cumulativeRefundAmount, cumulativeRefundCredits, operationId;
    let previousRefundPolicyVersion, previousRefundCreditBasis, previousRefundCreditSettlementClosed;
    try {
      const result = await db.runTransaction(async (transaction) => {
        const [latestOrderSnapshot, deletionJobSnapshot] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(deletionJobRef)
        ]);
        if (!latestOrderSnapshot.exists) throw new Error('ORDER_NOT_FOUND');
        if (deletionJobSnapshot.exists && accountDeletionBlocksPayment(deletionJobSnapshot.data())) {
          throw paymentAccountUnavailableError();
        }
        const latestOrder = latestOrderSnapshot.data() || {};
        const latestEligibilityReview = refundEligibilityReviewDecision(latestOrder, req.body || {});
        const eligibilityReviewUpdate = refundEligibilityReviewUpdate(
          latestEligibilityReview,
          adminUid,
          admin.firestore.FieldValue.serverTimestamp()
        );
        const resumable = resumableCreditRefund(latestOrder);
        if (resumable) {
          const resumeUpdate = { ...eligibilityReviewUpdate };
          if (resumable.phase === 'requested_reserved') {
            Object.assign(resumeUpdate, {
              'refundProcessing.phase': 'provider_canceling',
              'refundProcessing.providerStartedAt': admin.firestore.FieldValue.serverTimestamp(),
              refundReservationState: 'provider_canceling'
            });
          }
          if (Object.keys(resumeUpdate).length) transaction.update(orderRef, resumeUpdate);
          transaction.set(accountClaimRef, paymentAccountClaimPatch({
            uid: order.uid,
            lane: 'activeCreditRefunds',
            id: orderRef.id,
            status: 'provider_canceling',
            operationId: resumable.operationId,
            active: true
          }), { merge: true });
          return {
            ...resumable,
            refundAmount: resumable.refundAmount,
            refundableCredits: resumable.creditsToDeduct,
            resumed: true
          };
        }
        if (latestOrder.status !== 'refund_requested') {
          throw Object.assign(new Error('REFUND_STATE_CHANGED'), { latestStatus: latestOrder.status || 'unknown' });
        }
        const upgradeConflict = activeUpgradeRefundConflict(latestOrder);
        if (upgradeConflict) throw upgradeConflict;
        const refundGrant = creditRefundGrant(latestOrder);

        const priorAmount = Math.max(0, Math.floor(Number(latestOrder.refundedAmount ?? latestOrder.refundAmount) || 0));
        const priorCredits = Math.max(0, Math.floor(Number(latestOrder.refundedCredits) || 0));
        const remainingMoney = Math.max(0, orderAmount - priorAmount);
        const remainingOrderCredits = Math.max(0, safeCreditsTotal - priorCredits);
        if (remainingMoney <= 0) throw new Error('ALREADY_REFUNDED');
        if (refundGrant.usesBaseCreditPolicy && (priorAmount > 0 || latestOrder.refundCreditSettlementClosed === true)) {
          throw new Error('REFUND_SETTLED');
        }
        const reserved = await reserveCreditRefundCredits({
          transaction,
          orderRef,
          userRef,
          latestOrder,
          remainingOrderCredits
        });
        const policyCalculation = reserved.calculation;
        const refundable = reserved.refundableCredits;
        if (refundable <= 0 || policyCalculation.refundAmount <= 0) throw new Error('NO_REFUNDABLE');
        const amount = Math.min(remainingMoney, policyCalculation.refundAmount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
        const targetRefundedAmount = priorAmount + amount;
        const targetRefundedCredits = priorCredits + refundable;
        const nextOperationId = refundOperationId(orderId, priorAmount, amount, refundable);
        const operation = {
          operationId: nextOperationId,
          priorRefundedAmount: priorAmount,
          priorRefundedCredits: priorCredits,
          refundAmount: amount,
          creditsToDeduct: refundable,
          targetRefundedAmount,
          targetRefundedCredits,
          previousRefundPolicyVersion: latestOrder.refundPolicyVersion || null,
          previousRefundCreditBasis: latestOrder.refundCreditBasis || null,
          previousRefundCreditSettlementClosed: latestOrder.refundCreditSettlementClosed === true,
          previousOrderStatus: latestOrder.status || 'refund_requested',
          ...reserved.processingLotFields
        };
        transaction.update(orderRef, {
          refundAmount: targetRefundedAmount,
          refundedAmount: targetRefundedAmount,
          refundedCredits: targetRefundedCredits,
          refundPolicyVersion: refundPolicyVersionForOrder(latestOrder, refundGrant.usesBaseCreditPolicy),
          refundCreditBasis: refundGrant.refundCreditBasis,
          refundUsedPaidCredits: policyCalculation ? policyCalculation.usedPaidCredits : admin.firestore.FieldValue.delete(),
          refundablePaidCredits: policyCalculation ? policyCalculation.refundablePaidCredits : admin.firestore.FieldValue.delete(),
          recoveredBonusCredits: policyCalculation ? policyCalculation.recoveredBonusCredits : admin.firestore.FieldValue.delete(),
          refundCreditSettlementClosed: policyCalculation ? true : admin.firestore.FieldValue.delete(),
          ...eligibilityReviewUpdate,
          ...reserved.orderLotUpdate,
          refundProcessing: creditRefundProcessing(operation, admin.firestore.FieldValue.serverTimestamp())
        });
        transaction.set(accountClaimRef, paymentAccountClaimPatch({
          uid: order.uid,
          lane: 'activeCreditRefunds',
          id: orderRef.id,
          status: 'provider_canceling',
          operationId: nextOperationId,
          active: true
        }), { merge: true });
        return {
          ...operation,
          refundAmount: amount,
          refundableCredits: refundable,
          usedPaidCredits: policyCalculation ? policyCalculation.usedPaidCredits : null,
          recoveredBonusCredits: policyCalculation ? policyCalculation.recoveredBonusCredits : 0,
          resumed: false
        };
      });
      refundAmount = result.refundAmount;
      refundableCredits = result.refundableCredits;
      priorRefundedAmount = result.priorRefundedAmount;
      priorRefundedCredits = result.priorRefundedCredits;
      cumulativeRefundAmount = result.targetRefundedAmount;
      cumulativeRefundCredits = result.targetRefundedCredits;
      operationId = result.operationId;
      previousRefundPolicyVersion = result.previousRefundPolicyVersion;
      previousRefundCreditBasis = result.previousRefundCreditBasis;
      previousRefundCreditSettlementClosed = result.previousRefundCreditSettlementClosed === true;
    } catch (e) {
      if (e.message === 'NO_REFUNDABLE') {
        return res.status(400).json({ error: '이미 모든 크레딧을 사용해 환불 가능 금액이 없습니다.' });
      }
      if (e.message === 'INVALID_AMOUNT') {
        return res.status(400).json({ error: '환불 금액 계산 오류' });
      }
      if (e.message === 'ALREADY_REFUNDED') {
        return res.status(400).json({ error: '이미 전액 환불된 주문입니다.' });
      }
      if (e.message === 'REFUND_SETTLED') {
        return res.status(400).json({ error: '이 주문의 기준 크레딧 환불 정산은 이미 완료됐습니다.' });
      }
      if (e.message === 'REFUND_STATE_CHANGED') {
        return res.status(409).json({
          error: `환불 처리 중 주문 상태가 변경됐습니다. 현재: ${e.latestStatus || 'unknown'}`,
          code: 'REFUND_STATE_CHANGED'
        });
      }
      throw e;
    }

    const cancellation = await requestTossCancel({
      tossUrl,
      basicToken,
      operationId,
      cancelReason: order.cancelReason || '고객 요청 환불',
      cancelAmount: refundAmount
    });
    const tossRes = cancellation.response;
    const tossResult = cancellation.result;
    let cancellationLookup = null;
    if (!tossRes?.ok) {
      cancellationLookup = await queryTossOrder({ basicToken, orderId });
    }
    const cancellationState = tossCancellationState({
      response: tossRes,
      lookup: cancellationLookup,
      targetRefundedAmount: cumulativeRefundAmount
    });

    if (cancellationState.unknown) {
      logger.error('refund.toss_cancel_status_unknown', {
        orderId,
        kind,
        uid: order.uid,
        operationId,
        status: tossRes?.status || null,
        networkError: cancellation.networkError?.message || null,
        toss: providerResultSummary(tossResult),
        lookupStatus: cancellationLookup?.response?.status || null,
        providerCanceledAmount: cancellationState.lookupCanceledAmount
      });
      return res.status(502).json({
        error: '결제사 환불 결과 확인이 지연되고 있습니다. 다시 승인하면 중복 차감 없이 이어서 확인합니다.',
        code: 'REFUND_STATUS_UNKNOWN',
        retryable: true
      });
    }

    if (!cancellationState.confirmed) {
      // 보상: 선차감한 크레딧 복구 + 임시 필드 제거
      try {
        await compensateCreditRefundReservation({
          orderRef,
          userRef,
          operationId,
          restoreReason: 'provider_cancel_failed',
          orderUpdate: {
            status: 'paid',
            refundApprovalFailedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        });
      } catch (compErr) {
        logger.error('refund.compensation_failed_manual_action', {
          orderId, uid: order.uid, refundableCredits, refundAmount, compErr
        });
      }
      logger.error('refund.toss_cancel_failed', {
        orderId,
        kind,
        uid: order.uid,
        status: tossRes.status,
        toss: providerResultSummary(tossResult)
      });
      return res.status(tossRes.status).json({
        error: '토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')
      });
    }

    const finalized = await db.runTransaction(async (transaction) => {
      const latestOrderSnapshot = await transaction.get(orderRef);
      if (!latestOrderSnapshot.exists) throw Object.assign(new Error('ORDER_NOT_FOUND'), { status: 404 });
      const latestOrder = latestOrderSnapshot.data() || {};
      const decision = creditRefundFinalizeDecision(latestOrder, {
        operationId,
        targetRefundedAmount: cumulativeRefundAmount,
        orderAmount
      });
      const userSnap = await transaction.get(userRef);
      const sourceOrderRef = latestOrder.purchaseKind === STARTER_UPGRADE.kind && latestOrder.sourceOrderId
        ? db.collection('orders').doc(latestOrder.sourceOrderId)
        : null;
      const sourceOrderSnap = sourceOrderRef ? await transaction.get(sourceOrderRef) : null;
      const remainingCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
      if (!decision.ok) {
        throw Object.assign(new Error('REFUND_FINALIZE_CONFLICT'), { status: 409 });
      }
      if (decision.alreadyFinalized) {
        const finalRefundedCredits = Math.max(
          0,
          Math.floor(Number(latestOrder.refundedCredits) || 0),
          Math.floor(Number(cumulativeRefundCredits) || 0)
        );
        if (latestOrder.refundProcessing
          || latestOrder.refundReservationState !== 'settled'
          || Number(latestOrder.refundedCredits) !== finalRefundedCredits) {
          transaction.update(orderRef, {
            refundedCredits: finalRefundedCredits,
            refundReservationState: 'settled',
            refundReservationOperationId: operationId,
            refundReservationSettledAt: admin.firestore.FieldValue.serverTimestamp(),
            refundProcessing: admin.firestore.FieldValue.delete()
          });
        }
        transaction.set(accountClaimRef, paymentAccountClaimPatch({
          uid: order.uid,
          lane: 'activeCreditRefunds',
          id: orderRef.id,
          status: 'settled',
          operationId,
          active: false
        }), { merge: true });
        return {
          alreadyFinalized: true,
          refundedAmount: decision.finalRefundedAmount,
          fullyRefunded: decision.fullyRefunded
        };
      }
      const finalRefundedAmount = decision.finalRefundedAmount;
      const fullyRefunded = decision.fullyRefunded;
      transaction.update(orderRef, {
        status: fullyRefunded ? 'refunded' : 'partially_refunded',
        refundAmount: finalRefundedAmount,
        refundedAmount: finalRefundedAmount,
        refundedCredits: Math.max(0, Math.floor(Number(cumulativeRefundCredits) || 0)),
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundedBy: adminUid,
        refundReservationState: 'settled',
        refundReservationOperationId: operationId,
        refundReservationSettledAt: admin.firestore.FieldValue.serverTimestamp(),
        refundProcessing: admin.firestore.FieldValue.delete()
      });
      transaction.set(accountClaimRef, paymentAccountClaimPatch({
        uid: order.uid,
        lane: 'activeCreditRefunds',
        id: orderRef.id,
        status: 'settled',
        operationId,
        active: false
      }), { merge: true });
      if (fullyRefunded && sourceOrderRef && sourceOrderSnap?.exists
        && sourceOrderSnap.data()?.activeUpgradeOrderId === orderRef.id) {
        transaction.update(sourceOrderRef, {
          activeUpgradeOrderId: admin.firestore.FieldValue.delete(),
          upgradeRefundedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      const historyRef = db.collection('users').doc(order.uid).collection('creditHistory')
        .doc(cancellationLedgerId(orderId, finalRefundedAmount));
      transaction.set(historyRef, {
        type: 'refund',
        used: 0,
        amount: -refundableCredits,
        remaining: remainingCredits,
        orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { alreadyFinalized: false, refundedAmount: finalRefundedAmount, fullyRefunded };
    });

    logger.info('refund.credit_approved', {
      orderId,
      uid: order.uid,
      adminUid,
      refundableCredits,
      refundAmount
    });
    res.json({
      ok: true,
      message: '환불이 완료되었습니다.',
      refundAmount,
      partiallyRefunded: !finalized.fullyRefunded
    });
  } catch (err) {
    logger.error('refund.approve_failed', { orderId, kind, adminUid, err });
    const status = Number(err.status) || 500;
    res.status(status).json({
      error: status < 500
        ? (err.message === 'REFUND_FINALIZE_CONFLICT'
          ? '환불 상태가 다른 처리와 충돌했습니다. 결제사 누적 취소액을 확인한 뒤 다시 시도해주세요.'
          : err.message)
        : '서버 에러 발생',
      ...(err.code
        ? { code: err.code }
        : (err.message === 'REFUND_FINALIZE_CONFLICT' ? { code: 'REFUND_FINALIZE_CONFLICT' } : {}))
    });
  }
});

// 환불 거절 (관리자용)
router.post('/reject-refund', async (req, res) => {
  const { orderId, rejectReason, kind: rawKind } = req.body;
  const idToken = bearerToken(req);
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const adminUid = await verifyAdminToken(idToken);
  if (adminUid === false) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid: adminUid, actorUid: adminUid });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });
  if (!rejectReason || rejectReason.trim().length < 2) {
    return res.status(400).json({ error: '거절 사유를 입력해주세요.' });
  }

  try {
    const orderRef = getOrderRef(kind, orderId);
    const rejection = await db.runTransaction(async (transaction) => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw Object.assign(new Error('주문을 찾을 수 없습니다.'), { status: 404, code: 'ORDER_NOT_FOUND' });
      }
      const order = orderSnap.data() || {};
      if (order.status === 'refund_rejected'
        && (!order.refundProcessing || order.refundReservationState === 'restored')) {
        return { alreadyRejected: true, restored: false };
      }
      if (order.status !== 'refund_requested') {
        throw Object.assign(new Error(`환불 요청 상태가 아닙니다. 현재: ${order.status || 'unknown'}`), {
          status: 409,
          code: 'REFUND_STATE_CHANGED'
        });
      }
      const rejectionUpdate = {
        status: 'refund_rejected',
        rejectReason: rejectReason.trim(),
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        rejectedBy: adminUid
      };
      if (kind === 'order' && order.refundProcessing) {
        const processing = resumableCreditRefund(order);
        if (!processing || processing.phase !== 'requested_reserved') {
          throw Object.assign(new Error('결제사 환불 처리가 이미 시작되어 거절할 수 없습니다.'), {
            status: 409,
            code: 'REFUND_PROCESSING'
          });
        }
        const restored = await restoreCreditRefundReservationInTransaction({
          transaction,
          orderRef,
          userRef: db.collection('users').doc(order.uid),
          latestOrder: order,
          operationId: processing.operationId,
          accountClaimRef: db.collection(PAYMENT_ACCOUNT_CLAIMS_COLLECTION).doc(order.uid),
          restoreReason: 'admin_rejected',
          orderUpdate: rejectionUpdate
        });
        if (!restored.restored && !restored.alreadyRestored) throw creditLotMismatchError();
        return { alreadyRejected: false, restored: restored.restored };
      }
      transaction.update(orderRef, rejectionUpdate);
      return { alreadyRejected: false, restored: false };
    });

    logger.info('refund.rejected', {
      orderId,
      kind,
      adminUid,
      restoredReservation: rejection.restored === true,
      alreadyRejected: rejection.alreadyRejected === true,
      rejectReasonLength: rejectReason.trim().length
    });
    res.json({
      ok: true,
      alreadyRejected: rejection.alreadyRejected === true,
      message: rejection.alreadyRejected ? '이미 거절 처리된 환불 요청입니다.' : '환불 요청이 거절되었습니다.'
    });
  } catch (err) {
    logger.error('refund.reject_failed', { orderId, kind, adminUid, err });
    const status = Number(err.status) || 500;
    res.status(status).json({
      error: status < 500 ? err.message : '서버 에러 발생',
      ...(err.code ? { code: err.code } : {})
    });
  }
});

// --- 친구 추천 ---
const REFERRAL_REWARD_CREDITS = 20;
const REFERRAL_DAILY_INVITER_LIMIT = 50;
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{8}$/u;

function normalizeReferralCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return REFERRAL_CODE_PATTERN.test(code) ? code : '';
}

function referralUtcDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function sameSignupClientPrincipal(inviteeSecurity, inviterSecurity) {
  const invitee = typeof inviteeSecurity?.signupClientPrincipal === 'string'
    ? inviteeSecurity.signupClientPrincipal.trim()
    : '';
  const inviter = typeof inviterSecurity?.signupClientPrincipal === 'string'
    ? inviterSecurity.signupClientPrincipal.trim()
    : '';
  // Older accounts do not have accountSecurity. Keep compatibility unless both
  // server-generated principals exist and conclusively match.
  return Boolean(invitee && inviter && invitee === inviter);
}

function referralError(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}

router.post('/apply-referral', async (req, res) => {
  try {
    const refCode = normalizeReferralCode(req.body?.refCode);
    const idToken = bearerToken(req);
    if (!idToken) return res.status(401).json({ error: '로그인이 필요합니다.' });
    if (!refCode) {
      return res.status(400).json({
        error: '추천 코드는 영문·숫자·밑줄·하이픈으로 된 8자리여야 합니다.',
        code: 'REFERRAL_CODE_INVALID'
      });
    }

    const decoded = await verifyFirebaseIdToken(idToken, { checkRevoked: true });
    const newUid = decoded.uid;
    setLogContext({ uid: newUid });

    // The query only identifies a candidate UID. Every authoritative check is
    // repeated inside the transaction. Ambiguous 8-character prefixes fail
    // closed instead of crediting an arbitrary account.
    const referrerSnap = await db.collection('users').where('refCode', '==', refCode).limit(2).get();
    if (referrerSnap.empty) return res.status(400).json({ error: '유효하지 않은 추천 코드' });
    if (referrerSnap.size !== 1) {
      return res.status(409).json({
        error: '추천 코드를 확인할 수 없습니다. 고객센터로 문의해 주세요.',
        code: 'REFERRAL_CODE_AMBIGUOUS'
      });
    }
    const referrerUid = referrerSnap.docs[0].id;
    if (referrerUid === newUid) return res.status(400).json({ error: '본인 추천 불가' });

    // All reads precede all writes. This makes referredBy, signup-principal,
    // account-deletion guards, and the per-inviter UTC-day quota one atomic
    // award decision under concurrent requests.
    const now = admin.firestore.FieldValue.serverTimestamp();
    const nowMs = Date.now();
    const utcDay = referralUtcDay(nowMs);
    const result = await db.runTransaction(async (t) => {
      const newRef = db.collection('users').doc(newUid);
      const refRef = db.collection('users').doc(referrerUid);
      const inviteeSecurityRef = db.collection('accountSecurity').doc(newUid);
      const inviterSecurityRef = db.collection('accountSecurity').doc(referrerUid);
      const inviteeDeletionRef = db.collection('accountDeletionJobs').doc(newUid);
      const inviterDeletionRef = db.collection('accountDeletionJobs').doc(referrerUid);
      const dailyRef = db.collection('referralDaily').doc(`${referrerUid}_${utcDay}`);
      const [
        newSnap,
        refSnap,
        inviteeSecuritySnap,
        inviterSecuritySnap,
        inviteeDeletionSnap,
        inviterDeletionSnap,
        dailySnap
      ] = await Promise.all([
        t.get(newRef),
        t.get(refRef),
        t.get(inviteeSecurityRef),
        t.get(inviterSecurityRef),
        t.get(inviteeDeletionRef),
        t.get(inviterDeletionRef),
        t.get(dailyRef)
      ]);
      if (!newSnap.exists || !refSnap.exists) {
        throw referralError(404, 'REFERRAL_USER_NOT_FOUND', '추천 계정을 확인할 수 없습니다.');
      }
      const newUser = newSnap.data() || {};
      const referrer = refSnap.data() || {};
      if (newUid === referrerUid || newUser.refCode === refCode) {
        throw referralError(400, 'REFERRAL_SELF', '본인 추천 불가');
      }
      if (referrer.refCode !== refCode) {
        throw referralError(409, 'REFERRAL_CODE_OWNER_CHANGED', '추천 코드 소유자가 변경됐습니다.');
      }
      if (newUser.referredBy) return { applied: false };
      if ((inviteeDeletionSnap.exists && accountDeletionBlocksPayment(inviteeDeletionSnap.data(), nowMs))
        || (inviterDeletionSnap.exists && accountDeletionBlocksPayment(inviterDeletionSnap.data(), nowMs))) {
        throw referralError(409, 'REFERRAL_ACCOUNT_UNAVAILABLE', '탈퇴 처리 중인 계정에는 추천을 적용할 수 없습니다.');
      }
      if (sameSignupClientPrincipal(
        inviteeSecuritySnap.exists ? inviteeSecuritySnap.data() : null,
        inviterSecuritySnap.exists ? inviterSecuritySnap.data() : null
      )) {
        throw referralError(409, 'REFERRAL_SAME_SIGNUP_PRINCIPAL', '동일한 가입 환경의 계정에는 추천을 적용할 수 없습니다.');
      }
      const dailyCount = Math.max(0, Math.floor(Number(dailySnap.data()?.count) || 0));
      if (dailyCount >= REFERRAL_DAILY_INVITER_LIMIT) {
        throw referralError(429, 'REFERRAL_DAILY_LIMIT', '오늘 적용할 수 있는 추천 보상 한도를 초과했습니다.');
      }

      const newUserCredits = (Number(newUser.credits) || 0) + REFERRAL_REWARD_CREDITS;
      const referrerCredits = (Number(referrer.credits) || 0) + REFERRAL_REWARD_CREDITS;
      t.update(newRef, {
        credits: admin.firestore.FieldValue.increment(REFERRAL_REWARD_CREDITS),
        referredBy: refCode,
        referredByUid: referrerUid
      });
      t.update(refRef, { credits: admin.firestore.FieldValue.increment(REFERRAL_REWARD_CREDITS) });
      t.set(dailyRef, {
        inviterUid: referrerUid,
        utcDay,
        count: dailyCount + 1,
        updatedAt: now
      }, { merge: true });
      t.set(newRef.collection('creditHistory').doc('referral_' + newUid), {
        type: 'referral', used: 0, amount: REFERRAL_REWARD_CREDITS, remaining: newUserCredits,
        detail: '친구 추천 보상 (가입)', createdAt: now
      });
      t.set(refRef.collection('creditHistory').doc('referral_from_' + newUid), {
        type: 'referral', used: 0, amount: REFERRAL_REWARD_CREDITS, remaining: referrerCredits,
        detail: '친구 추천 보상 (초대)', createdAt: now
      });
      return {
        applied: true,
        inviteeName: newUser.name || newUid,
        inviterName: referrer.name || referrerUid
      };
    });

    if (!result.applied) return res.status(400).json({ error: '이미 추천 적용됨' });
    logger.info('referral.applied', {
      referrerUid,
      newUid,
      credits: REFERRAL_REWARD_CREDITS,
      utcDay
    });
    try { discord.referral({ inviter: result.inviterName, invitee: result.inviteeName }); } catch {}
    res.json({ ok: true });
  } catch (err) {
    logger.error('referral.failed', { err });
    const status = Number(err.status) || (String(err.code || '').startsWith('auth/') ? 401 : 500);
    res.status(status).json({
      error: status < 500 ? err.message : '추천 처리 실패',
      ...(err.code && status < 500 ? { code: err.code } : {})
    });
  }
});

router.serializeAdminJobDoc = serializeAdminJobDoc;   // 축약 관측 계약 테스트용
router.buildHumanizeQualityReport = buildHumanizeQualityReport;
router.adminHistoryPolicy = {
  serializeOrderDoc,
  splitAdminCreditHistory,
  creditLedgerDelta
};
router.adminLedgerTaskPolicy = {
  classifyAdminLedgerTask,
  serializeAdminLedgerTaskLedger,
  serializeAdminLedgerTaskHistory,
  serializeAdminLedgerTaskEngineMeta,
  serializeAdminLedgerTaskArchive,
  serializeAdminLedgerTaskOps,
  loadAdminLedgerTaskOps
};
router.creditGrantPolicy = {
  assertPaymentIntentAllowsCreditGrant,
  paymentIntentGrant,
  paymentCallbackBindingHash,
  accountDeletionBlocksPayment,
  paymentIntentPreclaimExpired,
  upgradeCheckoutReservationPatch,
  paymentReconciliationClaimable,
  paymentIntentProviderMatches
};
router.referralPolicy = {
  REFERRAL_REWARD_CREDITS,
  REFERRAL_DAILY_INVITER_LIMIT,
  normalizeReferralCode,
  referralUtcDay,
  sameSignupClientPrincipal
};
router.refundPolicy = {
  TERMS_POLICY_VERSION,
  REFUND_POLICY_VERSION,
  SUBSCRIPTION_REFUND_POLICY_VERSION,
  REFUND_WINDOW_DAYS,
  REFUND_WINDOW_MS,
  REFUND_WINDOW_BASIS,
  REFUND_CALCULATION_BASIS,
  REFUND_BONUS_TREATMENT,
  UNLIMITED_REFUND_SETTLEMENT_USES,
  refundWindowLegalDeadlineMs,
  buildRefundPolicyPurchaseSnapshot,
  refundWindowSnapshotAnchorMs,
  refundPaidAtMs,
  refundWindowState,
  refundEligibilityReviewDecision,
  refundEligibilityReviewUpdate,
  refundRequestProcessingConflict,
  resumableCreditRefund,
  creditRefundProcessing,
  reserveCreditRefundCredits,
  restoreCreditRefundReservationInTransaction,
  tossCancellationState,
  creditRefundFinalizeDecision,
  creditRefundGrant,
  refundPolicyVersionForOrder,
  calculateCreditPolicyRefund,
  calculateOrderCreditRefund,
  calculateSubscriptionPolicyRefund,
  currentSubscriptionRefundContext,
  activeSubscriptionRefundClaim,
  subscriptionRefundGenerationCanMutateUser,
  activeUpgradeRefundConflict
};

module.exports = router;
