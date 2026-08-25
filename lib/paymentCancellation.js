'use strict';

const { admin, db } = require('../config');
const { logger } = require('./logger');
const {
  buildCreditCancellationPlan,
  cancellationLedgerId,
  providerCanceledAmount
} = require('./paymentReconciliation');

function safeProviderPaymentSnapshot(payment) {
  const value = payment && typeof payment === 'object' ? payment : {};
  return {
    orderId: typeof value.orderId === 'string' ? value.orderId : null,
    status: typeof value.status === 'string' ? value.status : null,
    totalAmount: Number.isFinite(Number(value.totalAmount)) ? Number(value.totalAmount) : null,
    balanceAmount: Number.isFinite(Number(value.balanceAmount)) ? Number(value.balanceAmount) : null,
    approvedAt: typeof value.approvedAt === 'string' ? value.approvedAt : null,
    cancels: (Array.isArray(value.cancels) ? value.cancels : []).slice(0, 50).map(cancel => ({
      cancelAmount: Number.isFinite(Number(cancel?.cancelAmount)) ? Number(cancel.cancelAmount) : 0,
      canceledAt: typeof cancel?.canceledAt === 'string' ? cancel.canceledAt : null,
      cancelStatus: typeof cancel?.cancelStatus === 'string' ? cancel.cancelStatus : null
    }))
  };
}

async function reconcileCreditPaymentCancellation(payment, { source = 'toss_webhook' } = {}) {
  const orderId = String(payment && payment.orderId || '');
  if (!/^order_\d{10,}$/.test(orderId)) {
    return { handled: false, reason: 'not_credit_order' };
  }
  const canceledAmount = providerCanceledAmount(payment);
  if (!canceledAmount) {
    return { handled: false, reason: 'no_canceled_amount' };
  }

  const orderRef = db.collection('orders').doc(orderId);
  const ledgerRef = db.collection('systemCreditReconciliations').doc(cancellationLedgerId(orderId, canceledAmount));
  const result = await db.runTransaction(async transaction => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return { handled: false, reason: 'order_not_found' };

    const order = orderSnapshot.data() || {};
    const userRef = order.uid ? db.collection('users').doc(order.uid) : null;
    const userSnapshot = userRef ? await transaction.get(userRef) : null;
    const refundHistorySnapshot = userRef
      ? await transaction.get(userRef.collection('creditHistory').where('orderId', '==', orderId))
      : null;
    const ledgerSnapshot = await transaction.get(ledgerRef);
    const userExists = Boolean(userSnapshot && userSnapshot.exists);
    const currentCredits = userExists ? Number(userSnapshot.data()?.credits) || 0 : 0;
    const knownRefundLedgerCredits = refundHistorySnapshot
      ? refundHistorySnapshot.docs
        .map(doc => doc.data() || {})
        .filter(row => row.type === 'refund')
        .reduce((sum, row) => sum + Math.abs(Math.min(0, Number(row.amount) || 0)), 0)
      : 0;
    const plan = buildCreditCancellationPlan({
      payment,
      order,
      currentCredits,
      knownRefundLedgerCredits,
      userExists
    });
    if (!plan.applicable) return { handled: false, reason: plan.reason };

    const now = admin.firestore.FieldValue.serverTimestamp();
    const orderUpdate = {
      status: plan.orderStatus,
      refundAmount: plan.canceledAmount,
      refundedAmount: plan.canceledAmount,
      refundedCredits: plan.appliedCredits,
      providerRefundTargetCredits: plan.targetCredits,
      providerUnrecoveredCredits: plan.unrecoveredCredits,
      providerStatus: plan.providerStatus,
      providerReconciledAt: now
    };
    if (plan.clearProcessing) orderUpdate.refundProcessing = admin.firestore.FieldValue.delete();

    if (ledgerSnapshot.exists) {
      transaction.update(orderRef, orderUpdate);
      return {
        handled: true,
        duplicate: true,
        orderId,
        uid: order.uid || null,
        ...plan
      };
    }

    const remaining = userExists ? currentCredits - plan.balanceDebit : 0;
    if (userExists && plan.balanceDebit > 0) {
      transaction.update(userRef, { credits: remaining });
    }
    transaction.update(orderRef, orderUpdate);
    transaction.set(ledgerRef, {
      kind: 'credit_payment_cancellation',
      orderId,
      uid: order.uid || null,
      source,
      providerStatus: plan.providerStatus,
      canceledAmount: plan.canceledAmount,
      targetCredits: plan.targetCredits,
      previousRefundedCredits: plan.existingCredits,
      knownRefundLedgerCredits: plan.knownLedgerCredits,
      reservedCredits: plan.processingReserved,
      deductedCredits: plan.balanceDebit,
      ledgerCredits: plan.ledgerCredits,
      appliedCredits: plan.appliedCredits,
      unrecoveredCredits: plan.unrecoveredCredits,
      remaining,
      operationId: plan.operationId,
      createdAt: now
    });

    if (userExists && plan.ledgerCredits > 0) {
      transaction.set(userRef.collection('creditHistory').doc(ledgerRef.id), {
        type: 'refund',
        used: 0,
        amount: -plan.ledgerCredits,
        remaining,
        orderId,
        source,
        providerCanceledAmount: plan.canceledAmount,
        expectedRefundCredits: plan.targetCredits,
        unrecoveredCredits: plan.unrecoveredCredits,
        createdAt: now
      });
    }

    return {
      handled: true,
      duplicate: false,
      orderId,
      uid: order.uid || null,
      ...plan,
      remaining
    };
  });

  if (result.handled) {
    const event = result.unrecoveredCredits > 0
      ? 'payment.cancellation_reconciled_with_unrecovered_credits'
      : 'payment.cancellation_reconciled';
    logger[result.unrecoveredCredits > 0 ? 'warn' : 'info'](event, {
      orderId: result.orderId,
      uid: result.uid,
      providerStatus: result.providerStatus,
      canceledAmount: result.canceledAmount,
      deductedCredits: result.balanceDebit,
      reservedCredits: result.processingReserved,
      unrecoveredCredits: result.unrecoveredCredits,
      duplicate: result.duplicate
    });
  }
  return result;
}

async function reconcilePendingCreditCancellationInboxes({ limit = 25 } = {}) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const snapshot = await db.collection('webhookInbox')
    .where('creditCancellationCandidate', '==', true)
    .limit(boundedLimit * 2)
    .get();
  const docs = snapshot.docs.filter(doc => ['received', 'error'].includes(doc.data()?.status));

  const results = { scanned: docs.length, processed: 0, failed: 0, skipped: 0 };
  for (const doc of docs.slice(0, boundedLimit)) {
    const row = doc.data() || {};
    if (!/^order_\d{10,}$/.test(String(row.orderId || '')) || !row.providerPayment) {
      results.skipped += 1;
      continue;
    }
    try {
      const reconciled = await reconcileCreditPaymentCancellation(row.providerPayment, { source: 'webhook_inbox_retry' });
      await doc.ref.update({
        status: 'processed',
        creditCancellationCandidate: false,
        reconciliationHandled: reconciled.handled === true,
        reconciliationReason: reconciled.reason || null,
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      results.processed += 1;
    } catch (error) {
      results.failed += 1;
      await doc.ref.update({
        status: 'error',
        error: String(error?.message || error).slice(0, 500),
        retryAt: admin.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
      logger.error('payment.cancellation_inbox_retry_failed', { inboxId: doc.id, orderId: row.orderId, err: error });
    }
  }
  return results;
}

module.exports = {
  reconcileCreditPaymentCancellation,
  reconcilePendingCreditCancellationInboxes,
  safeProviderPaymentSnapshot
};
