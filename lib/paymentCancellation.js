'use strict';

const { admin, db } = require('../config');
const { logger } = require('./logger');
const {
  buildCreditCancellationPlan,
  cancellationLedgerId,
  providerCanceledAmount
} = require('./paymentReconciliation');
const {
  CREDIT_LOT_POLICY_VERSION,
  allocateProviderCancellation,
  hasNumericLotBalances,
  normalizeTrackedLot
} = require('./creditLotAccounting');
const { isCreditOrderId } = require('./tossWebhookState');

function creditLotValue(snapshot) {
  if (!snapshot?.exists) return null;
  return { ...(snapshot.data() || {}), id: snapshot.id, ref: snapshot.ref };
}

function activeCreditLotsQuery(userRef) {
  return userRef.collection('creditLots')
    .where('active', '==', true);
}

function creditLotInconsistent(details = {}) {
  logger.error('credit_lot.inconsistent', { action: 'block_provider_cancellation', ...details });
  return Object.assign(new Error('CREDIT_LOT_INCONSISTENT'), { status: 503 });
}

function representedTrackedBalance(lots) {
  return lots.reduce((sum, value) => {
    const lot = normalizeTrackedLot(value);
    return lot ? sum + lot.paidRemaining + lot.bonusRemaining : sum;
  }, 0);
}

const TERMINAL_CREDIT_CANCELLATION_REASONS = new Set([
  // These outcomes prove that the provider event has no credit cancellation to
  // apply. Every other handled:false result is retained for retry so a race or
  // temporarily incomplete order cannot silently lose a real cancellation.
  'not_credit_order',
  'no_canceled_amount',
  'provider_status_not_canceled'
]);

const CREDIT_CANCELLATION_MAX_RETRY_ATTEMPTS = 3;
const CREDIT_CANCELLATION_RETRY_TTL_MS = 24 * 60 * 60 * 1000;
const CREDIT_CANCELLATION_SAMPLE_MAX = 500;
const CREDIT_CANCELLATION_PENDING_INTENT_STATUSES = new Set([
  'confirming',
  'status_unknown',
  'approved_reconciliation_required'
]);
const CREDIT_CANCELLATION_NO_CREDIT_INTENT_STATUSES = new Set([
  'cancellation_no_credit',
  'confirm_failed',
  'provider_not_done',
  'manual_review',
  'canceled',
  'cancelled',
  'failed',
  'rejected'
]);
const TERMINAL_WEBHOOK_INBOX_STATUSES = new Set(['processed', 'manual_review']);

function isTerminalWebhookInboxStatus(status) {
  return TERMINAL_WEBHOOK_INBOX_STATUSES.has(String(status || ''));
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return Number(value.toDate()?.getTime()) || 0;
  if (Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function retryAttempts(row) {
  return Math.max(0, Math.floor(Number(row?.retryAttempts) || 0));
}

function cancellationInboxAgeMs(row, nowMs = Date.now()) {
  const receivedAtMs = timestampMillis(row?.receivedAt || row?.createdAt || row?.firstReceivedAt);
  return receivedAtMs > 0 ? Math.max(0, nowMs - receivedAtMs) : 0;
}

function shouldQuarantineCancellationInbox(row, nextAttempts, nowMs = Date.now()) {
  return nextAttempts >= CREDIT_CANCELLATION_MAX_RETRY_ATTEMPTS
    || cancellationInboxAgeMs(row, nowMs) >= CREDIT_CANCELLATION_RETRY_TTL_MS;
}

function cancellationRetryPriority(doc) {
  const row = doc.data() || {};
  const lastAttemptAt = timestampMillis(row.lastAttemptAt || row.retryAt);
  const receivedAt = timestampMillis(row.receivedAt || row.createdAt || row.firstReceivedAt);
  return {
    attempts: retryAttempts(row),
    lastAttemptAt: lastAttemptAt || receivedAt,
    id: String(doc.id || '')
  };
}

function compareCancellationInboxPriority(left, right) {
  const a = cancellationRetryPriority(left);
  const b = cancellationRetryPriority(right);
  return a.attempts - b.attempts
    || a.lastAttemptAt - b.lastAttemptAt
    || a.id.localeCompare(b.id);
}

function classifyMissingOrderPaymentIntent(intentSnapshot) {
  if (!intentSnapshot?.exists) return { kind: 'no_credit', status: 'missing' };
  const status = String(intentSnapshot.data()?.status || '').toLowerCase();
  if (status === 'applied') return { kind: 'retry_now', status };
  if (status === 'cancellation_review_required') return { kind: 'manual_review', status };
  if (CREDIT_CANCELLATION_NO_CREDIT_INTENT_STATUSES.has(status)) {
    return { kind: 'no_credit', status };
  }
  if (CREDIT_CANCELLATION_PENDING_INTENT_STATUSES.has(status)) {
    return { kind: 'pending', status };
  }
  // Unknown intent states are not evidence that no credit was granted. Keep the
  // cancellation retryable, then isolate it after the same bounded retry policy.
  return { kind: 'pending', status: status || 'unknown' };
}

function classifyCreditCancellationResult(result) {
  if (result?.handled === true) {
    return {
      terminal: true,
      inboxStatus: 'processed',
      creditCancellationCandidate: false,
      reason: result.reason || null
    };
  }
  const reason = String(result?.reason || 'reconciliation_not_handled');
  if (TERMINAL_CREDIT_CANCELLATION_REASONS.has(reason)) {
    return {
      terminal: true,
      inboxStatus: 'processed',
      creditCancellationCandidate: false,
      reason
    };
  }
  return {
    terminal: false,
    inboxStatus: ['order_not_found', 'pending_refund_not_provider_confirmed'].includes(reason)
      ? 'received'
      : 'error',
    creditCancellationCandidate: true,
    reason
  };
}

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
  if (!isCreditOrderId(orderId)) {
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
    const existingCanceledAmount = Math.max(
      0,
      Math.floor(Number(order.refundedAmount ?? order.refundAmount) || 0)
    );
    const staleProviderEvent = existingCanceledAmount > plan.canceledAmount
      || (order.status === 'refunded' && plan.orderStatus !== 'refunded');
    if (staleProviderEvent) {
      return {
        handled: true,
        duplicate: true,
        stale: true,
        reason: 'stale_provider_cancellation',
        orderId,
        uid: order.uid || null,
        ...plan,
        canceledAmount: existingCanceledAmount,
        orderStatus: order.status,
        balanceDebit: 0,
        unrecoveredCredits: Math.max(0, Number(order.providerUnrecoveredCredits) || 0)
      };
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    if (ledgerSnapshot.exists) {
      return {
        handled: true,
        duplicate: true,
        orderId,
        uid: order.uid || null,
        ...plan,
        balanceDebit: 0
      };
    }

    const trackedBalance = userExists
      ? Math.max(0, Math.floor(Number(userSnapshot.data()?.creditLotV1Balance) || 0))
      : 0;
    if (trackedBalance > currentCredits) {
      throw creditLotInconsistent({ orderId, reason: 'tracked_balance_exceeds_wallet' });
    }
    const usesBaseCreditPolicy = plan.refundCreditBasis === 'paid_credits_first';
    let ownLot = null;
    let otherLots = [];
    if (usesBaseCreditPolicy && userExists) {
      const ownLotSnapshot = await transaction.get(userRef.collection('creditLots').doc(orderId));
      ownLot = creditLotValue(ownLotSnapshot);
      const expectsTrackedLot = hasNumericLotBalances(order);
      const normalizedOwnLot = normalizeTrackedLot(ownLot);
      if (expectsTrackedLot && (
        !normalizedOwnLot
        || normalizedOwnLot.paidRemaining !== Math.floor(Number(order.refundPaidCreditsRemaining))
        || normalizedOwnLot.bonusRemaining !== Math.floor(Number(order.refundEventBonusCreditsRemaining))
      )) {
        throw creditLotInconsistent({ orderId, reason: 'root_lot_mismatch' });
      }
      const preliminary = allocateProviderCancellation({
        targetCredits: plan.targetCredits,
        accountedCredits: plan.accountedCredits,
        globalBalance: currentCredits,
        trackedBalance,
        canceledOrderId: orderId,
        canceledLot: ownLot,
        otherLots: [],
        usesBaseCreditPolicy: true
      });
      if (preliminary.unrecoveredCredits > 0 && trackedBalance > preliminary.ownLotCredits) {
        const activeLotsSnapshot = await transaction.get(activeCreditLotsQuery(userRef));
        otherLots = activeLotsSnapshot.docs.map(creditLotValue).filter(Boolean);
        if (representedTrackedBalance(otherLots) !== trackedBalance) {
          throw creditLotInconsistent({ orderId, reason: 'tracked_balance_mismatch' });
        }
      }
    }

    const creditAllocation = allocateProviderCancellation({
      targetCredits: plan.targetCredits,
      accountedCredits: plan.accountedCredits,
      globalBalance: currentCredits,
      trackedBalance,
      canceledOrderId: orderId,
      canceledLot: ownLot,
      otherLots,
      usesBaseCreditPolicy
    });
    if (creditAllocation.trackedCredits > trackedBalance) {
      throw creditLotInconsistent({ orderId, reason: 'tracked_debit_exceeds_balance' });
    }
    const otherRootOrderRefs = creditAllocation.lotUpdates
      .filter(lot => lot.orderId !== orderId)
      .map(lot => db.collection('orders').doc(lot.orderId));
    if (otherRootOrderRefs.length > 0) {
      // Lock mirrored root orders before any write so refund/admin reads cannot race
      // with this cross-order recovery.
      await transaction.getAll(...otherRootOrderRefs);
    }

    const ledgerCredits = plan.processingReserved + creditAllocation.balanceDebit;
    const remaining = userExists ? currentCredits - creditAllocation.balanceDebit : 0;
    const orderUpdate = {
      status: order.status === 'refunded' ? 'refunded' : plan.orderStatus,
      refundAmount: Math.max(existingCanceledAmount, plan.canceledAmount),
      refundedAmount: Math.max(existingCanceledAmount, plan.canceledAmount),
      refundedCredits: creditAllocation.appliedCredits,
      providerRefundTargetCredits: plan.targetCredits,
      providerUnrecoveredCredits: creditAllocation.unrecoveredCredits,
      providerStatus: plan.providerStatus,
      providerReconciledAt: now
    };
    if (plan.clearProcessing) {
      orderUpdate.refundProcessing = admin.firestore.FieldValue.delete();
      // 승인 API 응답이 유실된 사이 provider webhook/cron이 먼저 취소를 확정해도
      // request-time reservation 상태를 provider_canceling에 남겨 두지 않는다.
      orderUpdate.refundReservationState = 'settled';
      orderUpdate.refundReservationOperationId = plan.operationId || order.refundReservationOperationId || null;
      orderUpdate.refundReservationSettledAt = now;
    }

    if (userExists && creditAllocation.balanceDebit > 0) {
      const userUpdate = { credits: remaining };
      if (creditAllocation.trackedCredits > 0) {
        userUpdate.creditLotV1Balance = creditAllocation.newTrackedBalance;
      }
      transaction.update(userRef, userUpdate);
    }
    for (const lot of creditAllocation.lotUpdates) {
      if (!lot.ref) throw creditLotInconsistent({ orderId, reason: 'lot_ref_missing' });
      transaction.update(lot.ref, {
        refundPaidCreditsRemaining: lot.paidRemaining,
        refundEventBonusCreditsRemaining: lot.bonusRemaining,
        active: lot.active,
        creditLotUpdatedAt: now
      });
      const mirror = {
        refundPaidCreditsRemaining: lot.paidRemaining,
        refundEventBonusCreditsRemaining: lot.bonusRemaining,
        creditLotActive: lot.active,
        creditLotUpdatedAt: now
      };
      if (lot.orderId === orderId) Object.assign(orderUpdate, mirror);
      else transaction.update(db.collection('orders').doc(lot.orderId), mirror);
    }
    transaction.update(orderRef, orderUpdate);
    transaction.set(ledgerRef, {
      kind: 'credit_payment_cancellation',
      creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
      orderId,
      uid: order.uid || null,
      source,
      providerStatus: plan.providerStatus,
      canceledAmount: plan.canceledAmount,
      targetCredits: plan.targetCredits,
      previousRefundedCredits: plan.existingCredits,
      knownRefundLedgerCredits: plan.knownLedgerCredits,
      reservedCredits: plan.processingReserved,
      deductedCredits: creditAllocation.balanceDebit,
      untrackedCredits: creditAllocation.untrackedCredits,
      trackedCredits: creditAllocation.trackedCredits,
      ownLotCredits: creditAllocation.ownLotCredits,
      otherLotCredits: creditAllocation.otherLotCredits,
      creditLotAllocations: creditAllocation.allocations,
      ledgerCredits,
      appliedCredits: creditAllocation.appliedCredits,
      unrecoveredCredits: creditAllocation.unrecoveredCredits,
      remaining,
      operationId: plan.operationId,
      createdAt: now
    });

    if (userExists && ledgerCredits > 0) {
      transaction.set(userRef.collection('creditHistory').doc(ledgerRef.id), {
        type: 'refund',
        used: 0,
        amount: -ledgerCredits,
        remaining,
        orderId,
        source,
        providerCanceledAmount: plan.canceledAmount,
        expectedRefundCredits: plan.targetCredits,
        creditLotPolicyVersion: CREDIT_LOT_POLICY_VERSION,
        creditLotUntrackedUsed: creditAllocation.untrackedCredits,
        creditLotTrackedUsed: creditAllocation.trackedCredits,
        creditLotAllocations: creditAllocation.allocations,
        unrecoveredCredits: creditAllocation.unrecoveredCredits,
        createdAt: now
      });
    }

    return {
      handled: true,
      duplicate: false,
      orderId,
      uid: order.uid || null,
      ...plan,
      ...creditAllocation,
      ledgerCredits,
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

async function finalizeMissingOrderCancellation({
  inboxRef,
  orderId,
  requestedDisposition,
  retryAttemptCount,
  reason,
  sourceIntentStatus = null
}) {
  const orderRef = db.collection('orders').doc(orderId);
  const intentRef = db.collection('paymentIntents').doc(orderId);
  return db.runTransaction(async transaction => {
    const orderSnapshot = await transaction.get(orderRef);
    const intentSnapshot = await transaction.get(intentRef);
    const inboxSnapshot = await transaction.get(inboxRef);
    if (orderSnapshot.exists) return { orderAppeared: true };
    if (!inboxSnapshot.exists || inboxSnapshot.data()?.creditCancellationCandidate !== true) {
      return { stale: true };
    }

    const currentIntent = classifyMissingOrderPaymentIntent(intentSnapshot);
    if (requestedDisposition === 'no_credit'
      && currentIntent.kind !== 'no_credit') {
      // preparePaymentIntent may have raced with the webhook. Do not overwrite a
      // newly-created approval state with a no-credit conclusion; let the caller
      // immediately re-evaluate/retry instead.
      return { intentChanged: true, intentDisposition: currentIntent };
    }
    const noCredit = currentIntent.kind === 'no_credit';
    const finalDisposition = noCredit ? 'no_credit' : 'manual_review';
    const now = admin.firestore.FieldValue.serverTimestamp();
    const intentStatus = finalDisposition === 'no_credit'
      ? 'cancellation_no_credit'
      : 'cancellation_review_required';
    const reconciliationReason = finalDisposition === 'no_credit'
      ? `order_not_found_${currentIntent.status}_no_credit`
      : 'order_not_found_manual_review';

    transaction.set(intentRef, {
      orderId,
      status: intentStatus,
      creditCancellationLocked: true,
      creditCancellationPreviousStatus: currentIntent.status || sourceIntentStatus || null,
      cancellationInboxId: inboxRef.id,
      cancellationReason: reason || reconciliationReason,
      cancellationReviewRequired: finalDisposition === 'manual_review',
      cancellationLockedAt: now,
      updatedAt: now
    }, { merge: true });
    transaction.update(inboxRef, {
      status: finalDisposition === 'manual_review' ? 'manual_review' : 'processed',
      creditCancellationCandidate: false,
      reconciliationHandled: false,
      reconciliationReason,
      retryAttempts: retryAttemptCount,
      lastAttemptAt: now,
      processedAt: now,
      ...(finalDisposition === 'manual_review' ? { quarantinedAt: now } : {})
    });
    return {
      locked: true,
      disposition: finalDisposition,
      intentStatus: currentIntent.status,
      reconciliationReason
    };
  });
}

async function markCancellationManualReview({ doc, row, attempts, reason, intentStatus = null }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await doc.ref.update({
    status: 'manual_review',
    creditCancellationCandidate: false,
    reconciliationHandled: false,
    reconciliationReason: reason,
    retryAttempts: attempts,
    lastAttemptAt: now,
    quarantinedAt: now,
    processedAt: now
  });
  logger.error('payment.cancellation_review_required', {
    inboxId: doc.id,
    orderId: row.orderId,
    retryAttempts: attempts,
    ageMs: cancellationInboxAgeMs(row),
    intentStatus,
    reason
  });
}

async function markMissingOrderFinalization({ doc, row, attempts, requestedDisposition, intentStatus }) {
  const finalized = await finalizeMissingOrderCancellation({
    inboxRef: doc.ref,
    orderId: String(row.orderId),
    requestedDisposition,
    retryAttemptCount: attempts,
    reason: requestedDisposition === 'no_credit'
      ? `order_not_found_${intentStatus || 'missing'}_no_credit`
      : 'order_not_found_retry_exhausted',
    sourceIntentStatus: intentStatus
  });
  if (finalized.locked && finalized.disposition === 'manual_review') {
    logger.error('payment.cancellation_review_required', {
      inboxId: doc.id,
      orderId: row.orderId,
      retryAttempts: attempts,
      ageMs: cancellationInboxAgeMs(row),
      intentStatus: finalized.intentStatus || intentStatus,
      reason: finalized.reconciliationReason
    });
  } else if (finalized.locked && finalized.disposition === 'no_credit') {
    logger.info('payment.cancellation_no_credit_terminal', {
      inboxId: doc.id,
      orderId: row.orderId,
      retryAttempts: attempts,
      intentStatus: finalized.intentStatus || intentStatus
    });
  }
  return finalized;
}

async function updateCancellationInboxFromResult(doc, reconciled, disposition, attempts) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await doc.ref.update({
    status: disposition.inboxStatus,
    creditCancellationCandidate: disposition.creditCancellationCandidate,
    reconciliationHandled: reconciled.handled === true,
    reconciliationReason: disposition.reason,
    retryAttempts: attempts,
    lastAttemptAt: now,
    ...(disposition.terminal ? { processedAt: now } : { retryAt: now })
  });
}

async function reconcilePendingCreditCancellationInboxes({ limit = 25 } = {}) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const sampleLimit = Math.min(
    CREDIT_CANCELLATION_SAMPLE_MAX,
    Math.max(100, boundedLimit * 8)
  );
  const snapshot = await db.collection('webhookInbox')
    .where('creditCancellationCandidate', '==', true)
    .limit(sampleLimit)
    .get();
  const docs = snapshot.docs
    .filter(doc => ['received', 'error'].includes(doc.data()?.status))
    .sort(compareCancellationInboxPriority)
    .slice(0, boundedLimit);

  const results = {
    scanned: docs.length,
    processed: 0,
    pending: 0,
    manualReview: 0,
    noCredit: 0,
    failed: 0,
    skipped: 0
  };
  for (const doc of docs) {
    const row = doc.data() || {};
    const attempts = retryAttempts(row) + 1;
    if (!isCreditOrderId(row.orderId) || !row.providerPayment) {
      await doc.ref.update({
        status: 'processed',
        creditCancellationCandidate: false,
        reconciliationHandled: false,
        reconciliationReason: 'invalid_inbox_payload',
        retryAttempts: attempts,
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
      results.skipped += 1;
      continue;
    }
    try {
      let reconciled = await reconcileCreditPaymentCancellation(row.providerPayment, { source: 'webhook_inbox_retry' });
      let disposition = classifyCreditCancellationResult(reconciled);

      if (!disposition.terminal && disposition.reason === 'order_not_found') {
        const intentRef = db.collection('paymentIntents').doc(String(row.orderId));
        const intentSnapshot = await intentRef.get();
        let intentDisposition = classifyMissingOrderPaymentIntent(intentSnapshot);

        if (intentDisposition.kind === 'retry_now') {
          // An applied intent means the order transaction may have committed just
          // after the first read. Retry once in this run before quarantining.
          reconciled = await reconcileCreditPaymentCancellation(row.providerPayment, {
            source: 'webhook_inbox_order_race_retry'
          });
          disposition = classifyCreditCancellationResult(reconciled);
          if (disposition.terminal) {
            await updateCancellationInboxFromResult(doc, reconciled, disposition, attempts);
            results.processed += 1;
            continue;
          }
          intentDisposition = { kind: 'manual_review', status: 'applied' };
        }

        if (intentDisposition.kind === 'no_credit') {
          const finalized = await markMissingOrderFinalization({
            doc,
            row,
            attempts,
            requestedDisposition: 'no_credit',
            intentStatus: intentDisposition.status
          });
          if (finalized.orderAppeared || finalized.intentChanged) {
            const raced = await reconcileCreditPaymentCancellation(row.providerPayment, {
              source: 'webhook_inbox_lock_race_retry'
            });
            const racedDisposition = classifyCreditCancellationResult(raced);
            if (racedDisposition.terminal) {
              await updateCancellationInboxFromResult(doc, raced, racedDisposition, attempts);
              results.processed += 1;
            } else if (shouldQuarantineCancellationInbox(row, attempts)) {
              if (racedDisposition.reason === 'order_not_found') {
                const quarantined = await markMissingOrderFinalization({
                  doc,
                  row,
                  attempts,
                  requestedDisposition: 'manual_review',
                  intentStatus: finalized.intentDisposition?.status || intentDisposition.status
                });
                if (quarantined.locked) results.manualReview += 1;
                else {
                  await markCancellationManualReview({
                    doc,
                    row,
                    attempts,
                    reason: 'order_not_found_lock_race_retry_exhausted'
                  });
                  results.manualReview += 1;
                }
              } else {
                await markCancellationManualReview({
                  doc,
                  row,
                  attempts,
                  reason: `${racedDisposition.reason || 'reconciliation_pending'}_retry_exhausted`
                });
                results.manualReview += 1;
              }
            } else {
              await updateCancellationInboxFromResult(doc, raced, racedDisposition, attempts);
              results.pending += 1;
            }
          } else if (finalized.disposition === 'manual_review') {
            results.manualReview += 1;
          } else {
            results.processed += 1;
            results.noCredit += 1;
          }
          continue;
        }

        if (intentDisposition.kind === 'manual_review'
          || shouldQuarantineCancellationInbox(row, attempts)) {
          const finalized = await markMissingOrderFinalization({
            doc,
            row,
            attempts,
            requestedDisposition: 'manual_review',
            intentStatus: intentDisposition.status
          });
          if (finalized.orderAppeared) {
            const raced = await reconcileCreditPaymentCancellation(row.providerPayment, {
              source: 'webhook_inbox_quarantine_race_retry'
            });
            const racedDisposition = classifyCreditCancellationResult(raced);
            if (racedDisposition.terminal) {
              await updateCancellationInboxFromResult(doc, raced, racedDisposition, attempts);
              results.processed += 1;
            } else {
              await markCancellationManualReview({
                doc,
                row,
                attempts,
                reason: `${racedDisposition.reason || 'reconciliation_pending'}_retry_exhausted`,
                intentStatus: intentDisposition.status
              });
              results.manualReview += 1;
            }
          } else {
            results.manualReview += 1;
          }
          continue;
        }
      }

      if (!disposition.terminal && shouldQuarantineCancellationInbox(row, attempts)) {
        await markCancellationManualReview({
          doc,
          row,
          attempts,
          reason: `${disposition.reason || 'reconciliation_pending'}_retry_exhausted`
        });
        results.manualReview += 1;
        continue;
      }

      await updateCancellationInboxFromResult(doc, reconciled, disposition, attempts);
      if (disposition.terminal) results.processed += 1;
      else results.pending += 1;
    } catch (error) {
      if (shouldQuarantineCancellationInbox(row, attempts)) {
        await markCancellationManualReview({
          doc,
          row,
          attempts,
          reason: 'reconciliation_error_retry_exhausted'
        }).catch(() => {});
        results.manualReview += 1;
      } else {
        results.failed += 1;
        await doc.ref.update({
          status: 'error',
          creditCancellationCandidate: true,
          reconciliationHandled: false,
          reconciliationReason: 'reconciliation_error',
          retryAttempts: attempts,
          error: String(error?.message || error).slice(0, 500),
          lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
          retryAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }
      logger.error('payment.cancellation_inbox_retry_failed', { inboxId: doc.id, orderId: row.orderId, err: error });
    }
  }
  return results;
}

module.exports = {
  CREDIT_CANCELLATION_MAX_RETRY_ATTEMPTS,
  CREDIT_CANCELLATION_RETRY_TTL_MS,
  classifyMissingOrderPaymentIntent,
  classifyCreditCancellationResult,
  compareCancellationInboxPriority,
  isTerminalWebhookInboxStatus,
  reconcileCreditPaymentCancellation,
  reconcilePendingCreditCancellationInboxes,
  safeProviderPaymentSnapshot
};
