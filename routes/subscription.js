// [정기결제] 토스페이먼츠 빌링키 발급 + 매달 자동결제 + 쿠폰 부여 처리

const express = require('express');
const crypto = require('crypto');
const { admin, db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { authLogFields, verifyCronRequest } = require('../lib/cronAuth');
const discord = require('../lib/discord');
const metaConversions = require('../lib/metaConversions');
const { outboundFetch } = require('../lib/outboundPolicy');
const { realClientIp } = require('../lib/clientip');
const { bearerToken } = require('../lib/reqtoken');
const {
  paymentKeyHash,
  providerResultSummary,
  webhookPaymentValidation
} = require('../lib/paymentReconciliation');
const {
  classifyCreditCancellationResult,
  isTerminalWebhookInboxStatus,
  reconcileCreditPaymentCancellation,
  reconcilePendingCreditCancellationInboxes,
  safeProviderPaymentSnapshot
} = require('../lib/paymentCancellation');
const { reconcilePendingAccountDeletions } = require('../lib/accountDeletion');
const {
  GENERAL_WEBHOOK_LEASE_MS,
  GENERAL_WEBHOOK_MAX_FAILURES,
  compareGeneralWebhookPriority,
  isGeneralWebhookClaimable,
  nextAttemptNumber,
  nextFailureState,
  receiptCounterPatch,
  retryLaneFor,
  isCreditOrderId,
  subscriptionGenerationMatches,
  validProviderKey
} = require('../lib/tossWebhookState');
const {
  SUBSCRIPTION_REFUND_POLICY_VERSION,
  SUBSCRIPTION_REFUND_CALCULATION_BASIS,
  SUBSCRIPTION_REFUND_BONUS_TREATMENT,
  buildRefundPolicyPurchaseSnapshot
} = require('../lib/refundPolicySnapshot');

const router = express.Router();

// 상품 카탈로그 (서버 검증용 — 절대로 클라이언트 입력값을 신뢰하지 말 것)
// usesPerCycle === -1 또는 charLimit === -1 은 "제한 없음"
const SUB_PLANS = {
  '1000':      { amount: 11900,  usesPerCycle: 50, charLimit: 1000,  name: '베이직(1,000자 × 50회)' },
  '5000':      { amount: 54900,  usesPerCycle: 50, charLimit: 5000,  name: '스탠다드(5,000자 × 50회)' },
  '10000':     { amount: 99000,  usesPerCycle: 50, charLimit: 10000, name: '프로(10,000자 × 50회)' },
  'unlimited': { amount: 290000, usesPerCycle: -1, charLimit: -1,    name: '무제한' }
};

const CYCLE_DAYS = 30;
const CYCLE_MS = CYCLE_DAYS * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_CLAIM_LEASE_MS = Math.min(
  30 * 60 * 1000,
  Math.max(2 * 60 * 1000, Number(process.env.SUBSCRIPTION_CLAIM_LEASE_MS) || 10 * 60 * 1000)
);
const SUBSCRIPTION_OPERATION_CLAIMS = 'subscriptionOperationClaims';
const BILLING_ISSUE_UNKNOWN_RETRY_MS = 30 * 60 * 1000;
const BILLING_ISSUE_UNKNOWN_MAX_ATTEMPTS = 2;
const TOSS_WEBHOOK_VERIFY_TIMEOUT_MS = Math.min(
  9000,
  Math.max(1000, Number(process.env.TOSS_WEBHOOK_VERIFY_TIMEOUT_MS) || 7000)
);

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return Number(value.toDate()?.getTime()) || 0;
  if (Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function subscriptionError(code, message, status = 409, details = {}) {
  return Object.assign(new Error(message || code), { code, status, ...details });
}

function subscriptionGeneration(subscription) {
  const sub = subscription && typeof subscription === 'object' ? subscription : {};
  return {
    currentOrderId: String(sub.currentOrderId || ''),
    tier: String(sub.tier || ''),
    cycleStartedAtMs: timestampMillis(sub.cycleStartedAt || sub.lastBillingAt),
    nextBillingAtMs: timestampMillis(sub.nextBillingAt)
  };
}

function sameSubscriptionGeneration(subscription, expected, { requireStatus = null } = {}) {
  const sub = subscription && typeof subscription === 'object' ? subscription : {};
  const target = expected && typeof expected === 'object' ? expected : {};
  if (requireStatus && String(sub.status || '') !== requireStatus) return false;
  const current = subscriptionGeneration(sub);
  if (target.currentOrderId) return current.currentOrderId === String(target.currentOrderId);
  return Boolean(
    target.tier
    && current.tier === String(target.tier)
    && target.nextBillingAtMs > 0
    && current.nextBillingAtMs === Number(target.nextBillingAtMs)
    && (!target.cycleStartedAtMs || current.cycleStartedAtMs === Number(target.cycleStartedAtMs))
  );
}

function activeStartIntent(row) {
  return row?.operation === 'start'
    && ['claimed', 'billing_issuing', 'billing_issued', 'charging', 'charge_unknown', 'charged']
    .includes(String(row?.status || ''));
}

function activeSubscriptionOperation(row) {
  const operation = String(row?.operation || '');
  const status = String(row?.status || '');
  if (operation === 'start') return activeStartIntent(row);
  if (operation === 'renewal') return ['charging', 'charged'].includes(status);
  if (operation === 'expiry') return status === 'deleting';
  return false;
}

function accountDeletionBlocksSubscription(row, nowMs = Date.now()) {
  const status = String(row?.status || '');
  if (['processing', 'retry_pending', 'manual_review'].includes(status)) return true;
  const protectUntilMs = timestampMillis(row?.protectUntilMs) || Number(row?.protectUntilMs || 0);
  return status === 'completed' && protectUntilMs > nowMs;
}

function assertAccountDeletionNotBlocking(snapshot, nowMs = Date.now()) {
  if (snapshot?.exists && accountDeletionBlocksSubscription(snapshot.data() || {}, nowMs)) {
    throw subscriptionError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      '회원 탈퇴 처리가 진행 중이라 구독 결제를 시작할 수 없습니다.',
      409
    );
  }
}

function startIntentIdentityMatches(row, { tier, customerKey, authKeyHash }) {
  return String(row?.tier || '') === String(tier || '')
    && String(row?.customerKey || '') === String(customerKey || '')
    && String(row?.authKeyHash || '') === String(authKeyHash || '');
}

function subscriptionBlocksNewStart(subscription, nowMs = Date.now()) {
  const sub = subscription && typeof subscription === 'object' ? subscription : null;
  if (!sub) return false;
  if (sub.status === 'active') return true;
  return sub.status === 'cancelled' && timestampMillis(sub.nextBillingAt) > nowMs;
}

function startIntentRef(uid) {
  return db.collection(SUBSCRIPTION_OPERATION_CLAIMS).doc(uid);
}

function renewalClaimRef(uid) {
  return db.collection(SUBSCRIPTION_OPERATION_CLAIMS).doc(uid);
}

function expiryClaimRef(uid) {
  return db.collection(SUBSCRIPTION_OPERATION_CLAIMS).doc(uid);
}

function accountDeletionJobRef(uid) {
  return db.collection('accountDeletionJobs').doc(uid);
}

function authKeyDigest(authKey) {
  return crypto.createHash('sha256').update(String(authKey || '')).digest('hex');
}

function claimTimestamp(ms) {
  return admin.firestore.Timestamp.fromMillis(ms);
}

// 토스 빌링 API 헬퍼
function tossBasicToken() {
  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) throw new Error('TOSS_SECRET_KEY_MISSING');
  return Buffer.from(secretKey + ':').toString('base64');
}

function requireCronSecret(req, res) {
  const auth = verifyCronRequest(req, { allowBearer: true, allowBody: true, allowQuery: false });
  if (auth.reason === 'secret_missing') {
    logger.error('subscription.cron_secret_missing');
    res.status(503).json({ error: 'cron disabled: CRON_SECRET is not configured' });
    return null;
  }
  if (!auth.ok) {
    // A rejected public request is a security observation, not proof that the
    // real scheduler stopped.  The successful-run heartbeat is the SEV1
    // source of truth for an actual cron outage.
    logger.warn('subscription.cron_auth_rejected', authLogFields(auth));
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  if (auth.legacyCredentialPresent) {
    logger.warn('subscription.cron_legacy_auth_observed', { ...authLogFields(auth), noAlert: true });
  }
  return auth.secret;
}

async function tossIssueBillingKey({ authKey, customerKey }) {
  const res = await outboundFetch('toss', 'https://api.tosspayments.com/v1/billing/authorizations/issue', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${tossBasicToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey, customerKey })
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function tossChargeBilling({ billingKey, customerKey, amount, orderId, orderName, customerEmail, customerName, idempotencyKey }) {
  const headers = { 'Authorization': `Basic ${tossBasicToken()}`, 'Content-Type': 'application/json' };
  // ★ C-04: 같은 결제주기 재시도·다중 워커 동시 호출이 카드를 두 번 긁지 않도록 Idempotency-Key 전송.
  //   Toss는 동일 키에 대해 15일간 같은 응답을 반환한다(중복 승인 방지).
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);
  const res = await outboundFetch('toss', `https://api.tosspayments.com/v1/billing/${encodeURIComponent(billingKey)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ customerKey, amount, orderId, orderName, customerEmail, customerName })
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function tossDeleteBillingKey(billingKey) {
  try {
    const res = await outboundFetch('toss', `https://api.tosspayments.com/v1/billing/${encodeURIComponent(billingKey)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Basic ${tossBasicToken()}` }
    });
    // 404 means the provider already removed the key; that is an idempotent success.
    return res.ok || res.status === 404;
  } catch { return false; }
}

async function tossQueryPayment(paymentKey) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(Object.assign(new Error('TOSS_WEBHOOK_VERIFY_TIMEOUT'), { code: 'TOSS_WEBHOOK_VERIFY_TIMEOUT' })),
    TOSS_WEBHOOK_VERIFY_TIMEOUT_MS
  );
  try {
    const res = await outboundFetch('toss', `https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${tossBasicToken()}` },
      signal: controller.signal
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: {}, error };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTossWebhookEvent(eventType, reportedData) {
  const data = reportedData && typeof reportedData === 'object' ? reportedData : {};
  if (eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'CANCEL_STATUS_CHANGED') {
    if (!validProviderKey(data.paymentKey)) return { ok: false, reason: 'payment_key_invalid' };
    const queried = await tossQueryPayment(data.paymentKey);
    if (!queried.ok) {
      throw Object.assign(new Error('TOSS_WEBHOOK_PAYMENT_QUERY_FAILED'), {
        providerStatus: queried.status,
        provider: providerResultSummary(queried.data),
        cause: queried.error
      });
    }
    const validation = webhookPaymentValidation(queried.data, data);
    if (!validation.ok) return { ok: false, reason: validation.reasons.join(',') };
    return {
      ok: true,
      data: {
        ...queried.data,
        cancelStatus: typeof data.cancelStatus === 'string' ? data.cancelStatus : null
      }
    };
  }

  if (eventType === 'BILLING_DELETED') {
    if (!validProviderKey(data.billingKey)) return { ok: false, reason: 'billing_key_invalid' };
    const secretSnapshot = await db.collection('billingSecrets')
      .where('billingKey', '==', data.billingKey)
      .limit(1)
      .get();
    if (secretSnapshot.empty) return { ok: false, reason: 'billing_key_unknown' };
    return {
      ok: true,
      data,
      billingUid: secretSnapshot.docs[0].id,
      billingKeyHash: paymentKeyHash(data.billingKey)
    };
  }

  return { ok: false, reason: 'unsupported_event_type' };
}

async function processVerifiedTossWebhook({
  eventType,
  data,
  billingUid = '',
  billingKeyDigest = '',
  paymentKeyDigest = '',
  inboxId = '',
  source = 'live'
}) {
  if (eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'CANCEL_STATUS_CHANGED') {
    const { orderId, status } = data || {};
    if (!orderId) return { skipped: 'order_id_missing' };
    if (isCreditOrderId(orderId)) {
      const reconciled = await reconcileCreditPaymentCancellation(data, {
        source: source === 'live' ? `toss_${String(eventType).toLowerCase()}` : 'webhook_inbox_general_retry'
      });
      return { creditCancellation: reconciled };
    }
    if (eventType !== 'PAYMENT_STATUS_CHANGED') {
      const logId = inboxId || crypto.createHash('sha256')
        .update(JSON.stringify({ eventType, orderId, status, cancelStatus: data?.cancelStatus || null }))
        .digest('hex');
      await db.collection('webhookLogs').doc(logId).set({
        eventType,
        paymentKeyHash: paymentKeyDigest || null,
        paymentKeyPresent: Boolean(paymentKeyDigest),
        orderId,
        providerStatus: status || null,
        cancelStatus: data?.cancelStatus || null,
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { logged: true };
    }
    const orderRef = db.collection('subscriptionOrders').doc(orderId);
    const closingStatus = ['CANCELED', 'ABORTED', 'EXPIRED'].includes(String(status || ''));
    const processed = await db.runTransaction(async transaction => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists) {
        if (/^sub_[A-Za-z0-9_-]+_\d{10,}$/.test(String(orderId))) {
          throw Object.assign(new Error('SUBSCRIPTION_ORDER_NOT_READY'), { code: 'SUBSCRIPTION_ORDER_NOT_READY' });
        }
        return { skipped: 'subscription_order_missing' };
      }
      const order = orderSnapshot.data() || {};
      const userRef = order.uid ? db.collection('users').doc(order.uid) : null;
      const operationClaimRef = order.uid
        ? db.collection(SUBSCRIPTION_OPERATION_CLAIMS).doc(order.uid)
        : null;
      const [userSnapshot, operationClaimSnapshot] = closingStatus && userRef
        ? await Promise.all([
          transaction.get(userRef),
          transaction.get(operationClaimRef)
        ])
        : [null, null];
      const generationMatches = Boolean(
        closingStatus
        && userSnapshot?.exists
        && subscriptionGenerationMatches({
          subscription: userSnapshot.data()?.subscription,
          order,
          orderId
        })
      );

      transaction.update(orderRef, {
        webhookStatus: status,
        webhookPaymentKeyPresent: Boolean(paymentKeyDigest),
        webhookUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      if (generationMatches) {
        transaction.update(userRef, {
          'subscription.status': 'refunded',
          'plan': 'free'
        });
      }
      const operationClaim = operationClaimSnapshot?.exists
        ? operationClaimSnapshot.data() || {}
        : null;
      const renewalClaimClosed = Boolean(
        closingStatus
        && operationClaim?.operation === 'renewal'
        && String(operationClaim.orderId || '') === String(orderId)
        && ['charging', 'charged'].includes(String(operationClaim.status || ''))
      );
      if (renewalClaimClosed) {
        transaction.set(operationClaimRef, {
          status: 'canceled',
          paymentKey: null,
          billingKey: null,
          leaseUntil: null,
          closedByWebhookOrderId: orderId,
          closedByWebhookStatus: status || null,
          updatedAt: claimTimestamp(Date.now())
        }, { merge: true });
      }
      return {
        subscriptionUpdated: true,
        subscriptionClosed: generationMatches,
        staleGeneration: closingStatus && !generationMatches,
        uid: order.uid || null,
        renewalClaimClosed
      };
    });
    if (processed.subscriptionClosed) {
      logger.warn('toss.webhook_subscription_closed', {
        eventType,
        orderId,
        uid: processed.uid,
        status
      });
    } else if (processed.staleGeneration) {
      logger.warn('toss.webhook_subscription_stale_generation_ignored', {
        eventType,
        orderId,
        uid: processed.uid,
        status
      });
    }
    return processed;
  }

  if (eventType === 'BILLING_DELETED') {
    if (!billingUid) throw Object.assign(new Error('BILLING_UID_MISSING'), { code: 'BILLING_UID_MISSING' });
    if (!billingKeyDigest) throw Object.assign(new Error('BILLING_KEY_DIGEST_MISSING'), { code: 'BILLING_KEY_DIGEST_MISSING' });
    const targetRef = db.collection('users').doc(billingUid);
    const secretRef = db.collection('billingSecrets').doc(billingUid);
    const result = await db.runTransaction(async transaction => {
      const [secretSnapshot, userSnapshot] = await Promise.all([
        transaction.get(secretRef),
        transaction.get(targetRef)
      ]);
      if (!secretSnapshot.exists) return { billingDeleted: true, alreadyMissing: true };
      const currentBillingKey = secretSnapshot.data()?.billingKey;
      if (!validProviderKey(currentBillingKey) || paymentKeyHash(currentBillingKey) !== billingKeyDigest) {
        return { billingDeleted: false, staleGeneration: true };
      }
      transaction.delete(secretRef);
      if (userSnapshot.exists) {
        transaction.update(targetRef, {
          'subscription.status': 'cancelled',
          'subscription.billingKey': null,
          'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
          'subscription.billingKeyDeleted': true
        });
      }
      return { billingDeleted: true, userMissing: !userSnapshot.exists };
    });
    if (result.staleGeneration) {
      logger.warn('toss.webhook_billing_deleted_stale_generation_ignored', { uid: targetRef.id });
    } else {
      logger.warn('toss.webhook_billing_deleted', { uid: targetRef.id, alreadyMissing: !!result.alreadyMissing });
    }
    return result;
  }
  return { skipped: 'unsupported_event_type' };
}

function timestampFromMillis(value) {
  return admin.firestore.Timestamp.fromMillis(value);
}

async function claimGeneralWebhookDoc(doc, nowMs = Date.now()) {
  const leaseToken = crypto.randomUUID();
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(doc.ref);
    if (!snapshot.exists) return null;
    const row = snapshot.data() || {};
    if (!isGeneralWebhookClaimable(row, nowMs)) return null;
    const attempt = nextAttemptNumber(row);
    if (attempt > GENERAL_WEBHOOK_MAX_FAILURES) {
      transaction.update(doc.ref, nextFailureState(
        { ...row, retryAttempts: attempt - 1 },
        timestampFromMillis(nowMs),
        row.errorCode || 'WEBHOOK_RETRY_EXHAUSTED'
      ));
      return { row, manualReview: true };
    }
    transaction.update(doc.ref, {
      status: 'processing',
      generalWebhookCandidate: true,
      retryAttempts: attempt,
      leaseToken,
      leaseUntil: timestampFromMillis(nowMs + GENERAL_WEBHOOK_LEASE_MS),
      lastAttemptAt: timestampFromMillis(nowMs)
    });
    return { row, leaseToken };
  });
}

async function completeGeneralWebhookClaim(doc, leaseToken, nowMs = Date.now()) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(doc.ref);
    if (!snapshot.exists || snapshot.data()?.leaseToken !== leaseToken) return false;
    transaction.update(doc.ref, {
      status: 'processed',
      generalWebhookCandidate: false,
      processedAt: timestampFromMillis(nowMs),
      leaseToken: null,
      leaseUntil: null,
      errorCode: null
    });
    return true;
  });
}

async function failGeneralWebhookClaim(doc, leaseToken, error, nowMs = Date.now()) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(doc.ref);
    if (!snapshot.exists || snapshot.data()?.leaseToken !== leaseToken) return null;
    const transition = nextFailureState(
      snapshot.data() || {},
      timestampFromMillis(nowMs),
      error?.code || 'WEBHOOK_RETRY_FAILED'
    );
    transaction.update(doc.ref, transition);
    return transition;
  });
}

async function reconcilePendingGeneralWebhookInboxes({ limit = 25 } = {}) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const sampleLimit = Math.min(500, Math.max(100, boundedLimit * 8));
  const snapshot = await db.collection('webhookInbox')
    .where('generalWebhookCandidate', '==', true)
    .limit(sampleLimit)
    .get();
  const candidates = [...snapshot.docs];

  // One-release compatibility for inbox rows created before retryLane and
  // generalWebhookCandidate existed. New rows never depend on this mixed lane.
  if (candidates.length < boundedLimit) {
    const legacySnapshot = await db.collection('webhookInbox')
      .where('status', 'in', ['received', 'error'])
      .limit(sampleLimit)
      .get();
    const seen = new Set(candidates.map(doc => doc.id));
    for (const doc of legacySnapshot.docs) {
      if (!seen.has(doc.id) && doc.data()?.creditCancellationCandidate !== true) {
        candidates.push(doc);
        seen.add(doc.id);
      }
    }
  }

  const nowMs = Date.now();
  const docs = candidates
    .filter(doc => isGeneralWebhookClaimable(doc.data() || {}, nowMs))
    .sort(compareGeneralWebhookPriority)
    .slice(0, boundedLimit);
  const result = { scanned: docs.length, processed: 0, failed: 0, manualReview: 0 };
  for (const doc of docs) {
    const claim = await claimGeneralWebhookDoc(doc, nowMs);
    if (!claim) continue;
    if (claim.manualReview) {
      result.manualReview++;
      logger.error('toss.webhook_manual_review_required', {
        inboxId: doc.id,
        eventType: claim.row.eventType,
        orderId: claim.row.orderId
      });
      continue;
    }
    const { row, leaseToken } = claim;
    try {
      await processVerifiedTossWebhook({
        eventType: row.eventType,
        data: row.providerPayment || {},
        billingUid: row.billingUid || '',
        billingKeyDigest: row.billingKeyHash || '',
        paymentKeyDigest: row.paymentKeyHash || '',
        inboxId: doc.id,
        source: 'retry'
      });
      if (await completeGeneralWebhookClaim(doc, leaseToken)) result.processed++;
    } catch (error) {
      const transition = await failGeneralWebhookClaim(doc, leaseToken, error);
      if (transition?.status === 'manual_review') result.manualReview++;
      else if (transition) result.failed++;
      logger.error('toss.webhook_retry_failed', { inboxId: doc.id, eventType: row.eventType, orderId: row.orderId, err: error });
    }
  }
  return result;
}

// ★ C-03: 결제 비밀(billingKey)은 서버 전용 billingSecrets/{uid}에서 읽는다.
//   customerKey는 cust_${uid}로 결정적이라 계산. billingSecrets가 없는 미마이그레이션 사용자는 fallback(sub.billingKey).
function customerKeyFor(uid) { return `cust_${uid}`; }
async function readBillingKey(uid, fallback) {
  try {
    const s = await db.collection('billingSecrets').doc(uid).get();
    if (s.exists && s.data().billingKey) return s.data().billingKey;
  } catch (e) { logger.warn('billing.secret_read_failed', { uid, err: e }); }
  return fallback || null;
}

async function acquireSubscriptionStartClaim({ uid, tier, customerKey, authKeyHash, nowMs = Date.now() }) {
  const userRef = db.collection('users').doc(uid);
  const claimRef = startIntentRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  const nextToken = crypto.randomUUID();
  const nextOrderId = buildOrderId(uid, nowMs);
  return db.runTransaction(async transaction => {
    const [userSnapshot, claimSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    if (!userSnapshot.exists) {
      throw subscriptionError(
        'USER_NOT_FOUND',
        '사용자 계정 초기화가 완료되지 않았습니다. 다시 로그인한 뒤 시도해주세요.',
        404
      );
    }
    const user = userSnapshot.data() || {};
    const subscription = user.subscription || null;
    const existing = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;

    if (subscriptionBlocksNewStart(subscription, nowMs)) {
      if (existing?.operation === 'start' && existing?.status === 'applied'
        && subscription?.currentOrderId === existing.orderId) {
        return { alreadyApplied: true, ref: claimRef, row: existing };
      }
      throw subscriptionError('SUBSCRIPTION_ALREADY_ACTIVE', '이미 진행 중인 구독이 있습니다. 마이페이지에서 관리해주세요.', 400);
    }

    if (activeSubscriptionOperation(existing) && existing.operation !== 'start') {
      throw subscriptionError(
        existing.operation === 'expiry' ? 'SUBSCRIPTION_EXPIRY_IN_PROGRESS' : 'SUBSCRIPTION_RENEWAL_IN_PROGRESS',
        '이전 구독 처리가 진행 중입니다. 잠시 후 다시 시도해주세요.',
        409
      );
    }

    if (existing?.operation === 'start' && existing?.status === 'billing_issuing') {
      const leaseUntilMs = timestampMillis(existing.leaseUntil);
      if (leaseUntilMs > nowMs) {
        throw subscriptionError(
          'SUBSCRIPTION_START_IN_PROGRESS',
          '구독 결제를 처리하고 있습니다. 잠시 후 다시 확인해주세요.'
        );
      }
      const unknownAttempts = Math.max(1, Math.floor(Number(existing.billingIssueUnknownAttempts) || 0));
      const retryAfterMs = Number(existing.billingIssueRetryAfterMs)
        || (timestampMillis(existing.updatedAt) + BILLING_ISSUE_UNKNOWN_RETRY_MS);
      if (retryAfterMs > nowMs) {
        throw subscriptionError(
          'SUBSCRIPTION_START_REVIEW_REQUIRED',
          '카드 등록 결과를 확인하고 있습니다. 잠시 후 다시 시도해주세요.',
          409
        );
      }
      if (unknownAttempts >= BILLING_ISSUE_UNKNOWN_MAX_ATTEMPTS) {
        const manual = {
          ...existing,
          status: 'manual_review',
          leaseUntil: null,
          billingKey: null,
          paymentKey: null,
          manualReviewReason: 'billing_issue_result_unknown_retry_exhausted',
          updatedAt: claimTimestamp(nowMs)
        };
        transaction.set(claimRef, manual);
        return { manualReview: true, ref: claimRef, row: manual };
      }
      const recovered = {
        operation: 'start',
        uid,
        tier,
        customerKey,
        authKeyHash,
        orderId: nextOrderId,
        claimToken: nextToken,
        status: 'claimed',
        billingIssueUnknownAttempts: unknownAttempts,
        recoveredFromOrderId: existing.orderId || null,
        leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS),
        createdAt: existing.createdAt || claimTimestamp(nowMs),
        updatedAt: claimTimestamp(nowMs)
      };
      transaction.set(claimRef, recovered);
      return { resumed: false, recoveredUnknownIssuance: true, ref: claimRef, row: recovered };
    }

    // Exhausted issuance claims stay quarantined until an operator resolves
    // them. A later browser retry must not silently overwrite the evidence and
    // start another provider issuance cycle.
    if (existing?.operation === 'start' && existing?.status === 'manual_review') {
      return { manualReview: true, ref: claimRef, row: existing };
    }

    if (activeStartIntent(existing)) {
      if (!startIntentIdentityMatches(existing, { tier, customerKey, authKeyHash })) {
        throw subscriptionError(
          'SUBSCRIPTION_START_IN_PROGRESS',
          '다른 구독 결제 처리가 진행 중입니다. 잠시 후 결제 내역을 확인해주세요.'
        );
      }
      if (existing.status === 'charged') {
        return { resumed: true, ref: claimRef, row: existing };
      }
      const leaseUntilMs = timestampMillis(existing.leaseUntil);
      if (leaseUntilMs > nowMs) {
        throw subscriptionError(
          'SUBSCRIPTION_START_IN_PROGRESS',
          '구독 결제를 처리하고 있습니다. 잠시 후 다시 확인해주세요.'
        );
      }
      const resumed = {
        ...existing,
        claimToken: nextToken,
        leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS),
        updatedAt: claimTimestamp(nowMs)
      };
      transaction.set(claimRef, resumed, { merge: true });
      return { resumed: true, ref: claimRef, row: resumed };
    }

    const row = {
      operation: 'start',
      uid,
      tier,
      customerKey,
      authKeyHash,
      orderId: nextOrderId,
      claimToken: nextToken,
      status: 'claimed',
      leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS),
      createdAt: claimTimestamp(nowMs),
      updatedAt: claimTimestamp(nowMs)
    };
    transaction.set(claimRef, row);
    return { resumed: false, ref: claimRef, row };
  });
}

async function transitionSubscriptionStartClaim({ uid, claimToken, from, status, fields = {}, nowMs = Date.now() }) {
  const intentRef = startIntentRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  const allowed = new Set(Array.isArray(from) ? from : [from]);
  return db.runTransaction(async transaction => {
    const [snapshot, deletionSnapshot] = await Promise.all([
      transaction.get(intentRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    if (!snapshot.exists) throw subscriptionError('SUBSCRIPTION_START_CLAIM_MISSING', '구독 결제 상태를 찾을 수 없습니다.', 409);
    const row = snapshot.data() || {};
    if (row.operation !== 'start' || row.claimToken !== claimToken || !allowed.has(row.status)) {
      throw subscriptionError('SUBSCRIPTION_START_CLAIM_STALE', '다른 구독 결제 처리가 먼저 진행됐습니다.', 409);
    }
    const patch = {
      ...fields,
      status,
      updatedAt: claimTimestamp(nowMs),
      leaseUntil: ['applied', 'failed', 'stale'].includes(status)
        ? null
        : claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS)
    };
    if (['applied', 'failed', 'stale'].includes(status)) {
      patch.billingKey = null;
      patch.paymentKey = null;
    }
    transaction.set(intentRef, patch, { merge: true });
    return { ...row, ...patch };
  });
}

async function markBillingIssueUnknown({ uid, claimToken, priorAttempts = 0, reason, nowMs = Date.now() }) {
  const attempts = Math.max(0, Math.floor(Number(priorAttempts) || 0)) + 1;
  return transitionSubscriptionStartClaim({
    uid,
    claimToken,
    from: 'billing_issuing',
    status: 'billing_issuing',
    nowMs,
    fields: {
      billingIssueUnknownAttempts: attempts,
      billingIssueUnknownReason: String(reason || 'provider_result_unknown').slice(0, 120),
      billingIssueUnknownAtMs: nowMs,
      billingIssueRetryAfterMs: nowMs + BILLING_ISSUE_UNKNOWN_RETRY_MS
    }
  });
}

async function acquireRenewalClaim({ uid, expectedGeneration, tier, orderId, nowMs = Date.now() }) {
  const userRef = db.collection('users').doc(uid);
  const orderRef = db.collection('subscriptionOrders').doc(orderId);
  const claimRef = renewalClaimRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  const nextToken = crypto.randomUUID();
  return db.runTransaction(async transaction => {
    const [userSnapshot, orderSnapshot, claimSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(orderRef),
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    if (!userSnapshot.exists) throw subscriptionError('USER_NOT_FOUND', 'user not found', 404);
    const subscription = userSnapshot.data()?.subscription;
    if (orderSnapshot.exists) {
      const order = orderSnapshot.data() || {};
      if (order.uid === uid && order.tier === tier && order.status === 'paid') {
        return { deduped: true, row: claimSnapshot.exists ? claimSnapshot.data() || {} : {}, ref: claimRef };
      }
      throw subscriptionError('SUBSCRIPTION_ORDER_CONFLICT', 'subscription order conflict', 409);
    }
    if (!sameSubscriptionGeneration(subscription, expectedGeneration, { requireStatus: 'active' })) {
      throw subscriptionError('SUBSCRIPTION_GENERATION_CHANGED', '구독 상태가 변경되어 갱신 결제를 중단했습니다.', 409);
    }
    const existing = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;
    if (activeSubscriptionOperation(existing) && existing.operation !== 'renewal') {
      throw subscriptionError('SUBSCRIPTION_OPERATION_IN_PROGRESS', '다른 구독 처리가 진행 중입니다.', 409);
    }
    const sameClaim = existing?.operation === 'renewal'
      && existing.uid === uid
      && existing.tier === tier
      && existing.orderId === orderId
      && sameSubscriptionGeneration(subscription, existing.generation || {}, { requireStatus: 'active' });
    if (sameClaim && existing.status === 'charged') {
      return { resumedCharged: true, row: existing, ref: claimRef };
    }
    if (existing?.operation === 'renewal' && ['charging', 'charged'].includes(existing.status)) {
      if (!sameClaim) {
        throw subscriptionError('SUBSCRIPTION_RENEWAL_CONFLICT', '다른 구독 갱신 처리가 진행 중입니다.', 409);
      }
      if (timestampMillis(existing.leaseUntil) > nowMs) {
        throw subscriptionError('SUBSCRIPTION_RENEWAL_IN_PROGRESS', '구독 갱신 결제가 진행 중입니다.', 409);
      }
    }
    const row = {
      operation: 'renewal',
      uid,
      tier,
      orderId,
      generation: expectedGeneration,
      claimToken: nextToken,
      status: 'charging',
      leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS),
      createdAt: sameClaim ? existing.createdAt : claimTimestamp(nowMs),
      updatedAt: claimTimestamp(nowMs)
    };
    transaction.set(claimRef, row);
    return { resumedCharged: false, row, ref: claimRef };
  });
}

async function markRenewalClaimCharged({ uid, orderId, claimToken, paymentKey, billingKey, nowMs = Date.now() }) {
  const claimRef = renewalClaimRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  return db.runTransaction(async transaction => {
    const [snapshot, deletionSnapshot] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    const row = snapshot.exists ? (snapshot.data() || {}) : null;
    if (!row || row.operation !== 'renewal' || row.orderId !== orderId
      || row.claimToken !== claimToken || row.status !== 'charging') {
      throw subscriptionError('SUBSCRIPTION_RENEWAL_CLAIM_STALE', '구독 갱신 상태가 변경됐습니다.', 409);
    }
    const patch = {
      status: 'charged',
      paymentKey,
      billingKey,
      chargedAt: claimTimestamp(nowMs),
      updatedAt: claimTimestamp(nowMs),
      leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS)
    };
    transaction.set(claimRef, patch, { merge: true });
    return { ...row, ...patch };
  });
}

async function finalizeRenewalFailure({ uid, orderId, claimToken, expectedGeneration, tier, amount, reason, nowMs = Date.now() }) {
  const userRef = db.collection('users').doc(uid);
  const claimRef = renewalClaimRef(uid);
  const orderRef = db.collection('subscriptionOrders').doc(orderId);
  const deletionRef = accountDeletionJobRef(uid);
  return db.runTransaction(async transaction => {
    const [userSnapshot, claimSnapshot, orderSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(claimRef),
      transaction.get(orderRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    const claim = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;
    if (!claim || claim.operation !== 'renewal' || claim.orderId !== orderId
      || claim.claimToken !== claimToken || !['charging', 'charged'].includes(claim.status)) {
      return { stale: true, userUpdated: false };
    }
    const subscription = userSnapshot.exists ? userSnapshot.data()?.subscription : null;
    const generationMatches = sameSubscriptionGeneration(subscription, expectedGeneration, { requireStatus: 'active' });
    transaction.set(claimRef, {
      status: 'failed',
      billingKey: null,
      paymentKey: null,
      failureReason: String(reason || 'unknown').slice(0, 160),
      failedAt: claimTimestamp(nowMs),
      updatedAt: claimTimestamp(nowMs),
      leaseUntil: null
    }, { merge: true });
    if (!orderSnapshot.exists) {
      transaction.set(orderRef, {
        uid,
        tier,
        amount,
        orderId,
        status: 'failed',
        requestedAt: claimTimestamp(nowMs),
        failReason: String(reason || 'unknown').slice(0, 300)
      });
    }
    if (generationMatches) {
      transaction.update(userRef, {
        'subscription.status': 'past_due',
        'subscription.failureReason': String(reason || 'unknown').slice(0, 160),
        plan: 'free'
      });
    }
    return { stale: !generationMatches, userUpdated: generationMatches };
  });
}

async function cancelCurrentSubscription(uid, nowMs = Date.now()) {
  const userRef = db.collection('users').doc(uid);
  const claimRef = renewalClaimRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  return db.runTransaction(async transaction => {
    const [userSnapshot, claimSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    const subscription = userSnapshot.exists ? userSnapshot.data()?.subscription : null;
    if (!subscription || subscription.status !== 'active') {
      throw subscriptionError('NO_ACTIVE_SUBSCRIPTION', '활성 구독이 없습니다.', 400);
    }
    const generation = subscriptionGeneration(subscription);
    const claim = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;
    if (claim?.operation === 'renewal' && ['charging', 'charged'].includes(claim.status)
      && sameSubscriptionGeneration(subscription, claim.generation || {}, { requireStatus: 'active' })) {
      throw subscriptionError(
        'SUBSCRIPTION_RENEWAL_IN_PROGRESS',
        '구독 갱신 결제가 진행 중이라 지금은 해지할 수 없습니다. 잠시 후 다시 시도해주세요.',
        409
      );
    }
    transaction.update(userRef, {
      'subscription.status': 'cancelled',
      'subscription.cancelledAt': claimTimestamp(nowMs)
    });
    return { tier: subscription.tier, generation };
  });
}

async function resumeCurrentSubscription(uid, nowMs = Date.now()) {
  const userRef = db.collection('users').doc(uid);
  const claimRef = expiryClaimRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  return db.runTransaction(async transaction => {
    const [userSnapshot, claimSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    const subscription = userSnapshot.exists ? userSnapshot.data()?.subscription : null;
    if (!subscription || subscription.status !== 'cancelled') {
      throw subscriptionError('NO_CANCELLED_SUBSCRIPTION', '취소된 구독이 없습니다.', 400);
    }
    if (timestampMillis(subscription.nextBillingAt) <= nowMs) {
      throw subscriptionError('SUBSCRIPTION_ALREADY_EXPIRED', '이미 만료된 구독입니다. 다시 구독해주세요.', 400);
    }
    const claim = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;
    if (claim?.operation === 'expiry' && claim.status === 'deleting'
      && sameSubscriptionGeneration(subscription, claim.generation || {}, { requireStatus: 'cancelled' })) {
      throw subscriptionError('SUBSCRIPTION_EXPIRY_IN_PROGRESS', '구독 만료 처리가 진행 중입니다.', 409);
    }
    transaction.update(userRef, {
      'subscription.status': 'active',
      'subscription.cancelledAt': null
    });
    return { tier: subscription.tier };
  });
}

async function acquireExpiryClaim({ uid, nowMs = Date.now() }) {
  const userRef = db.collection('users').doc(uid);
  const secretRef = db.collection('billingSecrets').doc(uid);
  const claimRef = expiryClaimRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  const nextToken = crypto.randomUUID();
  return db.runTransaction(async transaction => {
    const [userSnapshot, secretSnapshot, claimSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(secretRef),
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    if (!userSnapshot.exists) return { skipped: 'user_missing' };
    const subscription = userSnapshot.data()?.subscription;
    const generation = subscriptionGeneration(subscription);
    if (!subscription || subscription.status !== 'cancelled' || generation.nextBillingAtMs > nowMs) {
      return { skipped: 'generation_changed' };
    }
    const existing = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;
    if (activeSubscriptionOperation(existing) && existing.operation !== 'expiry') {
      return { skipped: `${existing.operation}_in_progress` };
    }
    if (existing?.operation === 'expiry' && existing.status === 'deleting'
      && sameSubscriptionGeneration(subscription, existing.generation || {}, { requireStatus: 'cancelled' })
      && timestampMillis(existing.leaseUntil) > nowMs) {
      return { skipped: 'expiry_in_progress' };
    }
    const billingKey = secretSnapshot.exists
      ? String(secretSnapshot.data()?.billingKey || '')
      : String(subscription.billingKey || '');
    const row = {
      operation: 'expiry',
      uid,
      generation,
      claimToken: nextToken,
      status: 'deleting',
      billingKey,
      billingKeyHash: billingKey ? paymentKeyHash(billingKey) : '',
      leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS),
      createdAt: existing?.operation === 'expiry' ? existing.createdAt : claimTimestamp(nowMs),
      updatedAt: claimTimestamp(nowMs)
    };
    transaction.set(claimRef, row);
    return { skipped: null, row, ref: claimRef };
  });
}

async function finalizeExpiryClaim({ uid, claimToken, nowMs = Date.now() }) {
  const userRef = db.collection('users').doc(uid);
  const secretRef = db.collection('billingSecrets').doc(uid);
  const claimRef = expiryClaimRef(uid);
  const deletionRef = accountDeletionJobRef(uid);
  return db.runTransaction(async transaction => {
    const [userSnapshot, secretSnapshot, claimSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(secretRef),
      transaction.get(claimRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    const claim = claimSnapshot.exists ? (claimSnapshot.data() || {}) : null;
    if (!claim || claim.operation !== 'expiry' || claim.claimToken !== claimToken || claim.status !== 'deleting') {
      return { stale: true };
    }
    const subscription = userSnapshot.exists ? userSnapshot.data()?.subscription : null;
    const secretKey = secretSnapshot.exists ? String(secretSnapshot.data()?.billingKey || '') : '';
    const secretMatches = !secretKey || paymentKeyHash(secretKey) === String(claim.billingKeyHash || '');
    if (!userSnapshot.exists
      || !sameSubscriptionGeneration(subscription, claim.generation || {}, { requireStatus: 'cancelled' })
      || !secretMatches) {
      transaction.set(claimRef, {
        status: 'stale',
        billingKey: null,
        staleAt: claimTimestamp(nowMs),
        leaseUntil: null,
        updatedAt: claimTimestamp(nowMs)
      }, { merge: true });
      return { stale: true };
    }
    transaction.update(userRef, {
      'subscription.status': 'expired',
      'subscription.billingKey': null,
      plan: 'free',
      'coupon.remaining': 0
    });
    if (secretSnapshot.exists) transaction.delete(secretRef);
    transaction.set(claimRef, {
      status: 'expired',
      billingKey: null,
      expiredAt: claimTimestamp(nowMs),
      leaseUntil: null,
      updatedAt: claimTimestamp(nowMs)
    }, { merge: true });
    return { stale: false, expired: true };
  });
}

async function claimChargedStartForRecovery(uid, nowMs = Date.now()) {
  const claimRef = startIntentRef(uid);
  const userRef = db.collection('users').doc(uid);
  const deletionRef = accountDeletionJobRef(uid);
  const nextToken = crypto.randomUUID();
  return db.runTransaction(async transaction => {
    const [claimSnapshot, userSnapshot, deletionSnapshot] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(userRef),
      transaction.get(deletionRef)
    ]);
    assertAccountDeletionNotBlocking(deletionSnapshot, nowMs);
    if (!claimSnapshot.exists) return { skipped: 'claim_missing' };
    const claim = claimSnapshot.data() || {};
    if (claim.operation !== 'start' || claim.status !== 'charged' || claim.uid !== uid) {
      return { skipped: 'claim_changed' };
    }
    if (!userSnapshot.exists) return { skipped: 'user_missing' };
    if (timestampMillis(claim.leaseUntil) > nowMs) return { skipped: 'live_lease' };
    const plan = SUB_PLANS[claim.tier];
    if (!plan
      || claim.customerKey !== customerKeyFor(uid)
      || !validProviderKey(claim.billingKey)
      || !validProviderKey(claim.paymentKey)
      || !claim.orderId) {
      return { skipped: 'claim_invalid' };
    }
    const subscription = userSnapshot.data()?.subscription;
    if (subscriptionBlocksNewStart(subscription, nowMs)) {
      return { skipped: 'subscription_generation_changed' };
    }
    const patch = {
      claimToken: nextToken,
      leaseUntil: claimTimestamp(nowMs + SUBSCRIPTION_CLAIM_LEASE_MS),
      recoveryAttempts: Math.max(0, Number(claim.recoveryAttempts) || 0) + 1,
      lastRecoveryAt: claimTimestamp(nowMs),
      updatedAt: claimTimestamp(nowMs)
    };
    transaction.set(claimRef, patch, { merge: true });
    return { skipped: null, row: { ...claim, ...patch }, plan };
  });
}

async function reconcileChargedSubscriptionStarts({ limit = 20, nowMs = Date.now() } = {}) {
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  // Query one indexed field and filter the operation in memory to avoid a new
  // composite-index deployment dependency during emergency recovery.
  const snapshot = await db.collection(SUBSCRIPTION_OPERATION_CLAIMS)
    .where('status', '==', 'charged')
    .limit(Math.min(200, boundedLimit * 4))
    .get();
  const docs = snapshot.docs
    .filter(doc => doc.data()?.operation === 'start')
    .slice(0, boundedLimit);
  const result = { scanned: docs.length, recovered: 0, skipped: 0, failed: 0 };
  for (const doc of docs) {
    let claimed;
    try {
      claimed = await claimChargedStartForRecovery(doc.id, nowMs);
    } catch (error) {
      result.failed++;
      logger.error('subscription.start_recovery_claim_failed', { uid: doc.id, code: error.code, err: error });
      continue;
    }
    if (claimed.skipped) {
      result.skipped++;
      continue;
    }
    const row = claimed.row;
    try {
      await applySubscriptionCycle({
        uid: doc.id,
        tier: row.tier,
        plan: claimed.plan,
        paymentResult: { paymentKey: row.paymentKey, orderId: row.orderId },
        billingKey: row.billingKey,
        cardCompany: row.cardCompany,
        cardNumber: row.cardNumber,
        customerKey: row.customerKey,
        isFirst: false,
        startClaim: { claimToken: row.claimToken }
      });
      result.recovered++;
      logger.info('subscription.start_recovered', { uid: doc.id, tier: row.tier, orderId: row.orderId });
    } catch (error) {
      result.failed++;
      logger.error('subscription.start_recovery_apply_failed', {
        uid: doc.id,
        tier: row.tier,
        orderId: row.orderId,
        code: error.code,
        err: error
      });
    }
  }
  return result;
}

async function verifyToken(idToken) {
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken, true);
    return decoded.uid;
  } catch { return null; }
}

function buildOrderId(uid, ts) { return `sub_${uid}_${ts}`; }

// 구독 + 쿠폰 + 주문 + 히스토리를 atomic하게 기록하는 헬퍼
async function applySubscriptionCycle({
  uid,
  tier,
  plan,
  paymentResult,
  billingKey,
  cardCompany,
  cardNumber,
  customerKey,
  isFirst,
  startClaim = null,
  renewalClaim = null,
  expectedGeneration = null
}) {
  const now = Date.now();
  const cycleStartedAt = admin.firestore.Timestamp.fromMillis(now);
  const nextBillingAt = admin.firestore.Timestamp.fromMillis(now + CYCLE_MS);
  const orderId = paymentResult.orderId;
  const userRef = db.collection('users').doc(uid);
  const orderRef = db.collection('subscriptionOrders').doc(orderId);
  const deletionRef = accountDeletionJobRef(uid);
  const operationClaim = startClaim ? { operation: 'start', ...startClaim }
    : (renewalClaim ? { operation: 'renewal', ...renewalClaim } : null);
  const claimRef = operationClaim ? startIntentRef(uid) : null;
  const usesPerCycle = plan.usesPerCycle;
  const refundPolicyPurchaseSnapshot = buildRefundPolicyPurchaseSnapshot(
    now,
    SUBSCRIPTION_REFUND_POLICY_VERSION,
    {
      calculationBasis: SUBSCRIPTION_REFUND_CALCULATION_BASIS,
      bonusTreatment: SUBSCRIPTION_REFUND_BONUS_TREATMENT
    }
  );

  return db.runTransaction(async (t) => {
    const [orderSnap, userSnap, deletionSnap, claimSnap] = await Promise.all([
      t.get(orderRef),
      t.get(userRef),
      t.get(deletionRef),
      claimRef ? t.get(claimRef) : Promise.resolve(null)
    ]);
    assertAccountDeletionNotBlocking(deletionSnap, now);
    if (!userSnap.exists) {
      throw subscriptionError(
        'USER_NOT_FOUND',
        '사용자 계정 초기화가 완료되지 않았습니다. 다시 로그인한 뒤 시도해주세요.',
        404
      );
    }
    const currentSubscription = userSnap.data()?.subscription;
    const claim = claimSnap?.exists ? (claimSnap.data() || {}) : null;

    if (operationClaim) {
      const claimMatches = claim
        && claim.operation === operationClaim.operation
        && claim.uid === uid
        && claim.tier === tier
        && claim.orderId === orderId
        && claim.claimToken === operationClaim.claimToken;
      if (!claimMatches || !['charged', 'applied'].includes(claim.status)) {
        throw subscriptionError('SUBSCRIPTION_OPERATION_CLAIM_STALE', '구독 결제 상태가 변경됐습니다.', 409);
      }
      if (operationClaim.operation === 'start') {
        if (claim.customerKey !== customerKey || claim.billingKey !== billingKey
          || claim.paymentKey !== paymentResult.paymentKey) {
          throw subscriptionError('SUBSCRIPTION_START_RESULT_MISMATCH', '구독 결제 결과가 일치하지 않습니다.', 409);
        }
        if (subscriptionBlocksNewStart(currentSubscription, now)
          && currentSubscription?.currentOrderId !== orderId) {
          throw subscriptionError('SUBSCRIPTION_GENERATION_CHANGED', '구독 상태가 변경되어 결제 적용을 중단했습니다.', 409);
        }
      } else if (!sameSubscriptionGeneration(currentSubscription, expectedGeneration, { requireStatus: 'active' })) {
        throw subscriptionError('SUBSCRIPTION_GENERATION_CHANGED', '구독 상태가 변경되어 갱신 적용을 중단했습니다.', 409);
      }
    }

    if (orderSnap.exists) {
      const existingOrder = orderSnap.data() || {};
      if (existingOrder.uid !== uid || existingOrder.tier !== tier || existingOrder.status !== 'paid') {
        throw subscriptionError('SUBSCRIPTION_ORDER_CONFLICT', 'subscription order conflict', 409);
      }
      if (claimRef && claim.status !== 'applied') {
        t.set(claimRef, {
          status: 'applied',
          billingKey: null,
          paymentKey: null,
          appliedAt: cycleStartedAt,
          leaseUntil: null,
          updatedAt: cycleStartedAt
        }, { merge: true });
      }
      return { deduped: true };
    }

    const subscription = {
      tier,
      status: 'active',
      currentOrderId: orderId,
      // ★ C-03: billingKey·customerKey는 사용자가 읽는 이 문서에 더 이상 저장하지 않는다(billingSecrets/{uid}로 분리).
      //   customerKey는 cust_${uid}로 결정적이라 보관 불필요. 카드사·마스킹번호만 표시용으로 유지.
      cardCompany: cardCompany || null,
      cardNumber: cardNumber || null,
      startedAt: isFirst ? cycleStartedAt : (currentSubscription?.startedAt || cycleStartedAt),
      nextBillingAt,
      cancelledAt: null,
      lastBillingAt: cycleStartedAt,
      cycleStartedAt
    };

    const coupon = {
      tier,
      remaining: usesPerCycle,
      granted: usesPerCycle,
      used: 0,
      resetAt: nextBillingAt
    };

    const userPatch = { subscription, coupon };
    if (tier === 'unlimited') userPatch.plan = 'unlimited';
    else userPatch.plan = 'pro';

    t.update(userRef, userPatch);

    t.set(orderRef, {
      uid, tier,
      amount: plan.amount,
      paymentKeyPresent: true,   // ★ C-04: paymentKey 원문은 paymentSecrets로 분리
      orderId,
      status: 'paid',
      requestedAt: cycleStartedAt,
      approvedAt: cycleStartedAt,
      cycleStartedAt,
      cycleEndsAt: nextBillingAt,
      ...refundPolicyPurchaseSnapshot
    });

    const couponHistRef = userRef.collection('couponHistory').doc();
    t.set(couponHistRef, {
      type: 'grant',
      tier,
      amount: usesPerCycle,
      remaining: usesPerCycle,
      orderId,
      createdAt: cycleStartedAt
    });

    // ★ C-03: 결제 비밀(billingKey)을 사용자가 읽는 users 문서가 아니라 서버 전용 컬렉션에 이중 기록.
    //   billingSecrets/{uid}는 Rules에서 read/write를 전면 차단해 클라이언트가 직접 읽을 수 없다.
    //   customerKey는 cust_${uid}로 결정적이라 저장 불필요. 읽기 경로 전환·기존문서 정리는 결제 무결성 단계.
    t.set(db.collection('billingSecrets').doc(uid), {
      billingKey,
      cardCompany: cardCompany || null,
      updatedAt: cycleStartedAt
    }, { merge: true });
    // ★ C-04: 정기결제 paymentKey도 서버 전용 paymentSecrets로(환불 시 서버가 읽음).
    t.set(db.collection('paymentSecrets').doc(orderId), {
      paymentKey: paymentResult.paymentKey, uid, createdAt: cycleStartedAt
    });
    if (claimRef) {
      t.set(claimRef, {
        status: 'applied',
        billingKey: null,
        paymentKey: null,
        appliedAt: cycleStartedAt,
        leaseUntil: null,
        updatedAt: cycleStartedAt
      }, { merge: true });
    }
    return { deduped: false };
  });
}

// === 1) 빌링키 발급 + 첫 결제 ===
router.post('/subscription/issue-billing-key', async (req, res) => {
  const { authKey, customerKey, tier, customerEmail, customerName, meta } = req.body;

  const uid = await verifyToken(bearerToken(req));
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });
  if (!authKey || !customerKey) return res.status(400).json({ error: '결제 정보가 누락되었습니다.' });
  if (customerKey !== `cust_${uid}`) return res.status(403).json({ error: '결제 식별자가 일치하지 않습니다.' });

  const plan = SUB_PLANS[tier];
  if (!plan) return res.status(400).json({ error: '유효하지 않은 구독 상품입니다.' });

  // Durable per-user claim precedes every provider call. Concurrent requests,
  // expiry and renewal therefore cannot issue or charge two independent keys.
  let claimed;
  try {
    claimed = await acquireSubscriptionStartClaim({
      uid,
      tier,
      customerKey,
      authKeyHash: authKeyDigest(authKey)
    });
  } catch (error) {
    logger.warn('subscription.start_claim_rejected', { uid, tier, code: error.code, err: error });
    return res.status(error.status || 409).json({ code: error.code || 'SUBSCRIPTION_START_REJECTED', error: error.message });
  }
  if (claimed.alreadyApplied) {
    return res.json({ ok: true, tier, amount: plan.amount, orderId: claimed.row.orderId, deduped: true });
  }
  if (claimed.manualReview) {
    return res.status(409).json({
      code: 'SUBSCRIPTION_START_REVIEW_REQUIRED',
      error: '카드 등록 결과를 자동으로 확정하지 못했습니다. 고객센터에서 확인해 드립니다.'
    });
  }

  let claim = claimed.row;
  const claimToken = claim.claimToken;
  const orderId = claim.orderId;
  let billingKey = claim.billingKey || '';
  let cardCompany = claim.cardCompany || null;
  let cardNumber = claim.cardNumber || null;
  let userSnap;

  try {
    if (claim.status === 'claimed') {
    claim = await transitionSubscriptionStartClaim({
      uid,
      claimToken,
      from: 'claimed',
      status: 'billing_issuing'
    });
    let issued;
    try {
      issued = await tossIssueBillingKey({ authKey, customerKey });
    } catch (error) {
      // Issuance does not support our payment idempotency key. Keep the claim in
      // review state instead of retrying and potentially creating a second key.
      logger.error('subscription.billing_key_issue_unknown', { uid, tier, orderId, err: error });
      await markBillingIssueUnknown({
        uid,
        claimToken,
        priorAttempts: claim.billingIssueUnknownAttempts,
        reason: error.code || error.message || 'transport_error'
      }).catch(markError => logger.error('subscription.billing_issue_unknown_mark_failed', { uid, orderId, err: markError }));
      return res.status(503).json({
        code: 'SUBSCRIPTION_START_REVIEW_REQUIRED',
        error: '카드 등록 결과를 확인하고 있습니다. 중복 결제를 막기 위해 고객센터 확인이 필요합니다.'
      });
    }
    if (!issued.ok) {
      logger.warn('subscription.billing_key_issue_failed', { uid, tier, orderId, status: issued.status, toss: issued.data });
      if (Number(issued.status) >= 500 || !Number(issued.status)) {
        await markBillingIssueUnknown({
          uid,
          claimToken,
          priorAttempts: claim.billingIssueUnknownAttempts,
          reason: issued.data?.code || `http_${Number(issued.status) || 0}`
        }).catch(markError => logger.error('subscription.billing_issue_unknown_mark_failed', { uid, orderId, err: markError }));
        return res.status(503).json({
          code: 'SUBSCRIPTION_START_REVIEW_REQUIRED',
          error: '카드 등록 결과를 확인하고 있습니다. 잠시 후 고객센터에 문의해주세요.'
        });
      }
      await transitionSubscriptionStartClaim({
        uid,
        claimToken,
        from: 'billing_issuing',
        status: 'failed',
        fields: { failureReason: String(issued.data?.code || issued.data?.message || 'billing_key_issue_failed').slice(0, 160) }
      }).catch(() => {});
      return res.status(issued.status || 400).json({ error: '빌링키 발급 실패: ' + (issued.data?.message || '알 수 없는 오류') });
    }
    if (!validProviderKey(issued.data?.billingKey)) {
      logger.error('subscription.billing_key_issue_malformed', { uid, tier, orderId });
      await markBillingIssueUnknown({
        uid,
        claimToken,
        priorAttempts: claim.billingIssueUnknownAttempts,
        reason: 'malformed_success_response'
      }).catch(markError => logger.error('subscription.billing_issue_unknown_mark_failed', { uid, orderId, err: markError }));
      return res.status(503).json({
        code: 'SUBSCRIPTION_START_REVIEW_REQUIRED',
        error: '카드 등록 결과를 확인하고 있습니다. 중복 결제를 막기 위해 고객센터 확인이 필요합니다.'
      });
    }
    billingKey = issued.data.billingKey;
    cardCompany = issued.data.cardCompany || null;
    cardNumber = issued.data.card?.number || null;
    claim = await transitionSubscriptionStartClaim({
      uid,
      claimToken,
      from: 'billing_issuing',
      status: 'billing_issued',
      fields: { billingKey, cardCompany, cardNumber }
    });
    }

    if (['billing_issued', 'charging', 'charge_unknown'].includes(claim.status)) {
    claim = await transitionSubscriptionStartClaim({
      uid,
      claimToken,
      from: ['billing_issued', 'charging', 'charge_unknown'],
      status: 'charging'
    });
    let charged;
    try {
      charged = await tossChargeBilling({
        billingKey: claim.billingKey,
        customerKey,
        amount: plan.amount,
        orderId,
        orderName: plan.name,
        customerEmail: customerEmail || null,
        customerName: customerName || null,
        idempotencyKey: orderId
      });
    } catch (error) {
      await transitionSubscriptionStartClaim({
        uid,
        claimToken,
        from: 'charging',
        status: 'charge_unknown',
        fields: { failureReason: String(error.code || error.message || 'charge_transport_error').slice(0, 160) }
      }).catch(() => {});
      logger.error('subscription.first_charge_unknown', { uid, tier, orderId, err: error });
      return res.status(503).json({ code: 'SUBSCRIPTION_CHARGE_PENDING', error: '결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (!charged.ok) {
      const uncertain = Number(charged.status) >= 500 || !Number(charged.status);
      await transitionSubscriptionStartClaim({
        uid,
        claimToken,
        from: 'charging',
        status: uncertain ? 'charge_unknown' : 'failed',
        fields: { failureReason: String(charged.data?.code || charged.data?.message || 'charge_failed').slice(0, 160) }
      }).catch(() => {});
      logger.warn('subscription.first_charge_failed', { uid, tier, orderId, status: charged.status, toss: charged.data });
      return res.status(uncertain ? 503 : (charged.status || 400)).json({
        code: uncertain ? 'SUBSCRIPTION_CHARGE_PENDING' : undefined,
        error: uncertain ? '결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해주세요.' : '결제 실패: ' + (charged.data?.message || '알 수 없는 오류')
      });
    }
    if (!validProviderKey(charged.data?.paymentKey)) {
      await transitionSubscriptionStartClaim({
        uid,
        claimToken,
        from: 'charging',
        status: 'charge_unknown',
        fields: { failureReason: 'provider_success_payment_key_invalid' }
      }).catch(() => {});
      logger.error('subscription.first_charge_malformed', { uid, tier, orderId });
      return res.status(503).json({ code: 'SUBSCRIPTION_CHARGE_PENDING', error: '결제 결과를 확인하고 있습니다.' });
    }
    claim = await transitionSubscriptionStartClaim({
      uid,
      claimToken,
      from: 'charging',
      status: 'charged',
      fields: { paymentKey: charged.data.paymentKey }
    });
    }

    if (claim.status !== 'charged' || !claim.billingKey || !claim.paymentKey) {
      return res.status(409).json({ code: 'SUBSCRIPTION_START_STATE_INVALID', error: '구독 결제 상태를 확인해주세요.' });
    }

    userSnap = await db.collection('users').doc(uid).get();
    await applySubscriptionCycle({
      uid, tier, plan,
      paymentResult: { paymentKey: claim.paymentKey, orderId },
      billingKey: claim.billingKey,
      cardCompany: claim.cardCompany,
      cardNumber: claim.cardNumber,
      customerKey,
      isFirst: false,
      startClaim: { claimToken }
    });
  } catch (error) {
    logger.error('subscription.start_operation_failed', { uid, tier, orderId, code: error.code, err: error });
    return res.status(error.status || 500).json({
      code: error.code || 'SUBSCRIPTION_START_FAILED',
      error: error.status ? error.message : '구독 결제 처리에 실패했습니다. 결제 내역을 확인한 뒤 관리자에 문의해주세요.'
    });
  }

  logger.info('subscription.started', { uid, tier, amount: plan.amount, orderId });
  discord.subscription({ uid, tier, action: '시작' });
  discord.paymentDone({ uid, amount: plan.amount, kind: `구독 시작 · ${tier}` });
  res.json({ ok: true, tier, amount: plan.amount, orderId });
  void metaConversions.sendPurchase({
    eventId: `purchase_${orderId}`,
    orderId,
    value: plan.amount,
    itemId: `sub_${tier}`,
    email: userSnap.exists ? userSnap.data()?.email : customerEmail,
    externalId: uid,
    clientIp: realClientIp(req),
    userAgent: req.get('user-agent'),
    context: meta
  });
});

// === 2) 정기결제 1건 처리 (cron 전용) ===
router.post('/subscription/charge', async (req, res) => {
  const internalKey = requireCronSecret(req, res);
  if (!internalKey) return;
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  setLogContext({ uid });

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return res.status(404).json({ error: 'user not found' });

  const sub = snap.data().subscription;
  if (!sub || sub.status !== 'active') return res.status(400).json({ error: 'no active subscription' });

  const now = Date.now();
  const dueMs = sub.nextBillingAt?.toMillis?.() || 0;
  if (dueMs > now) return res.status(400).json({ error: 'not due yet' });

  const plan = SUB_PLANS[sub.tier];
  if (!plan) return res.status(400).json({ error: 'invalid tier' });

  // ★ C-04: orderId를 '결제 도래 시각(dueMs)' 기준으로 결정화한다. 다중 인스턴스 cron이 같은 사이클을
  //   동시에 처리해도 동일 orderId를 만들어 orderSnap 중복검사·DUPLICATE_ORDER로 한 번만 청구된다.
  const cycleKey = dueMs > 0 ? dueMs : now;
  const orderId = buildOrderId(uid, cycleKey);
  const expectedGeneration = subscriptionGeneration(sub);
  let claimed;
  try {
    claimed = await acquireRenewalClaim({ uid, expectedGeneration, tier: sub.tier, orderId, nowMs: now });
  } catch (error) {
    logger.warn('subscription.renewal_claim_rejected', { uid, tier: sub.tier, orderId, code: error.code, err: error });
    return res.status(error.status || 409).json({ code: error.code || 'SUBSCRIPTION_RENEWAL_REJECTED', error: error.message });
  }
  if (claimed.deduped) return res.json({ ok: true, deduped: true });

  const claimToken = claimed.row.claimToken;
  try {
    let paymentKey = claimed.resumedCharged ? claimed.row.paymentKey : '';
  // ★ C-03: billingKey는 서버 전용 billingSecrets에서(없으면 sub.billingKey 폴백). customerKey는 결정적 계산.
  const billingKey = claimed.resumedCharged
    ? String(claimed.row.billingKey || '')
    : await readBillingKey(uid, sub.billingKey);
  const customerKey = customerKeyFor(uid);
  if (!billingKey) {
    logger.error('subscription.charge_no_billing_key', { uid, tier: sub.tier, orderId });
    await finalizeRenewalFailure({
      uid,
      orderId,
      claimToken,
      expectedGeneration,
      tier: sub.tier,
      amount: plan.amount,
      reason: 'billing_key_missing'
    }).catch(error => logger.error('subscription.missing_key_quarantine_failed', { uid, orderId, err: error }));
    return res.status(400).json({ error: '결제 수단 정보가 없습니다.' });
  }

  if (!paymentKey) {
    let charged;
    try {
      charged = await tossChargeBilling({
        billingKey,
        customerKey,
        amount: plan.amount,
        orderId,
        orderName: plan.name,
        idempotencyKey: orderId
      });
      // 카드사 일시 오류 대비 1회 재시도 — 같은 Idempotency-Key라 중복 승인되지 않음.
      if (!charged.ok && (Number(charged.status) >= 500 || !Number(charged.status))) {
        logger.warn('subscription.charge_retrying', { uid, tier: sub.tier, orderId, code: charged.data?.code });
        await new Promise(resolve => setTimeout(resolve, 1500));
        charged = await tossChargeBilling({
          billingKey,
          customerKey,
          amount: plan.amount,
          orderId,
          orderName: plan.name,
          idempotencyKey: orderId
        });
      }
    } catch (error) {
      // Unknown transport outcome is retried only after the durable lease expires;
      // the stable order/idempotency key prevents another provider approval.
      logger.error('subscription.charge_result_unknown', { uid, tier: sub.tier, orderId, err: error });
      return res.status(503).json({ code: 'SUBSCRIPTION_CHARGE_PENDING', error: '정기결제 결과를 확인하고 있습니다.' });
    }

    if (!charged.ok) {
      const uncertain = Number(charged.status) >= 500 || !Number(charged.status);
      logger.error('subscription.charge_failed', { uid, tier: sub.tier, orderId, status: charged.status, toss: charged.data });
      if (!uncertain) {
        await finalizeRenewalFailure({
          uid,
          orderId,
          claimToken,
          expectedGeneration,
          tier: sub.tier,
          amount: plan.amount,
          reason: charged.data?.message || charged.data?.code || 'unknown'
        });
        discord.paymentFailed({ uid, tier: sub.tier, reason: charged.data?.message || 'unknown' });
      }
      return res.status(uncertain ? 503 : (charged.status || 400)).json({
        code: uncertain ? 'SUBSCRIPTION_CHARGE_PENDING' : undefined,
        error: uncertain ? '정기결제 결과를 확인하고 있습니다.' : '정기결제 실패'
      });
    }
    if (!validProviderKey(charged.data?.paymentKey)) {
      logger.error('subscription.charge_malformed', { uid, tier: sub.tier, orderId });
      return res.status(503).json({ code: 'SUBSCRIPTION_CHARGE_PENDING', error: '정기결제 결과를 확인하고 있습니다.' });
    }
    const chargedClaim = await markRenewalClaimCharged({
      uid,
      orderId,
      claimToken,
      paymentKey: charged.data.paymentKey,
      billingKey
    });
    paymentKey = chargedClaim.paymentKey;
  }

  try {
    await applySubscriptionCycle({
      uid, tier: sub.tier, plan,
      paymentResult: { paymentKey, orderId },
      billingKey,
      cardCompany: sub.cardCompany, cardNumber: sub.cardNumber,
      customerKey, isFirst: false,
      renewalClaim: { claimToken },
      expectedGeneration
    });
  } catch (e) {
    logger.error('subscription.cycle_apply_failed_manual_action', { uid, tier: sub.tier, orderId, code: e.code, err: e });
    return res.status(e.status || 500).json({ code: e.code || 'SUBSCRIPTION_APPLY_FAILED', error: '사이클 적용 실패' });
  }
  } catch (error) {
    logger.error('subscription.renewal_operation_failed', { uid, tier: sub.tier, orderId, code: error.code, err: error });
    return res.status(error.status || 500).json({
      code: error.code || 'SUBSCRIPTION_RENEWAL_FAILED',
      error: error.status ? error.message : '정기결제 처리에 실패했습니다.'
    });
  }

  logger.info('subscription.charge_succeeded', { uid, tier: sub.tier, orderId });
  discord.paymentDone({ uid, amount: plan.amount, kind: `구독 갱신 · ${sub.tier}` });
  res.json({ ok: true, orderId });
});

// === 3) 매시간 cron 진입점 핵심 로직 ===
async function runProcessDue(internalKey) {
  const now = admin.firestore.Timestamp.now();
  const results = {
    processed: 0,
    charged: 0,
    failed: 0,
    expired: 0,
    startRecovery: null,
    paymentReconciliation: null,
    cancellationInbox: null,
    generalWebhookInbox: null,
    accountDeletions: null
  };

  // 1) active + nextBillingAt 도래 → 결제 시도
  const dueSnap = await db.collection('users')
    .where('subscription.status', '==', 'active')
    .where('subscription.nextBillingAt', '<=', now)
    .limit(100)
    .get();

  for (const doc of dueSnap.docs) {
    results.processed++;
    try {
      const r = await outboundFetch('internal_loopback', `http://localhost:${process.env.PORT || 3000}/subscription/charge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': internalKey
        },
        body: JSON.stringify({ uid: doc.id })
      });
      if (r.ok) results.charged++;
      else {
        // 이전에는 카운터만 올리고 로그가 없어서 "100건 중 80건 실패"의 개별 원인을 알 수 없었다.
        results.failed++;
        logger.warn('subscription.cron_charge_rejected', { uid: doc.id, statusCode: r.status });
      }
    } catch (e) {
      logger.error('subscription.cron_charge_request_failed', { uid: doc.id, err: e });
      results.failed++;
    }
  }

  // 2) cancelled + nextBillingAt 도래 → expired로 전환
  const cancelledSnap = await db.collection('users')
    .where('subscription.status', '==', 'cancelled')
    .where('subscription.nextBillingAt', '<=', now)
    .limit(200)
    .get();

  for (const doc of cancelledSnap.docs) {
    let expiry;
    try {
      expiry = await acquireExpiryClaim({ uid: doc.id });
    } catch (error) {
      results.failed++;
      logger.error('subscription.expiry_claim_failed', { uid: doc.id, code: error.code, err: error });
      continue;
    }
    if (expiry.skipped) continue;
    const { row } = expiry;
    if (row.billingKey && !(await tossDeleteBillingKey(row.billingKey))) {
      // Keep the claim lease and local secret. A later cron can safely reclaim
      // the same generation; it never deletes a newly-created billing secret.
      results.failed++;
      logger.error('subscription.billing_key_delete_failed', {
        uid: doc.id,
        message: '구독 만료 중 토스 빌링키 삭제에 실패해 다음 주기에 재시도합니다.'
      });
      continue;
    }
    try {
      const finalized = await finalizeExpiryClaim({ uid: doc.id, claimToken: row.claimToken });
      if (finalized.expired) results.expired++;
    } catch (error) {
      results.failed++;
      logger.error('subscription.expiry_finalize_failed', { uid: doc.id, code: error.code, err: error });
    }
  }

  // A browser may disappear after provider approval but before Firestore apply.
  // Recover charged first-subscription claims without the one-time authKey.
  results.startRecovery = await reconcileChargedSubscriptionStarts({ limit: 20 });

  // Reuse the already-configured subscription cron as a recovery safety net.
  // The dedicated payment reconciliation cron may still run independently;
  // payment intent leases and idempotent application make both callers safe.
  try {
    const reconciliationResponse = await outboundFetch(
      'internal_loopback',
      `http://localhost:${process.env.PORT || 3000}/cron/reconcile-payments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': internalKey
        },
        body: JSON.stringify({ limit: 25 })
      }
    );
    let reconciliationBody = {};
    try { reconciliationBody = await reconciliationResponse.json(); } catch {}
    results.paymentReconciliation = reconciliationResponse.ok
      ? reconciliationBody
      : { ok: false, status: reconciliationResponse.status };
    if (!reconciliationResponse.ok) {
      logger.error('payment.reconciliation_process_due_rejected', {
        statusCode: reconciliationResponse.status
      });
    }
  } catch (error) {
    results.paymentReconciliation = { ok: false, error: 'request_failed' };
    logger.error('payment.reconciliation_process_due_failed', { err: error });
  }

  // Webhooks are acknowledged after durable inbox persistence. Retry any transient
  // credit-cancellation handler failure on the existing authenticated cron cycle.
  results.cancellationInbox = await reconcilePendingCreditCancellationInboxes({ limit: 25 });
  results.generalWebhookInbox = await reconcilePendingGeneralWebhookInboxes({ limit: 25 });
  results.accountDeletions = await reconcilePendingAccountDeletions({ admin, db, logger, limit: 10 });

  logger.info('subscription.cron_process_due_completed', results);

  // 배치가 "돌긴 했는데 대부분 실패"하는 상황은 info 한 줄로는 절대 안 보인다. 실패율로 승격한다.
  if (results.processed >= 3 && results.failed / results.processed >= 0.5) {
    logger.error('subscription.cron_due_failure_rate_high', {
      processed: results.processed,
      failed: results.failed,
      charged: results.charged,
      failureRate: Math.round((results.failed / results.processed) * 100),
      message: `구독 갱신 ${results.processed}건 중 ${results.failed}건 실패`
    });
  }
  // 성공적으로 완주했다는 사실 자체를 하트비트로 남긴다 → 크론이 멈추면 워치독이 잡는다.
  try { require('../lib/opsHeartbeat').beat('subscription.process_due', { processed: results.processed, failed: results.failed }); } catch (_) {}
  return results;
}

// POST 진입점 (기존 호환)
router.post('/subscription/process-due', async (req, res) => {
  const internalKey = requireCronSecret(req, res);
  if (!internalKey) return;
  try {
    const results = await runProcessDue(internalKey);
    res.json({ ok: true, ...results });
  } catch (e) {
    logger.error('subscription.cron_process_due_failed', { err: e });
    res.status(500).json({ error: 'process-due failed', detail: e?.message || String(e) });
  }
});

// GET 쿼리스트링 인증은 secret이 URL/로그에 남으므로 운영에서는 닫는다.
router.get('/subscription/process-due', async (req, res) => {
  res.status(410).json({ error: 'deprecated: use POST /subscription/process-due with Authorization: Bearer <CRON_SECRET>' });
});

// === 4) 사용자 취소 ===
router.post('/subscription/cancel', async (req, res) => {
  const uid = await verifyToken(bearerToken(req));
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });

  let cancelled;
  try {
    cancelled = await cancelCurrentSubscription(uid);
  } catch (error) {
    return res.status(error.status || 409).json({ code: error.code || 'SUBSCRIPTION_CANCEL_FAILED', error: error.message });
  }

  logger.info('subscription.cancelled_by_user', { uid, tier: cancelled.tier });
  discord.subscription({ uid, tier: cancelled.tier, action: '해지' });
  res.json({ ok: true, message: '구독이 취소되었습니다. 다음 결제일까지 사용 가능합니다.' });
});

// === 5) 사용자 재개 ===
router.post('/subscription/resume', async (req, res) => {
  const uid = await verifyToken(bearerToken(req));
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });

  let resumed;
  try {
    resumed = await resumeCurrentSubscription(uid);
  } catch (error) {
    return res.status(error.status || 409).json({ code: error.code || 'SUBSCRIPTION_RESUME_FAILED', error: error.message });
  }

  logger.info('subscription.resumed_by_user', { uid, tier: resumed.tier });
  discord.subscription({ uid, tier: resumed.tier, action: '재개' });
  res.json({ ok: true, message: '구독이 재개되었습니다.' });
});

// === 6) 상태 조회 ===
router.get('/subscription/status', async (req, res) => {
  const uid = await verifyToken(bearerToken(req));
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return res.json({ ok: true, subscription: null, coupon: null });

  const d = snap.data();
  // ★ C-03: 응답에서 결제 비밀(billingKey·customerKey)을 제거. 카드사·마스킹번호·상태·날짜만 노출한다.
  const sub = d.subscription;
  const safeSub = sub ? (({ billingKey, customerKey, ...rest }) => rest)(sub) : null;
  res.json({ ok: true, subscription: safeSub, coupon: d.coupon || null, plan: d.plan || 'free' });
});

// === 7) 토스 웹훅 ===
// 토스는 10초 내 200 응답 필수. 이벤트 처리는 응답 후 비동기로 진행.
// 등록 URL: https://ai-backend-3xtk.onrender.com/toss/webhook
// 구독 이벤트: PAYMENT_STATUS_CHANGED, BILLING_DELETED, CANCEL_STATUS_CHANGED
router.post('/toss/webhook', async (req, res) => {
  const body = req.body || {};
  const { eventType } = body;
  let verification;
  try {
    verification = await verifyTossWebhookEvent(eventType, body.data);
  } catch (err) {
    // General payment webhooks have no signature. A provider API re-query is the authenticity check.
    // A transient query failure must not be acknowledged so Toss retries the event.
    logger.error('toss.webhook_verification_unavailable', {
      eventType,
      providerStatus: err.providerStatus || null,
      provider: err.provider || null,
      err
    });
    return res.status(503).send('verification unavailable');
  }
  if (!verification.ok) {
    logger.warn('toss.webhook_ignored', { eventType, reason: verification.reason });
    return res.status(200).send('IGNORED');
  }
  const data = verification.data;

  // ★ C-07: 이벤트를 먼저 영속화(webhookInbox)한 뒤 200을 응답한다 — 200 후 처리 실패로 인한 이벤트 유실 방지.
  //   같은 이벤트 재전송(최대 7회)은 본문 해시 멱등 키로 한 번만 처리한다(중복 권한 변경 차단).
  const eventKey = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const inboxRef = db.collection('webhookInbox').doc(eventKey);
  const retryLane = retryLaneFor(eventType, data?.orderId);

  let alreadyProcessed = false;
  let claimedLeaseToken = null;
  try {
    await db.runTransaction(async (t) => {
      // Firestore may rerun the callback after a contention retry. Do not carry
      // a decision or lease token from an abandoned callback invocation.
      alreadyProcessed = false;
      claimedLeaseToken = null;
      const cur = await t.get(inboxRef);
      const current = cur.exists ? cur.data() || {} : {};
      const nowMs = Date.now();
      const now = timestampFromMillis(nowMs);
      const receiptPatch = receiptCounterPatch(current, now, { isNew: !cur.exists });

      if (cur.exists && isTerminalWebhookInboxStatus(cur.data()?.status)) {
        alreadyProcessed = true;
        t.set(inboxRef, receiptPatch, { merge: true });
        return;
      }
      if (retryLane === 'general'
        && cur.exists
        && !isGeneralWebhookClaimable({ ...current, retryLane }, nowMs)) {
        alreadyProcessed = true;
        t.set(inboxRef, receiptPatch, { merge: true });
        return;
      }
      const attempt = retryLane === 'general' ? nextAttemptNumber(current) : null;
      if (retryLane === 'general' && attempt > GENERAL_WEBHOOK_MAX_FAILURES) {
        alreadyProcessed = true;
        t.set(inboxRef, {
          ...receiptPatch,
          ...nextFailureState(current, now, current.errorCode || 'WEBHOOK_RETRY_EXHAUSTED')
        }, { merge: true });
        return;
      }

      const commonPatch = {
        ...receiptPatch,
        eventType: eventType || null,
        orderId: data?.orderId || null,
        verified: true,
        retryLane,
        ...((eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'CANCEL_STATUS_CHANGED')
          ? {
              providerPayment: safeProviderPaymentSnapshot(data),
              paymentKeyHash: data?.paymentKey ? paymentKeyHash(data.paymentKey) : null,
              creditCancellationCandidate: retryLane === 'credit_cancellation'
            }
          : {}),
        ...(eventType === 'BILLING_DELETED'
          ? {
              billingUid: verification.billingUid || null,
              billingKeyHash: verification.billingKeyHash || null
            }
          : {})
      };
      if (retryLane === 'general') {
        claimedLeaseToken = crypto.randomUUID();
        Object.assign(commonPatch, {
          status: 'processing',
          generalWebhookCandidate: true,
          retryAttempts: attempt,
          leaseToken: claimedLeaseToken,
          leaseUntil: timestampFromMillis(nowMs + GENERAL_WEBHOOK_LEASE_MS),
          lastAttemptAt: now
        });
      } else {
        Object.assign(commonPatch, {
          status: 'received',
          generalWebhookCandidate: false
        });
      }
      t.set(inboxRef, commonPatch, { merge: true });
    });
  } catch (e) {
    // 영속화 실패 시 200을 보내지 않는다 → Toss가 재전송하도록 유도(이벤트 유실 방지).
    logger.error('toss.webhook_inbox_persist_failed', { eventType, err: e });
    return res.status(503).send('inbox unavailable');
  }

  res.status(200).send('OK');
  if (alreadyProcessed) {
    logger.info('toss.webhook_duplicate_skipped', { eventType, orderId: data?.orderId });
    return;
  }

  logger.info('toss.webhook_received', {
    eventType,
    orderId: data?.orderId,
    paymentStatus: data?.status,
    cancelStatus: data?.cancelStatus
  });

  try {
    const processed = await processVerifiedTossWebhook({
      eventType,
      data,
      billingUid: verification.billingUid || '',
      billingKeyDigest: verification.billingKeyHash || '',
      paymentKeyDigest: data?.paymentKey ? paymentKeyHash(data.paymentKey) : '',
      inboxId: eventKey,
      source: 'live'
    });
    if (processed?.creditCancellation) {
      const reconciled = processed.creditCancellation;
      const disposition = classifyCreditCancellationResult(reconciled);
      await inboxRef.update({
        status: disposition.inboxStatus,
        creditCancellationCandidate: disposition.creditCancellationCandidate,
        reconciliationHandled: reconciled.handled === true,
        reconciliationReason: disposition.reason,
        ...(disposition.terminal
          ? { processedAt: admin.firestore.FieldValue.serverTimestamp() }
          : { retryAt: admin.firestore.FieldValue.serverTimestamp() })
      });
    } else if (retryLane === 'general') {
      await completeGeneralWebhookClaim({ ref: inboxRef }, claimedLeaseToken);
    } else {
      await inboxRef.update({ status: 'processed', creditCancellationCandidate: false, processedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  } catch (e) {
    logger.error('toss.webhook_handler_failed', { eventType, err: e });
    if (retryLane === 'general') {
      await failGeneralWebhookClaim({ ref: inboxRef }, claimedLeaseToken, e).catch(() => {});
    } else {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(inboxRef);
        if (!snapshot.exists || isTerminalWebhookInboxStatus(snapshot.data()?.status)) return;
        transaction.update(inboxRef, {
          status: 'error',
          creditCancellationCandidate: true,
          reconciliationHandled: false,
          reconciliationReason: 'reconciliation_error',
          retryAttempts: Math.max(0, Number(snapshot.data()?.retryAttempts) || 0) + 1,
          errorCode: String(e?.code || 'WEBHOOK_HANDLER_FAILED').slice(0, 80)
        });
      }).catch(() => {});
    }
  }
});

Object.defineProperty(router, '__webhookTest', {
  value: Object.freeze({
    acquireExpiryClaim,
    acquireRenewalClaim,
    acquireSubscriptionStartClaim,
    activeSubscriptionOperation,
    applySubscriptionCycle,
    cancelCurrentSubscription,
    claimChargedStartForRecovery,
    claimGeneralWebhookDoc,
    completeGeneralWebhookClaim,
    finalizeExpiryClaim,
    finalizeRenewalFailure,
    failGeneralWebhookClaim,
    markRenewalClaimCharged,
    processVerifiedTossWebhook,
    reconcileChargedSubscriptionStarts,
    reconcilePendingGeneralWebhookInboxes,
    runProcessDue,
    resumeCurrentSubscription,
    subscriptionGeneration,
    transitionSubscriptionStartClaim,
    verifyTossWebhookEvent,
    verifyToken
  }),
  enumerable: false
});

module.exports = router;
