'use strict';

const DEFAULT_RECENT_AUTH_SECONDS = 15 * 60;
const ACTIVE_TRANSFORM_STATUSES = new Set(['queued', 'running', 'awaiting_approval']);
const PENDING_PAYMENT_INTENT_STATUSES = new Set([
  'confirming',
  'approved_reconciliation_required',
  'manual_review'
]);
const PENDING_REFUND_PHASES = new Set(['requested_reserved', 'provider_canceling']);
const REFUND_WINDOW_DAYS_FALLBACK = 7;

function finiteTimestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (Number.isFinite(Number(value._seconds))) return Number(value._seconds) * 1000;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentAuthMaxAgeSeconds(env = process.env) {
  const configured = Number(env.ACCOUNT_DELETE_MAX_AUTH_AGE_SEC);
  if (!Number.isFinite(configured)) return DEFAULT_RECENT_AUTH_SECONDS;
  return Math.max(60, Math.min(3600, Math.floor(configured)));
}

function assertRecentAuth(decodedToken, {
  nowMs = Date.now(),
  maxAgeSeconds = recentAuthMaxAgeSeconds()
} = {}) {
  const authTimeSeconds = Number(decodedToken && decodedToken.auth_time);
  const nowSeconds = Math.floor(Number(nowMs) / 1000);
  const ageSeconds = nowSeconds - authTimeSeconds;
  if (!Number.isFinite(authTimeSeconds)
    || authTimeSeconds <= 0
    || ageSeconds < -300
    || ageSeconds > maxAgeSeconds) {
    const error = new Error('RECENT_LOGIN_REQUIRED');
    error.code = 'RECENT_LOGIN_REQUIRED';
    error.status = 401;
    error.maxAgeSeconds = maxAgeSeconds;
    throw error;
  }
  return { authTimeSeconds, ageSeconds, maxAgeSeconds };
}

function activeSubscription(user, nowMs = Date.now()) {
  const subscription = user && user.subscription;
  if (!subscription || typeof subscription !== 'object') return false;
  if (String(subscription.status || '') === 'active') return true;
  return String(subscription.status || '') === 'cancelled'
    && finiteTimestampMs(subscription.nextBillingAt) > Number(nowMs);
}

function refundIsPending(order) {
  const value = order && typeof order === 'object' ? order : {};
  const phase = String(value.refundProcessing && value.refundProcessing.phase || '');
  const reservation = String(value.refundReservationState || '');
  return String(value.status || '') === 'refund_requested'
    || PENDING_REFUND_PHASES.has(phase)
    || PENDING_REFUND_PHASES.has(reservation);
}

function refundWindowIsOpen(order, nowMs = Date.now()) {
  const value = order && typeof order === 'object' ? order : {};
  const explicitEnd = finiteTimestampMs(value.refundWindowEndsAt);
  if (explicitEnd > 0) return Number(nowMs) <= explicitEnd;
  const start = finiteTimestampMs(
    value.refundWindowStartsAt
    || value.serviceAvailableAt
    || value.providerApprovedAt
    || value.approvedAt
    || value.createdAt
    || value.requestedAt
  );
  if (!start) return false;
  const days = Math.max(1, Math.floor(Number(value.refundWindowDaysAtPurchase) || REFUND_WINDOW_DAYS_FALLBACK));
  return Number(nowMs) <= start + days * 24 * 60 * 60 * 1000;
}

function refundableOrderBlocksDeletion(order, nowMs = Date.now()) {
  const value = order && typeof order === 'object' ? order : {};
  const status = String(value.status || '');
  if (status === 'partially_refunded') return 'partial_refund_unsettled';
  if (['paid', 'refund_rejected'].includes(status) && refundWindowIsOpen(value, nowMs)) {
    return 'refundable_order_open';
  }
  return '';
}

function transformIsActive(job) {
  const value = job && typeof job === 'object' ? job : {};
  return ACTIVE_TRANSFORM_STATUSES.has(String(value.status || ''))
    || String(value.refine && value.refine.status || '') === 'running';
}

function accountDeletionPendingReasons({
  user,
  paymentIntents = [],
  orders = [],
  subscriptionOrders = [],
  transformJobs = [],
  referralVestings = [],
  nowMs = Date.now()
} = {}) {
  const reasons = new Set();
  if (activeSubscription(user, nowMs)) reasons.add('active_subscription');
  if (paymentIntents.some(row => PENDING_PAYMENT_INTENT_STATUSES.has(String(row && row.status || '')))) {
    reasons.add('payment_confirmation_pending');
  }
  if ([...orders, ...subscriptionOrders].some(refundIsPending)) reasons.add('refund_pending');
  for (const order of [...orders, ...subscriptionOrders]) {
    const reason = refundableOrderBlocksDeletion(order, nowMs);
    if (reason) reasons.add(reason);
  }
  if (transformJobs.some(transformIsActive)) reasons.add('transform_job_active');
  if (referralVestings.some(row => String(row && row.status || '') === 'locked')) {
    reasons.add('referral_reward_pending');
  }
  return [...reasons];
}

module.exports = {
  DEFAULT_RECENT_AUTH_SECONDS,
  ACTIVE_TRANSFORM_STATUSES,
  PENDING_PAYMENT_INTENT_STATUSES,
  PENDING_REFUND_PHASES,
  finiteTimestampMs,
  recentAuthMaxAgeSeconds,
  assertRecentAuth,
  activeSubscription,
  refundIsPending,
  refundWindowIsOpen,
  refundableOrderBlocksDeletion,
  transformIsActive,
  accountDeletionPendingReasons
};
