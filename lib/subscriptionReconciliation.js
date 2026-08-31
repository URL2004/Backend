'use strict';

const SUBSCRIPTION_PURCHASE_KIND = 'subscription_cycle';
const RECOVERABLE_INTENT_STATUSES = Object.freeze([
  'confirming',
  'approved_reconciliation_required'
]);
const PROVIDER_TERMINAL_STATUSES = new Set(['CANCELED', 'ABORTED', 'EXPIRED']);
const DEFAULT_MAX_RECONCILIATION_ATTEMPTS = 6;
const DEFAULT_MAX_RECONCILIATION_AGE_MS = 24 * 60 * 60 * 1000;

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (Number.isFinite(Number(value._seconds))) return Number(value._seconds) * 1000;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedAttempts(value, fallback = DEFAULT_MAX_RECONCILIATION_ATTEMPTS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(2, Math.min(20, Math.floor(parsed))) : fallback;
}

function boundedAgeMs(value, fallback = DEFAULT_MAX_RECONCILIATION_AGE_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(60 * 60 * 1000, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(parsed)))
    : fallback;
}

function providerChargeStatusUncertain(result) {
  const status = Number(result?.status) || 0;
  // Timeout/rate-limit/conflict/server failures can happen after the provider
  // accepted a request.  They must be queried by deterministic orderId before
  // allowing a new charge.  Ordinary 4xx declines are definitive.
  return status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function subscriptionProviderValidation(payment, intent) {
  const value = payment && typeof payment === 'object' ? payment : {};
  const expected = intent && typeof intent === 'object' ? intent : {};
  const providerStatus = String(value.status || '');
  const providerOrderId = String(value.orderId || '');
  const providerAmount = Number(value.totalAmount ?? value.balanceAmount ?? value.amount);
  const reasons = [];
  if (providerStatus !== 'DONE') reasons.push('status_not_done');
  if (providerOrderId !== String(expected.orderId || '')) reasons.push('order_id_mismatch');
  if (!Number.isFinite(providerAmount) || providerAmount !== Number(expected.amount)) reasons.push('amount_mismatch');
  if (!String(value.paymentKey || '')) reasons.push('payment_key_missing');
  if (!Number.isFinite(Date.parse(String(value.approvedAt || '')))) reasons.push('approved_at_missing');
  return { ok: reasons.length === 0, reasons, providerStatus, providerAmount };
}

function subscriptionPlanSnapshot(plan, amount) {
  if (!plan || typeof plan !== 'object') return null;
  const usesPerCycle = Number(plan.usesPerCycle);
  const charLimit = Number(plan.charLimit);
  const snapAmount = Number(amount ?? plan.amount);
  if (!Number.isFinite(snapAmount)
    || !Number.isFinite(usesPerCycle)
    || !Number.isFinite(charLimit)) return null;
  return {
    amount: snapAmount,
    usesPerCycle,
    charLimit,
    name: String(plan.name || '').slice(0, 160)
  };
}

async function prepareSubscriptionIntent({
  admin,
  db,
  orderId,
  uid,
  tier,
  amount,
  plan = null,
  isFirst,
  cardCompany = null,
  cardNumber = null,
  billingSecret = null
}) {
  const intentRef = db.collection('paymentIntents').doc(orderId);
  const billingRef = db.collection('billingSecrets').doc(uid);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(intentRef);
    const existing = snap.exists ? (snap.data() || {}) : null;
    if (existing && (
      existing.purchaseKind !== SUBSCRIPTION_PURCHASE_KIND
      || existing.uid !== uid
      || existing.tier !== tier
      || Number(existing.amount) !== Number(amount)
    )) {
      const error = new Error('SUBSCRIPTION_INTENT_CONFLICT');
      error.code = 'SUBSCRIPTION_INTENT_CONFLICT';
      error.status = 409;
      throw error;
    }
    if (existing && existing.status === 'applied') return { deduped: true, status: 'applied' };
    transaction.set(intentRef, {
      purchaseKind: SUBSCRIPTION_PURCHASE_KIND,
      orderId,
      uid,
      tier,
      amount: Number(amount),
      planSnapshot: existing?.planSnapshot || subscriptionPlanSnapshot(plan, amount),
      isFirst: isFirst === true,
      cardCompany: cardCompany || null,
      cardNumber: cardNumber || null,
      status: existing?.status === 'approved_reconciliation_required'
        ? 'approved_reconciliation_required'
        : 'confirming',
      chargeAttempts: Math.max(0, Number(existing?.chargeAttempts) || 0) + 1,
      reconciliationAttempts: Math.max(0, Number(existing?.reconciliationAttempts) || 0),
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (billingSecret && billingSecret.billingKey) {
      transaction.set(billingRef, {
        billingKey: billingSecret.billingKey,
        cardCompany: cardCompany || null,
        cardNumber: cardNumber || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return { deduped: false, status: existing?.status || 'confirming' };
  });
}

async function markSubscriptionProviderApproved({ admin, db, orderId, payment }) {
  const intentRef = db.collection('paymentIntents').doc(orderId);
  const secretRef = db.collection('paymentSecrets').doc(orderId);
  return db.runTransaction(async transaction => {
    const intentSnap = await transaction.get(intentRef);
    if (!intentSnap.exists) throw Object.assign(new Error('SUBSCRIPTION_INTENT_MISSING'), { code: 'SUBSCRIPTION_INTENT_MISSING' });
    const intent = intentSnap.data() || {};
    if (intent.status === 'applied') {
      return { approved: true, intent, alreadyApplied: true, validation: null };
    }
    const secretSnap = await transaction.get(secretRef);
    const validation = subscriptionProviderValidation(payment, intent);
    if (secretSnap.exists) {
      const existingPaymentKey = String(secretSnap.data()?.paymentKey || '');
      if (existingPaymentKey && existingPaymentKey !== String(payment?.paymentKey || '')) {
        validation.reasons.push('payment_key_mismatch');
        validation.ok = false;
      }
    }
    if (!validation.ok) {
      const identityMismatch = validation.reasons.some(reason => reason !== 'status_not_done');
      transaction.set(intentRef, {
        // A non-DONE provider response is not a decline and must remain in the
        // recoverable queue.  Only immutable identity mismatches fail closed.
        status: identityMismatch ? 'manual_review' : 'confirming',
        validationReasons: validation.reasons,
        providerStatus: validation.providerStatus || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { approved: false, identityMismatch, validation };
    }
    transaction.set(secretRef, {
      paymentKey: payment.paymentKey,
      uid: intent.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(intentRef, {
      status: 'approved_reconciliation_required',
      providerStatus: validation.providerStatus,
      providerApprovedAt: payment.approvedAt || null,
      validationReasons: [],
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { approved: true, intent, validation };
  });
}

async function markSubscriptionIntentApplied({ admin, db, orderId, source = 'request' }) {
  await db.collection('paymentIntents').doc(orderId).set({
    status: 'applied',
    reconciliationSource: source,
    appliedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function markSubscriptionIntentProviderRejected({ admin, db, orderId, providerStatus, providerCode }) {
  await db.collection('paymentIntents').doc(orderId).set({
    status: 'provider_rejected',
    providerStatus: providerStatus || null,
    providerCode: String(providerCode || '').slice(0, 80) || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function findPendingSubscriptionIntentForUid({ db, uid }) {
  const snapshot = await db.collection('paymentIntents').where('uid', '==', uid).get();
  return (snapshot.docs || [])
    .map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
    .find(row => row.purchaseKind === SUBSCRIPTION_PURCHASE_KIND
      && RECOVERABLE_INTENT_STATUSES.includes(String(row.status || ''))) || null;
}

async function pendingSubscriptionIntents({ db, limit = 100 }) {
  const byId = new Map();
  for (const status of RECOVERABLE_INTENT_STATUSES) {
    const snapshot = await db.collection('paymentIntents').where('status', '==', status).limit(limit).get();
    for (const doc of snapshot.docs || []) {
      const row = { id: doc.id, ...(doc.data() || {}) };
      if (row.purchaseKind === SUBSCRIPTION_PURCHASE_KIND) byId.set(doc.id, row);
      if (byId.size >= limit) break;
    }
    if (byId.size >= limit) break;
  }
  return [...byId.values()];
}

function terminalProviderStatus(status) {
  return PROVIDER_TERMINAL_STATUSES.has(String(status || ''));
}

async function recoverPendingSubscriptionPayments({
  admin,
  db,
  queryProvider,
  applyCycle,
  readBillingKey,
  plans,
  logger,
  nowMs = Date.now(),
  limit = 100,
  maxAttempts = boundedAttempts(process.env.SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS),
  maxAgeMs = boundedAgeMs(process.env.SUBSCRIPTION_RECONCILIATION_MAX_AGE_MS)
} = {}) {
  const rows = await pendingSubscriptionIntents({ db, limit });
  const summary = { scanned: rows.length, recovered: 0, deduped: 0, deferred: 0, terminal: 0, manualReview: 0, failed: 0 };
  for (const intent of rows) {
    const intentRef = db.collection('paymentIntents').doc(intent.id);
    const attempts = Math.max(0, Number(intent.reconciliationAttempts) || 0) + 1;
    const ageMs = Math.max(0, nowMs - (timestampMs(intent.createdAt) || nowMs));
    try {
      await intentRef.set({
        reconciliationAttempts: attempts,
        lastReconciliationAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      const provider = await queryProvider(intent.orderId || intent.id);
      if (!provider || !provider.ok) {
        if (attempts >= maxAttempts || ageMs >= maxAgeMs) {
          await intentRef.set({
            status: 'manual_review',
            manualReviewReason: 'provider_lookup_unavailable',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          logger?.error?.('subscription.reconciliation_manual_review', {
            orderId: intent.id,
            reason: 'provider_lookup_unavailable',
            attempts
          });
          summary.manualReview += 1;
        } else {
          summary.deferred += 1;
        }
        continue;
      }

      const payment = provider.data || {};
      const validation = subscriptionProviderValidation(payment, intent);
      if (!validation.ok) {
        const identityMismatch = validation.reasons.some(reason => reason !== 'status_not_done');
        if (identityMismatch) {
          await intentRef.set({
            status: 'manual_review',
            manualReviewReason: 'provider_identity_mismatch',
            validationReasons: validation.reasons,
            providerStatus: validation.providerStatus || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          logger?.error?.('subscription.reconciliation_manual_review', {
            orderId: intent.id,
            reason: 'provider_identity_mismatch',
            attempts
          });
          summary.manualReview += 1;
        } else if (terminalProviderStatus(validation.providerStatus)) {
          await intentRef.set({
            status: 'provider_terminal',
            providerStatus: validation.providerStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          summary.terminal += 1;
        } else if (attempts >= maxAttempts || ageMs >= maxAgeMs) {
          await intentRef.set({
            status: 'manual_review',
            manualReviewReason: 'provider_not_done_timeout',
            validationReasons: validation.reasons,
            providerStatus: validation.providerStatus || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          logger?.error?.('subscription.reconciliation_manual_review', {
            orderId: intent.id,
            reason: 'provider_not_done_timeout',
            attempts
          });
          summary.manualReview += 1;
        } else {
          summary.deferred += 1;
          logger?.warn?.('subscription.reconciliation_deferred', {
            orderId: intent.id,
            reason: 'provider_not_done',
            providerStatus: validation.providerStatus || null,
            attempts
          });
        }
        continue;
      }

      const catalogPlan = plans[intent.tier];
      const storedPlan = subscriptionPlanSnapshot(intent.planSnapshot, intent.amount);
      // A plan price can change between provider approval and cron recovery.
      // The persisted purchase snapshot is authoritative for this already-paid
      // cycle; current catalog data is only used when it still matches.
      const plan = catalogPlan && Number(catalogPlan.amount) === Number(intent.amount)
        ? catalogPlan
        : storedPlan;
      if (!plan || Number(plan.amount) !== Number(intent.amount)) {
        await intentRef.set({
          status: 'manual_review',
          manualReviewReason: 'plan_snapshot_unavailable',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        logger?.error?.('subscription.reconciliation_manual_review', {
          orderId: intent.id,
          reason: 'plan_snapshot_unavailable'
        });
        summary.manualReview += 1;
        continue;
      }
      const billingKey = await readBillingKey(intent.uid, null);
      if (!billingKey) {
        await intentRef.set({
          status: 'manual_review',
          manualReviewReason: 'billing_key_missing',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        logger?.error?.('subscription.reconciliation_manual_review', {
          orderId: intent.id,
          reason: 'billing_key_missing'
        });
        summary.manualReview += 1;
        continue;
      }

      const approval = await markSubscriptionProviderApproved({ admin, db, orderId: intent.id, payment });
      if (!approval.approved) {
        summary.deferred += 1;
        continue;
      }
      if (approval.alreadyApplied) {
        summary.deduped += 1;
        continue;
      }
      const applied = await applyCycle({
        uid: intent.uid,
        tier: intent.tier,
        plan,
        paymentResult: {
          paymentKey: payment.paymentKey,
          orderId: intent.id,
          approvedAt: payment.approvedAt || null
        },
        billingKey,
        cardCompany: intent.cardCompany || null,
        cardNumber: intent.cardNumber || null,
        customerKey: `cust_${intent.uid}`,
        isFirst: intent.isFirst === true
      });
      try {
        await markSubscriptionIntentApplied({ admin, db, orderId: intent.id, source: 'cron_reconciliation' });
      } catch (markError) {
        // applyCycle's subscriptionOrders transaction is the financial source of
        // truth.  A secondary marker failure must not turn an already-granted
        // cycle into a manual grant request; the next cron will dedupe on order.
        summary.failed += 1;
        logger?.error?.('subscription.intent_apply_mark_failed', {
          orderId: intent.id,
          reason: String(markError?.code || markError?.message || 'mark_failed')
        });
        continue;
      }
      if (applied?.deduped) summary.deduped += 1;
      else summary.recovered += 1;
      logger?.info?.('subscription.reconciliation_recovered', {
        orderId: intent.id,
        uid: intent.uid,
        deduped: applied?.deduped === true,
        attempts
      });
    } catch (error) {
      summary.failed += 1;
      const permanent = ['SUBSCRIPTION_ORDER_CONFLICT', 'SUBSCRIPTION_INTENT_CONFLICT'].includes(String(error?.code || error?.message || ''));
      if (permanent || attempts >= maxAttempts || ageMs >= maxAgeMs) {
        await intentRef.set({
          status: 'manual_review',
          manualReviewReason: String(error?.code || error?.message || 'apply_failed').slice(0, 120),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});
        summary.manualReview += 1;
        logger?.error?.('subscription.reconciliation_manual_review', {
          orderId: intent.id,
          reason: String(error?.code || error?.message || 'apply_failed'),
          attempts
        });
      } else {
        logger?.warn?.('subscription.reconciliation_deferred', {
          orderId: intent.id,
          reason: String(error?.code || error?.message || 'apply_failed'),
          attempts
        });
      }
    }
  }
  return summary;
}

module.exports = {
  SUBSCRIPTION_PURCHASE_KIND,
  RECOVERABLE_INTENT_STATUSES,
  PROVIDER_TERMINAL_STATUSES,
  DEFAULT_MAX_RECONCILIATION_ATTEMPTS,
  DEFAULT_MAX_RECONCILIATION_AGE_MS,
  timestampMs,
  boundedAttempts,
  boundedAgeMs,
  providerChargeStatusUncertain,
  subscriptionProviderValidation,
  subscriptionPlanSnapshot,
  prepareSubscriptionIntent,
  markSubscriptionProviderApproved,
  markSubscriptionIntentApplied,
  markSubscriptionIntentProviderRejected,
  findPendingSubscriptionIntentForUid,
  pendingSubscriptionIntents,
  terminalProviderStatus,
  recoverPendingSubscriptionPayments
};
