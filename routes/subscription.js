// [정기결제] 토스페이먼츠 빌링키 발급 + 매달 자동결제 + 쿠폰 부여 처리

const express = require('express');
const crypto = require('crypto');
const { admin, db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const metaConversions = require('../lib/metaConversions');
const { realClientIp } = require('../lib/clientip');
const {
  paymentKeyHash,
  providerResultSummary,
  webhookPaymentValidation
} = require('../lib/paymentReconciliation');
const {
  reconcileCreditPaymentCancellation,
  reconcilePendingCreditCancellationInboxes,
  safeProviderPaymentSnapshot
} = require('../lib/paymentCancellation');

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

// 토스 빌링 API 헬퍼
function tossBasicToken() {
  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) throw new Error('TOSS_SECRET_KEY_MISSING');
  return Buffer.from(secretKey + ':').toString('base64');
}

function bearerToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function requireCronSecret(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) {
    logger.error('subscription.cron_secret_missing');
    res.status(503).json({ error: 'cron disabled: CRON_SECRET is not configured' });
    return null;
  }
  const supplied = bearerToken(req) || req.get('x-cron-secret') || (req.body && req.body.internalKey) || '';
  if (!supplied || supplied !== secret) {
    logger.warn('subscription.cron_secret_rejected');
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return secret;
}

async function tossIssueBillingKey({ authKey, customerKey }) {
  const res = await fetch('https://api.tosspayments.com/v1/billing/authorizations/issue', {
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
  const res = await fetch(`https://api.tosspayments.com/v1/billing/${encodeURIComponent(billingKey)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ customerKey, amount, orderId, orderName, customerEmail, customerName })
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function tossDeleteBillingKey(billingKey) {
  try {
    const res = await fetch(`https://api.tosspayments.com/v1/billing/${encodeURIComponent(billingKey)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Basic ${tossBasicToken()}` }
    });
    return res.ok;
  } catch { return false; }
}

async function tossQueryPayment(paymentKey) {
  try {
    const res = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${tossBasicToken()}` }
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: {}, error };
  }
}

async function verifyTossWebhookEvent(eventType, reportedData) {
  const data = reportedData && typeof reportedData === 'object' ? reportedData : {};
  if (eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'CANCEL_STATUS_CHANGED') {
    if (!data.paymentKey) return { ok: false, reason: 'payment_key_missing' };
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
    if (!data.billingKey) return { ok: false, reason: 'billing_key_missing' };
    const secretSnapshot = await db.collection('billingSecrets')
      .where('billingKey', '==', data.billingKey)
      .limit(1)
      .get();
    if (secretSnapshot.empty) return { ok: false, reason: 'billing_key_unknown' };
    return { ok: true, data, billingUid: secretSnapshot.docs[0].id };
  }

  return { ok: false, reason: 'unsupported_event_type' };
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

async function verifyToken(idToken) {
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch { return null; }
}

function buildOrderId(uid, ts) { return `sub_${uid}_${ts}`; }

// 구독 + 쿠폰 + 주문 + 히스토리를 atomic하게 기록하는 헬퍼
async function applySubscriptionCycle({ uid, tier, plan, paymentResult, billingKey, cardCompany, cardNumber, customerKey, isFirst }) {
  const now = Date.now();
  const cycleStartedAt = admin.firestore.Timestamp.fromMillis(now);
  const nextBillingAt = admin.firestore.Timestamp.fromMillis(now + CYCLE_MS);
  const orderId = paymentResult.orderId;
  const userRef = db.collection('users').doc(uid);
  const orderRef = db.collection('subscriptionOrders').doc(orderId);
  const usesPerCycle = plan.usesPerCycle;

  await db.runTransaction(async (t) => {
    const orderSnap = await t.get(orderRef);
    if (orderSnap.exists) throw new Error('DUPLICATE_ORDER');

    const userSnap = await t.get(userRef);
    if (!userSnap.exists && !isFirst) throw new Error('USER_NOT_FOUND');

    const subscription = {
      tier,
      status: 'active',
      // ★ C-03: billingKey·customerKey는 사용자가 읽는 이 문서에 더 이상 저장하지 않는다(billingSecrets/{uid}로 분리).
      //   customerKey는 cust_${uid}로 결정적이라 보관 불필요. 카드사·마스킹번호만 표시용으로 유지.
      cardCompany: cardCompany || null,
      cardNumber: cardNumber || null,
      startedAt: isFirst ? cycleStartedAt : (userSnap.data()?.subscription?.startedAt || cycleStartedAt),
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

    if (userSnap.exists) t.update(userRef, userPatch);
    else t.set(userRef, userPatch);

    t.set(orderRef, {
      uid, tier,
      amount: plan.amount,
      paymentKeyPresent: true,   // ★ C-04: paymentKey 원문은 paymentSecrets로 분리
      orderId,
      status: 'paid',
      requestedAt: cycleStartedAt,
      approvedAt: cycleStartedAt,
      cycleStartedAt,
      cycleEndsAt: nextBillingAt
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
  });
}

// === 1) 빌링키 발급 + 첫 결제 ===
router.post('/subscription/issue-billing-key', async (req, res) => {
  const { idToken, authKey, customerKey, tier, customerEmail, customerName, meta } = req.body;

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });
  if (!authKey || !customerKey) return res.status(400).json({ error: '결제 정보가 누락되었습니다.' });
  if (customerKey !== `cust_${uid}`) return res.status(403).json({ error: '결제 식별자가 일치하지 않습니다.' });

  const plan = SUB_PLANS[tier];
  if (!plan) return res.status(400).json({ error: '유효하지 않은 구독 상품입니다.' });

  // 이미 active 구독이 있으면 차단 (티어 변경은 별도 흐름).
  // cancelled + 사이클 미만료도 차단 (해지 예정 상태에서 다시 결제 못 하게).
  // past_due / expired / refunded 는 재구독 허용.
  const userSnap = await db.collection('users').doc(uid).get();
  const existingSub = userSnap.exists ? userSnap.data().subscription : null;
  if (existingSub) {
    const nextMs = existingSub.nextBillingAt?.toMillis ? existingSub.nextBillingAt.toMillis() : 0;
    if (existingSub.status === 'active') {
      return res.status(400).json({ error: '이미 진행 중인 구독이 있습니다. 마이페이지에서 관리해주세요.' });
    }
    if (existingSub.status === 'cancelled' && nextMs > Date.now()) {
      return res.status(400).json({ error: '해지 예정인 구독이 남아 있습니다. 사이클이 끝난 뒤 다시 신청해주세요.' });
    }
  }

  // 1. 토스 빌링키 발급
  const issued = await tossIssueBillingKey({ authKey, customerKey });
  if (!issued.ok) {
    logger.warn('subscription.billing_key_issue_failed', { uid, tier, status: issued.status, toss: issued.data });
    return res.status(issued.status).json({ error: '빌링키 발급 실패: ' + (issued.data.message || '알 수 없는 오류') });
  }
  const { billingKey, cardCompany, card } = issued.data;
  const cardNumber = card?.number || null;

  // 2. 첫 결제 즉시 실행
  const cycleTs = Date.now();
  const orderId = buildOrderId(uid, cycleTs);
  const charged = await tossChargeBilling({
    billingKey, customerKey,
    amount: plan.amount,
    orderId,
    orderName: plan.name,
    customerEmail: customerEmail || null,
    customerName: customerName || null,
    idempotencyKey: orderId
  });

  if (!charged.ok) {
    logger.warn('subscription.first_charge_failed', { uid, tier, status: charged.status, toss: charged.data });
    return res.status(charged.status).json({ error: '결제 실패: ' + (charged.data.message || '알 수 없는 오류') });
  }

  // 3. 구독/쿠폰/주문 atomic 기록
  try {
    await applySubscriptionCycle({
      uid, tier, plan,
      paymentResult: { paymentKey: charged.data.paymentKey, orderId },
      billingKey, cardCompany, cardNumber,
      customerKey, isFirst: !userSnap.exists
    });
  } catch (e) {
    if (e.message === 'DUPLICATE_ORDER') {
      logger.warn('subscription.duplicate_order_blocked', { uid, tier, orderId });
      return res.status(400).json({ error: '이미 처리된 주문입니다.' });
    }
    logger.error('subscription.apply_failed_manual_action', { uid, tier, orderId, err: e });
    return res.status(500).json({ error: '결제는 됐으나 구독 처리에 실패했습니다. 관리자에 문의해주세요.' });
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

  // 멱등성: 같은 결제주기 orderId가 이미 있으면 즉시 반환
  const orderSnap = await db.collection('subscriptionOrders').doc(orderId).get();
  if (orderSnap.exists) return res.json({ ok: true, deduped: true });

  // ★ C-03: billingKey는 서버 전용 billingSecrets에서(없으면 sub.billingKey 폴백). customerKey는 결정적 계산.
  const billingKey = await readBillingKey(uid, sub.billingKey);
  const customerKey = customerKeyFor(uid);
  if (!billingKey) {
    logger.error('subscription.charge_no_billing_key', { uid, tier: sub.tier, orderId });
    return res.status(400).json({ error: '결제 수단 정보가 없습니다.' });
  }

  let charged = await tossChargeBilling({
    billingKey,
    customerKey,
    amount: plan.amount,
    orderId,
    orderName: plan.name,
    idempotencyKey: orderId
  });

  // 카드사 일시 오류 대비 1회 재시도 (1.5초 후) — 같은 Idempotency-Key라 중복 승인되지 않음
  if (!charged.ok) {
    logger.warn('subscription.charge_retrying', { uid, tier: sub.tier, orderId, code: charged.data?.code });
    await new Promise(r => setTimeout(r, 1500));
    charged = await tossChargeBilling({
      billingKey,
      customerKey,
      amount: plan.amount,
      orderId,
      orderName: plan.name,
      idempotencyKey: orderId
    });
  }

  if (!charged.ok) {
    logger.error('subscription.charge_failed', { uid, tier: sub.tier, orderId, status: charged.status, toss: charged.data });
    await userRef.update({
      'subscription.status': 'past_due',
      'plan': 'free'
    });
    await db.collection('subscriptionOrders').doc(orderId).set({
      uid, tier: sub.tier,
      amount: plan.amount,
      orderId,
      status: 'failed',
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      failReason: charged.data.message || 'unknown'
    });
    discord.paymentFailed({ uid, tier: sub.tier, reason: charged.data.message || 'unknown' });
    return res.status(charged.status).json({ error: '정기결제 실패' });
  }

  try {
    await applySubscriptionCycle({
      uid, tier: sub.tier, plan,
      paymentResult: { paymentKey: charged.data.paymentKey, orderId },
      billingKey,
      cardCompany: sub.cardCompany, cardNumber: sub.cardNumber,
      customerKey, isFirst: false
    });
  } catch (e) {
    if (e.message === 'DUPLICATE_ORDER') return res.json({ ok: true, deduped: true });
    logger.error('subscription.cycle_apply_failed_manual_action', { uid, tier: sub.tier, orderId, err: e });
    return res.status(500).json({ error: '사이클 적용 실패' });
  }

  logger.info('subscription.charge_succeeded', { uid, tier: sub.tier, orderId });
  discord.paymentDone({ uid, amount: plan.amount, kind: `구독 갱신 · ${sub.tier}` });
  res.json({ ok: true, orderId });
});

// === 3) 매시간 cron 진입점 핵심 로직 ===
async function runProcessDue(internalKey) {
  const now = admin.firestore.Timestamp.now();
  const results = { processed: 0, charged: 0, failed: 0, expired: 0, cancellationInbox: null };

  // 1) active + nextBillingAt 도래 → 결제 시도
  const dueSnap = await db.collection('users')
    .where('subscription.status', '==', 'active')
    .where('subscription.nextBillingAt', '<=', now)
    .limit(100)
    .get();

  for (const doc of dueSnap.docs) {
    results.processed++;
    try {
      const r = await fetch(`http://localhost:${process.env.PORT || 3000}/subscription/charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: doc.id, internalKey })
      });
      if (r.ok) results.charged++;
      else results.failed++;
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

  const batch = db.batch();
  for (const doc of cancelledSnap.docs) {
    const sub = doc.data().subscription;
    const bk = await readBillingKey(doc.id, sub?.billingKey);   // ★ C-03: 서버 전용 비밀에서 읽기
    if (bk) await tossDeleteBillingKey(bk);
    batch.update(doc.ref, {
      'subscription.status': 'expired',
      'subscription.billingKey': null,
      'plan': 'free',
      'coupon.remaining': 0
    });
    batch.delete(db.collection('billingSecrets').doc(doc.id));   // ★ C-03: 만료 시 서버 비밀 제거
    results.expired++;
  }
  if (results.expired) await batch.commit();

  // Webhooks are acknowledged after durable inbox persistence. Retry any transient
  // credit-cancellation handler failure on the existing authenticated cron cycle.
  results.cancellationInbox = await reconcilePendingCreditCancellationInboxes({ limit: 25 });

  logger.info('subscription.cron_process_due_completed', results);
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
  const { idToken } = req.body;
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const sub = snap.exists ? snap.data().subscription : null;
  if (!sub || sub.status !== 'active') {
    return res.status(400).json({ error: '활성 구독이 없습니다.' });
  }

  await userRef.update({
    'subscription.status': 'cancelled',
    'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp()
  });

  logger.info('subscription.cancelled_by_user', { uid, tier: sub.tier });
  discord.subscription({ uid, tier: sub.tier, action: '해지' });
  res.json({ ok: true, message: '구독이 취소되었습니다. 다음 결제일까지 사용 가능합니다.' });
});

// === 5) 사용자 재개 ===
router.post('/subscription/resume', async (req, res) => {
  const { idToken } = req.body;
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
  setLogContext({ uid });

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const sub = snap.exists ? snap.data().subscription : null;
  if (!sub || sub.status !== 'cancelled') {
    return res.status(400).json({ error: '취소된 구독이 없습니다.' });
  }
  const dueMs = sub.nextBillingAt?.toMillis?.() || 0;
  if (dueMs <= Date.now()) {
    return res.status(400).json({ error: '이미 만료된 구독입니다. 다시 구독해주세요.' });
  }

  await userRef.update({
    'subscription.status': 'active',
    'subscription.cancelledAt': null
  });

  logger.info('subscription.resumed_by_user', { uid, tier: sub.tier });
  discord.subscription({ uid, tier: sub.tier, action: '재개' });
  res.json({ ok: true, message: '구독이 재개되었습니다.' });
});

// === 6) 상태 조회 ===
router.get('/subscription/status', async (req, res) => {
  const idToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || (req.body && req.body.idToken) || '';   // ★ H-04: query 토큰 제거
  const uid = await verifyToken(idToken);
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

  let alreadyProcessed = false;
  try {
    await db.runTransaction(async (t) => {
      const cur = await t.get(inboxRef);
      if (cur.exists && cur.data().status === 'processed') { alreadyProcessed = true; return; }
      t.set(inboxRef, {
        eventType: eventType || null,
        orderId: data?.orderId || null,
        verified: true,
        ...(/^order_\d{10,}$/.test(String(data?.orderId || ''))
          ? {
              providerPayment: safeProviderPaymentSnapshot(data),
              creditCancellationCandidate: true
            }
          : {}),
        status: 'received',
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
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

  const processEvent = async () => {
    if (eventType === 'PAYMENT_STATUS_CHANGED' || eventType === 'CANCEL_STATUS_CHANGED') {
      const { orderId, status, paymentKey } = data || {};
      if (!orderId) return;
      if (/^order_\d{10,}$/.test(orderId)) {
        await reconcileCreditPaymentCancellation(data, { source: `toss_${String(eventType).toLowerCase()}` });
        return;
      }
      if (eventType !== 'PAYMENT_STATUS_CHANGED') {
        if (!paymentKey) return;
        await db.collection('webhookLogs').add({
          eventType,
          paymentKeyHash: paymentKeyHash(paymentKey),
          paymentKeyPresent: true,
          orderId,
          providerStatus: status || null,
          cancelStatus: data?.cancelStatus || null,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return;
      }
      const orderRef = db.collection('subscriptionOrders').doc(orderId);
      const snap = await orderRef.get();
      if (!snap.exists) return;
      await orderRef.update({
        webhookStatus: status,
        webhookPaymentKeyPresent: Boolean(paymentKey),
        webhookUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // 외부에서 결제가 취소/만료된 경우 사용자 구독 정리
      if (status === 'CANCELED' || status === 'ABORTED' || status === 'EXPIRED') {
        const order = snap.data();
        if (order.uid) {
          logger.warn('toss.webhook_subscription_closed', { eventType, orderId, uid: order.uid, status });
          await db.collection('users').doc(order.uid).update({
            'subscription.status': 'refunded',
            'plan': 'free'
          });
        }
      }
    } else if (eventType === 'BILLING_DELETED') {
      const targetRef = db.collection('users').doc(verification.billingUid);
      logger.warn('toss.webhook_billing_deleted', { uid: targetRef.id });
      await targetRef.update({
        'subscription.status': 'cancelled',
        'subscription.billingKey': null,
        'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
        'subscription.billingKeyDeleted': true
      });
      await db.collection('billingSecrets').doc(targetRef.id).delete().catch(() => {});
    }
  };

  try {
    await processEvent();
    await inboxRef.update({
      status: 'processed',
      creditCancellationCandidate: false,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    logger.error('toss.webhook_handler_failed', { eventType, err: e });
    await inboxRef.update({ status: 'error', error: String(e?.message || e) }).catch(() => {});
  }
});

module.exports = router;
