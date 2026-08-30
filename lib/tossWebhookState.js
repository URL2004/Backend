'use strict';

const MAX_PROVIDER_KEY_LENGTH = 300;
const GENERAL_WEBHOOK_MAX_FAILURES = 5;
const GENERAL_WEBHOOK_LEASE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['processed', 'manual_review']);

function boundedInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
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

function validProviderKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROVIDER_KEY_LENGTH
    && value.trim() === value;
}

function isCreditOrderId(value) {
  // Legacy orders were `order_<timestamp>`. Current clients append an
  // unguessable entropy suffix: `order_<timestamp>_<entropy>`. Keep the
  // timestamp floor strict so unrelated provider orders cannot enter the
  // credit-cancellation ledger.
  return /^order_\d{10,}(?:_[A-Za-z0-9_-]{4,40})?$/.test(String(value || ''));
}

function retryLaneFor(eventType, orderId) {
  if ((eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'CANCEL_STATUS_CHANGED')
    && isCreditOrderId(orderId)) {
    return 'credit_cancellation';
  }
  return 'general';
}

function receiptCounterPatch(row, nowValue, { isNew = false } = {}) {
  const current = row && typeof row === 'object' ? row : {};
  const patch = {
    lastReceivedAt: nowValue,
    deliveryCount: boundedInteger(current.deliveryCount) + 1
  };
  if (isNew) {
    patch.receivedAt = nowValue;
    patch.firstReceivedAt = nowValue;
    patch.retryAttempts = 0;
  } else if (!current.firstReceivedAt) {
    patch.firstReceivedAt = current.receivedAt || nowValue;
  }
  return patch;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || ''));
}

function hasActiveLease(row, nowMs = Date.now()) {
  return String(row?.status || '') === 'processing'
    && timestampMillis(row?.leaseUntil) > nowMs;
}

function isGeneralWebhookClaimable(row, nowMs = Date.now()) {
  if (!row || retryLaneFor(row.eventType, row.orderId) !== 'general') return false;
  if (isTerminalStatus(row.status)) return false;
  if (String(row.status || '') === 'processing') return !hasActiveLease(row, nowMs);
  return ['received', 'error'].includes(String(row.status || ''));
}

function compareGeneralWebhookPriority(left, right) {
  const a = left?.data ? left.data() || {} : left || {};
  const b = right?.data ? right.data() || {} : right || {};
  return boundedInteger(a.retryAttempts) - boundedInteger(b.retryAttempts)
    || timestampMillis(a.lastAttemptAt || a.retryAt || a.firstReceivedAt || a.receivedAt)
      - timestampMillis(b.lastAttemptAt || b.retryAt || b.firstReceivedAt || b.receivedAt)
    || String(left?.id || '').localeCompare(String(right?.id || ''));
}

function nextFailureState(row, nowValue, errorCode) {
  // retryAttempts is incremented when a worker acquires a lease, not when it
  // reports failure. That way a process crash after the claim still consumes a
  // bounded attempt and cannot loop forever without reaching manual review.
  const failures = Math.max(1, boundedInteger(row?.retryAttempts));
  const exhausted = failures >= GENERAL_WEBHOOK_MAX_FAILURES;
  return {
    status: exhausted ? 'manual_review' : 'error',
    generalWebhookCandidate: !exhausted,
    retryAttempts: failures,
    lastAttemptAt: nowValue,
    ...(exhausted ? { processedAt: nowValue, manualReviewReason: 'general_webhook_retry_exhausted' } : { retryAt: nowValue }),
    errorCode: String(errorCode || 'WEBHOOK_HANDLER_FAILED').slice(0, 80),
    leaseToken: null,
    leaseUntil: null
  };
}

function nextAttemptNumber(row) {
  return boundedInteger(row?.retryAttempts) + 1;
}

function subscriptionGenerationMatches({ subscription, order, orderId }) {
  const sub = subscription && typeof subscription === 'object' ? subscription : {};
  const value = order && typeof order === 'object' ? order : {};
  const expectedOrderId = String(sub.currentOrderId || '');
  if (expectedOrderId) return expectedOrderId === String(orderId || '');

  // Backward compatibility for subscriptions created before currentOrderId was
  // stored.  Only an exact cycle timestamp is evidence that the webhook belongs
  // to the active generation; absence of evidence fails closed.
  const subscriptionCycle = timestampMillis(sub.cycleStartedAt || sub.lastBillingAt);
  const orderCycle = timestampMillis(value.cycleStartedAt || value.approvedAt);
  return subscriptionCycle > 0 && orderCycle > 0 && subscriptionCycle === orderCycle;
}

module.exports = {
  GENERAL_WEBHOOK_LEASE_MS,
  GENERAL_WEBHOOK_MAX_FAILURES,
  MAX_PROVIDER_KEY_LENGTH,
  compareGeneralWebhookPriority,
  hasActiveLease,
  isGeneralWebhookClaimable,
  isTerminalStatus,
  nextFailureState,
  nextAttemptNumber,
  receiptCounterPatch,
  isCreditOrderId,
  retryLaneFor,
  subscriptionGenerationMatches,
  timestampMillis,
  validProviderKey
};
