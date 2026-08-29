// [결제] 토스페이먼츠 결제 확인 + Firebase 크레딧 지급 처리

const express = require('express');
const { admin, db, ADMIN_UIDS, verifyToken, verifyFirebaseIdToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const metaConversions = require('../lib/metaConversions');
const { realClientIp } = require('../lib/clientip');
const { getRevenue } = require('../lib/revenue');
const detectCalibration = require('../lib/detectCalibration');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { buildHumanizeQualityReport } = require('../lib/humanizeQualityReport');
const {
  buildCheckoutContext,
  getCreditProduct
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
const gptAnalyze = require('./analyze-gpt');

const router = express.Router();
const JOB_ARCHIVE_COLLECTION = 'transformJobArchive';
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

async function getCreditOrdersForUser(uid, limit = 100) {
  const snap = await db.collection('orders').where('uid', '==', uid).limit(limit).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function parseProviderJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function markPaymentIntent(orderId, status, fields = {}) {
  await db.collection('paymentIntents').doc(orderId).set({
    status,
    ...fields,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function bestEffortMarkPaymentIntent(orderId, status, fields = {}) {
  try {
    await markPaymentIntent(orderId, status, fields);
  } catch (err) {
    logger.error('payment.intent_update_failed', { orderId, status, err });
  }
}

function paymentIntentGrant(existing, creditGrant) {
  const storedPaid = Number(existing && existing.paidCredits);
  const storedTotal = Number(existing && existing.totalGrantedCredits);
  if (storedPaid > 0 && storedTotal >= storedPaid) {
    const paidCredits = Math.floor(storedPaid);
    const bonusBudget = Math.max(0, Math.floor(storedTotal) - paidCredits);
    const eventBonusCredits = Math.min(
      bonusBudget,
      Math.max(0, Math.floor(Number(existing.eventBonusCredits) || 0))
    );
    return {
      paidCredits,
      eventBonusCredits,
      totalCredits: paidCredits + eventBonusCredits,
      eventBonusRate: Math.max(0, Math.floor(Number(existing.eventBonusRate) || 0)),
      eventId: existing.eventId || null,
      eventEndsAtMs: Math.max(0, Math.floor(Number(existing.eventEndsAtMs) || 0)),
      grantPolicyVersion: existing.grantPolicyVersion || 'credit-grant-base-v1',
      firstPurchaseBonusCredits: 0
    };
  }
  // 배포 전에 만들어졌지만 아직 주문으로 확정되지 않은 intent는 당시 baseCredits가
  // 실제 총 지급량이었다. 재시도 시 새 이벤트 지급량으로 바꾸지 않고 원래 약속을 지킨다.
  const legacyPromisedCredits = Math.max(0, Math.floor(Number(existing && existing.baseCredits) || 0));
  if (legacyPromisedCredits > 0) {
    return {
      paidCredits: legacyPromisedCredits,
      eventBonusCredits: 0,
      totalCredits: legacyPromisedCredits,
      eventBonusRate: 0,
      eventId: null,
      eventEndsAtMs: 0,
      grantPolicyVersion: 'legacy-total-grant-v1',
      firstPurchaseBonusCredits: 0
    };
  }
  return {
    paidCredits: creditGrant.paidCredits,
    eventBonusCredits: creditGrant.eventBonusCredits,
    totalCredits: creditGrant.totalCredits,
    eventBonusRate: creditGrant.eventBonusRate,
    eventId: creditGrant.eventId,
    eventEndsAtMs: creditGrant.eventEndsAtMs,
    grantPolicyVersion: creditGrant.grantPolicyVersion,
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

async function preparePaymentIntent({ orderId, paymentKey, uid, amount, creditGrant }) {
  const intentRef = db.collection('paymentIntents').doc(orderId);
  const keyHash = paymentKeyHash(paymentKey);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(intentRef);
    const existing = snap.exists ? snap.data() : null;
    assertPaymentIntentAllowsCreditGrant(existing);
    if (existing && (
      existing.uid !== uid ||
      Number(existing.amount) !== amount ||
      existing.paymentKeyHash !== keyHash
    )) {
      throw Object.assign(new Error('PAYMENT_INTENT_CONFLICT'), { status: 409 });
    }
    const grant = paymentIntentGrant(existing, creditGrant);
    transaction.set(intentRef, {
      uid,
      amount,
      paidCredits: grant.paidCredits,
      baseCredits: grant.paidCredits,
      eventBonusCredits: grant.eventBonusCredits,
      totalGrantedCredits: grant.totalCredits,
      eventBonusRate: grant.eventBonusRate,
      eventId: grant.eventId,
      eventEndsAtMs: grant.eventEndsAtMs,
      grantPolicyVersion: grant.grantPolicyVersion,
      firstPurchaseBonusCredits: grant.firstPurchaseBonusCredits,
      paymentKeyHash: keyHash,
      status: existing && existing.status === 'applied' ? 'applied' : 'confirming',
      attempts: Number(existing?.attempts || 0) + 1,
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return grant;
  });
}

async function requestTossConfirm({ basicToken, paymentKey, orderId, amount }) {
  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
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
    const response = await fetch(`https://api.tosspayments.com/v1/payments/orders/${encodeURIComponent(orderId)}`, {
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
    eventBonusCredits: granted.eventBonusCredits || 0,
    creditEventId: granted.eventId || null,
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
  const baseCredits = creditGrant.paidCredits;
  const eventBonusCredits = Math.max(0, Math.floor(Number(creditGrant.eventBonusCredits) || 0));
  const firstPurchaseBonusCredits = Math.max(0, Math.floor(Number(creditGrant.firstPurchaseBonusCredits) || 0));
  const totalCredits = creditGrant.totalCredits;
  const bonusCredits = Math.max(0, totalCredits - baseCredits);
  const usesBaseCreditPolicy = creditGrant.grantPolicyVersion === CREDIT_GRANT_POLICY_VERSION;
  const creditLotRef = userRef.collection('creditLots').doc(orderId);

  return db.runTransaction(async transaction => {
    // Firestore transactions require every read before the first write.
    const orderSnap = await transaction.get(orderRef);
    const userSnap = await transaction.get(userRef);
    const intentSnap = await transaction.get(intentRef);
    const userData = userSnap.exists ? userSnap.data() : {};
    const currentCredits = Number(userData.credits) || 0;

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
      return {
        deduped: true,
        baseCredits: Number(order.paidCredits ?? order.baseCredits) || Math.min(baseCredits, totalCredits),
        bonusCredits: Math.max(0, totalCredits - (Number(order.paidCredits ?? order.baseCredits) || totalCredits)),
        eventBonusCredits: Number(order.eventBonusCredits) || 0,
        eventId: order.creditEventId || null,
        totalCredits,
        newBalance: currentCredits,
        experimentKey: order.offerExperimentKey || null,
        experimentVariant: order.offerExperimentVariant || null
      };
    }

    if (!intentSnap.exists) {
      throw Object.assign(new Error('PAYMENT_INTENT_MISSING'), { status: 503 });
    }
    const intent = intentSnap.data() || {};
    if (
      intent.uid !== verifiedUid ||
      Number(intent.amount) !== safeAmount ||
      intent.paymentKeyHash !== paymentKeyHash(paymentKey)
    ) {
      throw Object.assign(new Error('PAYMENT_INTENT_CONFLICT'), { status: 409 });
    }

    const newCredits = currentCredits + totalCredits;
    const paidAt = providerPayment?.approvedAt || null;

    const lotFields = usesBaseCreditPolicy ? {
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      creditLotActive: totalCredits > 0,
      refundPaidCreditsRemaining: baseCredits,
      refundEventBonusCreditsRemaining: eventBonusCredits
    } : {};
    transaction.set(orderRef, {
      uid: verifiedUid,
      amount: safeAmount,
      safeCredits: totalCredits,
      totalGrantedCredits: totalCredits,
      paidCredits: baseCredits,
      baseCredits,
      eventBonusCredits,
      promotionalBonusCredits: eventBonusCredits,
      firstPurchaseBonusCredits,
      creditEventId: creditGrant.eventId,
      creditEventBonusRate: creditGrant.eventBonusRate,
      creditEventEndsAtMs: creditGrant.eventEndsAtMs,
      creditGrantPolicyVersion: creditGrant.grantPolicyVersion,
      refundCreditBasis: usesBaseCreditPolicy ? 'paid_credits_first' : 'legacy_total_grant',
      ...lotFields,
      paymentKeyPresent: true,
      customerEmail: typeof customerEmail === 'string' ? customerEmail.slice(0, 160) : '',
      status: 'paid',
      providerStatus: providerPayment?.status || 'DONE',
      providerApprovedAt: paidAt,
      reconciliationSource,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    transaction.set(db.collection('paymentSecrets').doc(orderId), {
      paymentKey,
      uid: verifiedUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

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
        eventBonusCreditsCap: eventBonusCredits,
        refundPaidCreditsRemaining: baseCredits,
        refundEventBonusCreditsRemaining: eventBonusCredits,
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
      eventBonusCredits,
      creditEventId: creditGrant.eventId,
      creditGrantPolicyVersion: creditGrant.grantPolicyVersion,
      ...(usesBaseCreditPolicy ? { creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    transaction.set(intentRef, {
      status: 'applied',
      creditedCredits: totalCredits,
      reconciliationSource,
      appliedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      deduped: false,
      baseCredits,
      bonusCredits,
      eventBonusCredits,
      eventId: creditGrant.eventId,
      totalCredits,
      newBalance: newCredits,
      experimentKey: null,
      experimentVariant: firstPurchaseBonusCredits > 0 ? 'legacy_honored' : 'retired'
    };
  });
}

async function handleCreditPaymentConfirmation(req, res) {
  const body = req.body || {};
  const { paymentKey, orderId, amount, customerEmail, uid, idToken, meta } = body;
  const safeAmount = Number(amount);
  const product = Number.isInteger(safeAmount) ? getCreditProduct(safeAmount) : null;
  const baseCredits = product && product.paidCredits;
  if (!product || !baseCredits) return res.status(400).json({ error: '유효하지 않은 결제 금액입니다.' });

  const inputValidation = validateConfirmInput({ paymentKey, orderId });
  if (!inputValidation.ok) return res.status(400).json({ error: inputValidation.error });
  if (!idToken) return res.status(401).json({ error: '로그인이 필요합니다.' });

  let verifiedUid;
  let decodedToken;
  try {
    decodedToken = await verifyFirebaseIdToken(idToken);
    verifiedUid = decodedToken.uid;
    setLogContext({ uid: verifiedUid });
  } catch {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인 후 결제를 완료해주세요.' });
  }
  if (uid && uid !== verifiedUid) {
    logger.warn('payment.uid_mismatch_blocked', { clientUid: uid, verifiedUid, orderId, amount: safeAmount });
    return res.status(403).json({ error: '사용자 정보가 일치하지 않습니다.' });
  }

  // An already-applied order is a successful idempotent retry. Never call Toss again.
  try {
    const existingOrderSnap = await db.collection('orders').doc(orderId).get();
    if (existingOrderSnap.exists) {
      const existingOrder = existingOrderSnap.data() || {};
      if (existingOrder.uid !== verifiedUid || Number(existingOrder.amount) !== safeAmount) {
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
        eventBonusCredits: Number(existingOrder.eventBonusCredits) || 0,
        eventId: existingOrder.creditEventId || null,
        totalCredits,
        newBalance: Number(userSnap.data()?.credits) || 0,
        experimentKey: existingOrder.offerExperimentKey || null,
        experimentVariant: existingOrder.offerExperimentVariant || null
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
    logger[cancellationLocked ? 'warn' : 'error'](
      cancellationLocked ? 'payment.credit_grant_blocked_by_cancellation' : 'payment.intent_prepare_failed',
      { uid: verifiedUid, orderId, amount: safeAmount, stage: 'prepare', err }
    );
    return res.status(status).json({
      error: cancellationLocked
        ? '결제 취소가 먼저 확인된 주문이라 크레딧 지급을 중단했습니다. 결제 내역을 확인해 주세요.'
        : (status === 409
          ? '주문 정보가 기존 결제 시도와 일치하지 않습니다.'
          : '결제 처리를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.'),
      ...(cancellationLocked ? { code: 'PAYMENT_CANCELLATION_LOCKED' } : {})
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
      lookupStatus: lookup?.response?.status || null
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
      validationReasons: approval.reasons
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
    providerApprovedAt: providerPayment.approvedAt || null
  });

  let granted;
  try {
    granted = await applyCreditPayment({
      verifiedUid,
      orderId,
      paymentKey,
      safeAmount,
      creditGrant,
      customerEmail,
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
    await bestEffortMarkPaymentIntent(orderId, 'approved_reconciliation_required', {
      applyErrorCode: err.message || 'unknown'
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
      name: customerEmail
    });
    void metaConversions.sendPurchase({
      eventId: `purchase_${orderId}`,
      orderId,
      value: safeAmount,
      itemId: `credits_${granted.totalCredits}`,
      email: decodedToken?.email,
      externalId: verifiedUid,
      clientIp: realClientIp(req),
      userAgent: req.get('user-agent'),
      context: meta
    });
  }

  return res.json(creditPaymentResponse(granted));
}

router.post('/checkout-context', async (req, res) => {
  const idToken = req.body && req.body.idToken;
  if (!idToken) return res.status(401).json({ error: '로그인이 필요합니다.' });

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(idToken);
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
    return res.json({
      ok: true,
      ...buildCheckoutContext({
        uid,
        credits: user.credits,
        orders,
        conversion: user.conversion || {}
      })
    });
  } catch (err) {
    logger.error('payment.checkout_context_failed', { uid, err });
    return res.status(500).json({ error: '결제 혜택을 불러오지 못했어요.' });
  }
});

router.post('/confirm-payment', handleCreditPaymentConfirmation);

// --- 환불 시스템 ---
// ADMIN_UIDS / verifyToken은 config.js에서 import (coupon.js와 단일 진실 원천 공유)

// 컬렉션 분기 헬퍼
function getOrderRef(kind, orderId) {
  return kind === 'subscription'
    ? db.collection('subscriptionOrders').doc(orderId)
    : db.collection('orders').doc(orderId);
}

async function requireAdmin(req, res) {
  const { idToken } = req.body || {};
  const adminUid = await verifyToken(idToken);
  if (!adminUid) {
    res.status(401).json({ error: '로그인이 필요합니다.' });
    return null;
  }
  setLogContext({ uid: adminUid, actorUid: adminUid });
  if (!ADMIN_UIDS.includes(adminUid)) {
    res.status(403).json({ error: '관리자 권한이 없습니다.' });
    return null;
  }
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
    eventBonusCredits: Number(o.eventBonusCredits) || 0,
    firstPurchaseBonusCredits: Number(o.firstPurchaseBonusCredits) || 0,
    creditGrantPolicyVersion: o.creditGrantPolicyVersion || '',
    creditLotPolicyVersion: o.creditLotPolicyVersion || '',
    refundPaidCreditsRemaining: Number.isFinite(Number(o.refundPaidCreditsRemaining))
      ? Math.max(0, Math.floor(Number(o.refundPaidCreditsRemaining)))
      : null,
    refundEventBonusCreditsRemaining: Number.isFinite(Number(o.refundEventBonusCreditsRemaining))
      ? Math.max(0, Math.floor(Number(o.refundEventBonusCreditsRemaining)))
      : null,
    refundCreditBasis: o.refundCreditBasis || '',
    refundCreditSettlementClosed: o.refundCreditSettlementClosed === true,
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

function creditRefundProcessing(operation, now) {
  return {
    kind: 'credit',
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
    creditLotPolicyVersion: operation.creditLotPolicyVersion || null,
    reservedPaidCredits: Math.max(0, Math.floor(Number(operation.reservedPaidCredits) || 0)),
    reservedBonusCredits: Math.max(0, Math.floor(Number(operation.reservedBonusCredits) || 0)),
    startedAt: now
  };
}

function creditLotMismatchError() {
  logger.error('credit_lot.inconsistent', { action: 'block_refund_and_reconcile' });
  return Object.assign(new Error('CREDIT_LOT_INCONSISTENT'), { status: 503, code: 'CREDIT_LOT_INCONSISTENT' });
}

async function reserveCreditRefundCredits({
  transaction,
  orderRef,
  userRef,
  latestOrder,
  remainingOrderCredits
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
        creditLotUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
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
      creditLotUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    } : {},
    processingLotFields: grant.usesTrackedLot ? {
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      reservedPaidCredits: grant.remainingPaidCredits,
      reservedBonusCredits: grant.remainingBonusCredits
    } : {}
  };
}

async function compensateCreditRefundReservation({ orderRef, userRef, operationId }) {
  return db.runTransaction(async transaction => {
    const latestOrderSnapshot = await transaction.get(orderRef);
    if (!latestOrderSnapshot.exists) return false;
    const latestOrder = latestOrderSnapshot.data() || {};
    const processing = resumableCreditRefund(latestOrder);
    if (!processing || processing.operationId !== operationId) return false;
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const user = userSnap.data() || {};
    const wallet = creditWalletBalances(user);
    const usesTrackedLot = processing.creditLotPolicyVersion === CREDIT_LOT_POLICY_VERSION;
    const lotRef = usesTrackedLot ? userRef.collection('creditLots').doc(orderRef.id) : null;
    const lotSnap = lotRef ? await transaction.get(lotRef) : null;
    if (usesTrackedLot && (!lotSnap || !lotSnap.exists)) throw creditLotMismatchError();

    const restoredCredits = processing.creditsToDeduct;
    const userUpdate = { credits: wallet.credits + restoredCredits };
    const now = admin.firestore.FieldValue.serverTimestamp();
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
        : admin.firestore.FieldValue.delete(),
      refundedAmount: processing.priorRefundedAmount > 0
        ? processing.priorRefundedAmount
        : admin.firestore.FieldValue.delete(),
      refundedCredits: processing.priorRefundedCredits > 0
        ? processing.priorRefundedCredits
        : admin.firestore.FieldValue.delete(),
      refundUsedPaidCredits: admin.firestore.FieldValue.delete(),
      refundablePaidCredits: admin.firestore.FieldValue.delete(),
      recoveredBonusCredits: admin.firestore.FieldValue.delete(),
      refundPolicyVersion: processing.previousRefundPolicyVersion || admin.firestore.FieldValue.delete(),
      refundCreditBasis: processing.previousRefundCreditBasis || admin.firestore.FieldValue.delete(),
      refundCreditSettlementClosed: processing.previousRefundCreditSettlementClosed || admin.firestore.FieldValue.delete(),
      ...(usesTrackedLot ? {
        refundPaidCreditsRemaining: processing.reservedPaidCredits,
        refundEventBonusCreditsRemaining: processing.reservedBonusCredits,
        creditLotActive: restoredCredits > 0,
        creditLotUpdatedAt: now
      } : {}),
      refundProcessing: admin.firestore.FieldValue.delete()
    });
    return true;
  });
}

async function processRefund({ orderRef, orderSnap, kind, adminUid, reason, mode, customAmount }) {
  const order = orderSnap.data();
  const paymentKey = await readPaymentKey(orderRef.id, order);   // ★ C-04
  if (!['paid', 'refund_requested', 'refund_rejected', 'partially_refunded'].includes(order.status)) {
    throw Object.assign(new Error('환불할 수 없는 주문 상태입니다. 현재: ' + order.status), { status: 400 });
  }
  if (!paymentKey) {
    throw Object.assign(new Error('paymentKey가 없어 환불할 수 없습니다. (이전 결제건)'), { status: 400 });
  }

  const userRef = db.collection('users').doc(order.uid);
  const basicToken = tossBasicToken();
  if (!basicToken) {
    throw Object.assign(new Error('결제 서버 설정이 완료되지 않았습니다.'), { status: 503, code: 'TOSS_SECRET_MISSING' });
  }
  const tossUrl = `https://api.tosspayments.com/v1/payments/${paymentKey}/cancel`;
  const cancelReason = String(reason || order.cancelReason || '관리자 직접 환불').trim();

  if (kind === 'subscription') {
    const subscriptionRefundAmount = Number(order.amount) || 0;
    const operationId = refundOperationId(orderRef.id, 0, subscriptionRefundAmount, 0);
    const tossRes = await fetch(tossUrl, {
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
      t.update(orderRef, {
        status: 'refunded',
        cancelReason,
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundedBy: adminUid
      });
      t.update(userRef, {
        'subscription.status': 'refunded',
        'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
        'plan': 'free',
        'coupon.remaining': 0,
        'coupon.used': 0
      });
      t.set(userRef.collection('couponHistory').doc(cancellationLedgerId(orderRef.id, subscriptionRefundAmount)), {
        type: 'refund',
        tier: order.tier,
        amount: 0,
        remaining: 0,
        orderId: orderRef.id,
        detail: '관리자 직접 환불',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
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
  let priorRefundedAmount, priorRefundedCredits, cumulativeRefundAmount, operationId;
  let previousRefundPolicyVersion, previousRefundCreditBasis, previousRefundCreditSettlementClosed;
  try {
    const result = await db.runTransaction(async (transaction) => {
      const latestOrderSnapshot = await transaction.get(orderRef);
      if (!latestOrderSnapshot.exists) throw new Error('ORDER_NOT_FOUND');
      const latestOrder = latestOrderSnapshot.data() || {};
      const latestGrant = creditRefundGrant(latestOrder);
      const resumable = resumableCreditRefund(latestOrder);
      if (resumable) {
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
      const nextOperationId = refundOperationId(orderRef.id, priorAmount, amount, creditsToDeduct);
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
        ...reserved.processingLotFields
      };
      transaction.update(orderRef, {
        cancelReason,
        refundMode,
        refundAmount: newRefundedAmount,    // 누적(레거시 표시 호환)
        refundedAmount: newRefundedAmount,  // 누적 환불 금액
        refundedCredits: newRefundedCredits, // 누적 환불 크레딧
        refundPolicyVersion: latestGrant.usesBaseCreditPolicy ? REFUND_POLICY_VERSION : (latestOrder.refundPolicyVersion || admin.firestore.FieldValue.delete()),
        refundCreditBasis: latestGrant.refundCreditBasis,
        refundUsedPaidCredits: policyCalculation ? policyCalculation.usedPaidCredits : admin.firestore.FieldValue.delete(),
        refundablePaidCredits: policyCalculation ? policyCalculation.refundablePaidCredits : admin.firestore.FieldValue.delete(),
        recoveredBonusCredits: policyCalculation ? policyCalculation.recoveredBonusCredits : admin.firestore.FieldValue.delete(),
        refundCreditSettlementClosed: policyCalculation ? true : admin.firestore.FieldValue.delete(),
        ...reserved.orderLotUpdate,
        refundProcessing: creditRefundProcessing(operation, admin.firestore.FieldValue.serverTimestamp())
      });
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
      await compensateCreditRefundReservation({ orderRef, userRef, operationId });
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
    const remainingCredits = userSnap.exists ? (Number(userSnap.data().credits) || 0) : 0;
    if (!decision.ok) {
      throw Object.assign(new Error('REFUND_FINALIZE_CONFLICT'), { status: 409 });
    }
    if (decision.alreadyFinalized) {
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
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundedBy: adminUid,
      refundProcessing: admin.firestore.FieldValue.delete()
    });
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

const REFUND_POLICY_VERSION = '2026-08-29-base-credit-v1';
const SUBSCRIPTION_REFUND_POLICY_VERSION = '2026-08-29-subscription-usage-v1';
const REFUND_WINDOW_DAYS = 7;
const REFUND_WINDOW_MS = REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const UNLIMITED_REFUND_SETTLEMENT_USES = 50;

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
    const response = await fetch(tossUrl, {
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

function refundPaidAtMs(order, kind) {
  if (!order) return 0;
  return kind === 'subscription'
    ? timestampMs(order.approvedAt || order.cycleStartedAt || order.requestedAt)
    : timestampMs(order.createdAt || order.approvedAt || order.requestedAt);
}

function refundWindowState(order, kind, nowMs = Date.now()) {
  const paidAtMs = refundPaidAtMs(order, kind);
  if (!paidAtMs) return { eligible: false, paidAtMs: 0, reason: 'PAYMENT_DATE_MISSING' };
  const elapsedMs = Math.max(0, Number(nowMs) - paidAtMs);
  return {
    eligible: elapsedMs <= REFUND_WINDOW_MS,
    paidAtMs,
    elapsedMs,
    reason: elapsedMs <= REFUND_WINDOW_MS ? null : 'REFUND_WINDOW_EXPIRED'
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

function currentSubscriptionRefundContext(user, order, paidAtMs) {
  const subscription = user && user.subscription;
  const coupon = user && user.coupon;
  const cycleStartedAtMs = timestampMs(subscription && subscription.cycleStartedAt);
  const sameCycle = !!(
    subscription && coupon &&
    subscription.tier === order.tier &&
    coupon.tier === order.tier &&
    cycleStartedAtMs &&
    Math.abs(cycleStartedAtMs - paidAtMs) < 60 * 1000
  );
  return { sameCycle, subscription, coupon, cycleStartedAtMs };
}

// 환불 요청 (사용자용) — kind: 'order' (기본, 크레딧 일회성) | 'subscription' (정기결제)
router.post('/request-refund', async (req, res) => {
  const { orderId, idToken, cancelReason, kind: rawKind } = req.body;
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });
  if (!cancelReason || cancelReason.trim().length < 2) {
    return res.status(400).json({ error: '환불 사유를 입력해주세요.' });
  }

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

    const windowState = refundWindowState(order, kind);
    if (!windowState.eligible) {
      const message = windowState.reason === 'PAYMENT_DATE_MISSING'
        ? '결제일을 확인할 수 없어 온라인 환불을 요청할 수 없습니다. 고객센터로 문의해주세요.'
        : `결제일로부터 ${REFUND_WINDOW_DAYS}일이 지나 일반 환불을 요청할 수 없습니다. 중복 결제나 서비스 오류는 고객센터로 문의해주세요.`;
      return res.status(400).json({ error: message, code: windowState.reason });
    }

    const userSnap = await db.collection('users').doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : {};
    let policySnapshot;
    let requestRefundPolicyVersion;

    // 정기결제 환불 자격: 결제일 7일 이내 + 이번 결제주기의 사용분 비례 공제
    if (kind === 'subscription') {
      const context = currentSubscriptionRefundContext(user, order, windowState.paidAtMs);
      if (!context.sameCycle) {
        // 과거 사이클 결제는 환불 불가 (해당 사이클 사용 여부를 더 이상 추적할 수 없음)
        return res.status(400).json({
          error: '현재 결제주기의 구독만 온라인 환불을 요청할 수 있습니다. 고객센터로 문의해주세요.',
          code: 'SUBSCRIPTION_CYCLE_MISMATCH'
        });
      }
      const calculation = calculateSubscriptionPolicyRefund({
        orderAmount: order.amount,
        tier: order.tier,
        coupon: context.coupon
      });
      if (calculation.refundAmount <= 0) {
        return res.status(400).json({
          error: `이번 결제주기의 정산 기준 ${calculation.settlementUses}회를 모두 사용해 일반 환불 가능 금액이 없습니다. 서비스 오류는 고객센터로 문의해주세요.`,
          code: 'NO_REFUNDABLE_SUBSCRIPTION_AMOUNT'
        });
      }
      policySnapshot = {
        requestedRefundAmount: calculation.refundAmount,
        refundUsedCount: calculation.usedCount,
        refundSettlementUses: calculation.settlementUses
      };
      requestRefundPolicyVersion = SUBSCRIPTION_REFUND_POLICY_VERSION;
    } else {
      const { grant, calculation } = calculateOrderCreditRefund({ order, user });
      if (calculation.refundAmount <= 0 || calculation.refundableCredits <= 0) {
        return res.status(400).json({
          error: '구매한 크레딧을 모두 사용해 일반 환불 가능 금액이 없습니다. 서비스 오류는 고객센터로 문의해주세요.',
          code: 'NO_REFUNDABLE_CREDITS'
        });
      }
      policySnapshot = {
        requestedRefundAmount: calculation.refundAmount,
        requestedRefundCredits: calculation.refundableCredits,
        refundUsedCredits: calculation.usedCredits,
        refundUsedPaidCredits: calculation.usedPaidCredits,
        refundablePaidCredits: calculation.refundablePaidCredits,
        refundPaidCredits: calculation.paidCredits,
        refundBonusCredits: calculation.bonusCredits,
        refundCreditBasis: grant.refundCreditBasis
      };
      requestRefundPolicyVersion = grant.usesBaseCreditPolicy
        ? REFUND_POLICY_VERSION
        : (order.refundPolicyVersion || null);
    }

    await db.runTransaction(async (transaction) => {
      const latestSnap = await transaction.get(orderRef);
      if (!latestSnap.exists) {
        throw Object.assign(new Error('주문을 찾을 수 없습니다.'), { status: 404, code: 'ORDER_NOT_FOUND' });
      }
      const latestOrder = latestSnap.data() || {};
      if (latestOrder.uid !== uid) {
        throw Object.assign(new Error('본인의 주문만 환불 요청할 수 있습니다.'), { status: 403, code: 'ORDER_OWNER_MISMATCH' });
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
      transaction.update(orderRef, {
        status: 'refund_requested',
        cancelReason: cancelReason.trim(),
        kind,
        refundPolicyVersion: requestRefundPolicyVersion || admin.firestore.FieldValue.delete(),
        ...policySnapshot,
        refundRequestedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    logger.info('refund.requested', {
      uid,
      orderId,
      kind,
      reasonLength: cancelReason.trim().length
    });
    discord.refundRequest({ uid, amount: order.amount, credits: order.safeCredits, reason: cancelReason.trim(), name: order.customerEmail });
    res.json({
      ok: true,
      message: '환불 요청이 접수되었습니다.',
      estimatedRefundAmount: policySnapshot.requestedRefundAmount,
      refundPolicyVersion: requestRefundPolicyVersion
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
  const { orderId, idToken, kind: rawKind } = req.body;
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid: adminUid, actorUid: adminUid });
  if (!ADMIN_UIDS.includes(adminUid)) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });

  try {
    const orderRef = getOrderRef(kind, orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

    const order = orderSnap.data();
    const paymentKey = await readPaymentKey(orderRef.id, order);   // ★ C-04
    if (order.status !== 'refund_requested') {
      return res.status(400).json({ error: '환불 요청 상태가 아닙니다. 현재: ' + order.status });
    }
    if (!paymentKey) {
      return res.status(400).json({ error: 'paymentKey가 없어 환불할 수 없습니다. (이전 결제건)' });
    }

    const userRef = db.collection('users').doc(order.uid);
    const basicToken = tossBasicToken(res);
    if (!basicToken) return;
    const tossUrl = `https://api.tosspayments.com/v1/payments/${paymentKey}/cancel`;

    if (kind === 'subscription') {
      // 정기결제: 승인 시점의 실제 사용량으로 한 번 더 계산해 전액 또는 부분 취소한다.
      const userSnap = await userRef.get();
      const user = userSnap.exists ? userSnap.data() : {};
      const paidAtMs = refundPaidAtMs(order, kind);
      const context = currentSubscriptionRefundContext(user, order, paidAtMs);
      if (!context.sameCycle) {
        return res.status(400).json({ error: '현재 결제주기와 일치하지 않아 자동 환불할 수 없습니다. 직접 환불 기능을 사용해주세요.' });
      }
      const calculation = calculateSubscriptionPolicyRefund({
        orderAmount: order.amount,
        tier: order.tier,
        coupon: context.coupon
      });
      if (calculation.refundAmount <= 0) {
        return res.status(400).json({ error: '승인 전 추가 사용으로 환불 가능 금액이 남지 않았습니다.' });
      }
      const orderAmount = Math.max(0, Math.floor(Number(order.amount) || 0));
      const isFullRefund = calculation.refundAmount >= orderAmount;
      const operationId = refundOperationId(orderId, 0, calculation.refundAmount, 0);
      const cancelBody = { cancelReason: order.cancelReason || '고객 요청 환불' };
      if (!isFullRefund) cancelBody.cancelAmount = calculation.refundAmount;
      const tossRes = await fetch(tossUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': refundIdempotencyKey(operationId)
        },
        body: JSON.stringify(cancelBody)
      });
      const tossResult = await tossRes.json();
      if (!tossRes.ok) {
        logger.error('refund.toss_cancel_failed', { orderId, kind, uid: order.uid, status: tossRes.status, toss: tossResult });
        return res.status(tossRes.status).json({
          error: '토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')
        });
      }

      await db.runTransaction(async (t) => {
        t.update(orderRef, {
          status: isFullRefund ? 'refunded' : 'partially_refunded',
          refundAmount: calculation.refundAmount,
          refundedAmount: calculation.refundAmount,
          refundUsedCount: calculation.usedCount,
          refundSettlementUses: calculation.settlementUses,
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
          refundedBy: adminUid
        });
        t.update(userRef, {
          'subscription.status': 'refunded',
          'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
          'plan': 'free',
          'coupon.remaining': 0,
          'coupon.used': calculation.usedCount
        });
        const histRef = userRef.collection('couponHistory').doc();
        t.set(histRef, {
          type: 'refund', tier: order.tier, amount: 0, remaining: 0,
          orderId,
          used: calculation.usedCount,
          refundAmount: calculation.refundAmount,
          settlementUses: calculation.settlementUses,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      logger.info('refund.subscription_approved', {
        orderId,
        uid: order.uid,
        adminUid,
        tier: order.tier,
        refundAmount: calculation.refundAmount,
        usedCount: calculation.usedCount,
        settlementUses: calculation.settlementUses
      });
      return res.json({
        ok: true,
        message: '환불이 완료되었습니다.',
        refundAmount: calculation.refundAmount,
        partiallyRefunded: !isFullRefund
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
    let cumulativeRefundAmount, operationId;
    let previousRefundPolicyVersion, previousRefundCreditBasis, previousRefundCreditSettlementClosed;
    try {
      const result = await db.runTransaction(async (transaction) => {
        const latestOrderSnapshot = await transaction.get(orderRef);
        if (!latestOrderSnapshot.exists) throw new Error('ORDER_NOT_FOUND');
        const latestOrder = latestOrderSnapshot.data() || {};
        const resumable = resumableCreditRefund(latestOrder);
        if (resumable) {
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
          ...reserved.processingLotFields
        };
        transaction.update(orderRef, {
          refundAmount: targetRefundedAmount,
          refundedAmount: targetRefundedAmount,
          refundedCredits: targetRefundedCredits,
          refundPolicyVersion: refundGrant.usesBaseCreditPolicy
            ? REFUND_POLICY_VERSION
            : (latestOrder.refundPolicyVersion || admin.firestore.FieldValue.delete()),
          refundCreditBasis: refundGrant.refundCreditBasis,
          refundUsedPaidCredits: policyCalculation ? policyCalculation.usedPaidCredits : admin.firestore.FieldValue.delete(),
          refundablePaidCredits: policyCalculation ? policyCalculation.refundablePaidCredits : admin.firestore.FieldValue.delete(),
          recoveredBonusCredits: policyCalculation ? policyCalculation.recoveredBonusCredits : admin.firestore.FieldValue.delete(),
          refundCreditSettlementClosed: policyCalculation ? true : admin.firestore.FieldValue.delete(),
          ...reserved.orderLotUpdate,
          refundProcessing: creditRefundProcessing(operation, admin.firestore.FieldValue.serverTimestamp())
        });
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
        await compensateCreditRefundReservation({ orderRef, userRef, operationId });
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
      const remainingCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
      if (!decision.ok) {
        throw Object.assign(new Error('REFUND_FINALIZE_CONFLICT'), { status: 409 });
      }
      if (decision.alreadyFinalized) {
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
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundedBy: adminUid,
        refundProcessing: admin.firestore.FieldValue.delete()
      });
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
      ...(err.message === 'REFUND_FINALIZE_CONFLICT' ? { code: 'REFUND_FINALIZE_CONFLICT' } : {})
    });
  }
});

// 환불 거절 (관리자용)
router.post('/reject-refund', async (req, res) => {
  const { orderId, idToken, rejectReason, kind: rawKind } = req.body;
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid: adminUid, actorUid: adminUid });
  if (!ADMIN_UIDS.includes(adminUid)) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
  if (!orderId) return res.status(400).json({ error: '주문번호가 없습니다.' });
  if (!rejectReason || rejectReason.trim().length < 2) {
    return res.status(400).json({ error: '거절 사유를 입력해주세요.' });
  }

  try {
    const orderRef = getOrderRef(kind, orderId);
    await db.runTransaction(async (transaction) => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw Object.assign(new Error('주문을 찾을 수 없습니다.'), { status: 404, code: 'ORDER_NOT_FOUND' });
      }
      const order = orderSnap.data() || {};
      if (order.status !== 'refund_requested' || order.refundProcessing) {
        throw Object.assign(new Error(`환불 요청 상태가 아니거나 이미 처리가 시작됐습니다. 현재: ${order.status || 'unknown'}`), {
          status: 409,
          code: 'REFUND_STATE_CHANGED'
        });
      }
      transaction.update(orderRef, {
        status: 'refund_rejected',
        rejectReason: rejectReason.trim(),
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        rejectedBy: adminUid
      });
    });

    logger.info('refund.rejected', {
      orderId,
      kind,
      adminUid,
      rejectReasonLength: rejectReason.trim().length
    });
    res.json({ ok: true, message: '환불 요청이 거절되었습니다.' });
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
router.post('/apply-referral', async (req, res) => {
  try {
    const { idToken, refCode } = req.body;
    if (!idToken || !refCode) return res.status(400).json({ error: '필수 값 누락' });

    // 1. 신규 유저 인증 확인
    const decoded = await admin.auth().verifyIdToken(idToken);
    const newUid = decoded.uid;
    setLogContext({ uid: newUid });

    // 2. 자기 자신 추천 방지
    const newUserSnap = await db.collection('users').doc(newUid).get();
    if (!newUserSnap.exists) return res.status(400).json({ error: '유저 없음' });
    if (newUserSnap.data().refCode === refCode) return res.status(400).json({ error: '본인 추천 불가' });

    // 3. 이미 추천 받은 유저인지 확인
    if (newUserSnap.data().referredBy) return res.status(400).json({ error: '이미 추천 적용됨' });

    // 4. 추천인 찾기 (쿼리는 트랜잭션 밖. 단, 이중지급 방지의 권위는 트랜잭션 안 newUser.referredBy)
    const referrerSnap = await db.collection('users').where('refCode', '==', refCode).limit(1).get();
    if (referrerSnap.empty) return res.status(400).json({ error: '유효하지 않은 추천 코드' });
    const referrerDoc = referrerSnap.docs[0];
    const referrerUid = referrerDoc.id;
    if (referrerUid === newUid) return res.status(400).json({ error: '본인 추천 불가' });

    // 5. ★ C-08: 검증·지급·이력을 하나의 트랜잭션으로. referredBy를 트랜잭션 안에서 다시 읽어
    //    동시 요청 이중 지급을 차단하고, 결정적 history ID로 재시도 멱등을 보장한다.
    const now = admin.firestore.FieldValue.serverTimestamp();
    const result = await db.runTransaction(async (t) => {
      const newRef = db.collection('users').doc(newUid);
      const refRef = db.collection('users').doc(referrerUid);
      const newSnap = await t.get(newRef);
      const refSnap = await t.get(refRef);
      if (!newSnap.exists || !refSnap.exists) throw new Error('USER_NOT_FOUND');
      if (newSnap.data().referredBy) return { applied: false };   // 이미 적용 — 멱등 종료
      const newUserCredits = (newSnap.data().credits || 0) + 20;
      const referrerCredits = (refSnap.data().credits || 0) + 20;
      t.update(newRef, { credits: admin.firestore.FieldValue.increment(20), referredBy: refCode });
      t.update(refRef, { credits: admin.firestore.FieldValue.increment(20) });
      t.set(newRef.collection('creditHistory').doc('referral_' + newUid), {
        type: 'referral', used: 0, amount: 20, remaining: newUserCredits,
        detail: '친구 추천 보상 (가입)', createdAt: now
      });
      t.set(refRef.collection('creditHistory').doc('referral_from_' + newUid), {
        type: 'referral', used: 0, amount: 20, remaining: referrerCredits,
        detail: '친구 추천 보상 (초대)', createdAt: now
      });
      return { applied: true };
    });

    if (!result.applied) return res.status(400).json({ error: '이미 추천 적용됨' });
    logger.info('referral.applied', { referrerUid, newUid, credits: 20 });
    try { discord.referral({ inviter: referrerDoc.data().name || referrerUid, invitee: newUserSnap.data().name || newUid }); } catch {}
    res.json({ ok: true });
  } catch (err) {
    logger.error('referral.failed', { err });
    res.status(500).json({ error: '추천 처리 실패' });
  }
});

router.serializeAdminJobDoc = serializeAdminJobDoc;   // 축약 관측 계약 테스트용
router.buildHumanizeQualityReport = buildHumanizeQualityReport;
router.adminHistoryPolicy = {
  serializeOrderDoc,
  splitAdminCreditHistory,
  creditLedgerDelta
};
router.creditGrantPolicy = {
  assertPaymentIntentAllowsCreditGrant,
  paymentIntentGrant
};
router.refundPolicy = {
  REFUND_POLICY_VERSION,
  REFUND_WINDOW_DAYS,
  REFUND_WINDOW_MS,
  UNLIMITED_REFUND_SETTLEMENT_USES,
  refundPaidAtMs,
  refundWindowState,
  refundRequestProcessingConflict,
  tossCancellationState,
  creditRefundFinalizeDecision,
  creditRefundGrant,
  calculateCreditPolicyRefund,
  calculateOrderCreditRefund,
  calculateSubscriptionPolicyRefund,
  currentSubscriptionRefundContext
};

module.exports = router;
