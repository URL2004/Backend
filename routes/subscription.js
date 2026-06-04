// [정기결제] 토스페이먼츠 빌링키 발급 + 매달 자동결제 + 쿠폰 부여 처리

const express = require('express');
const { admin, db } = require('../config');

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
  return Buffer.from(secretKey + ':').toString('base64');
}

async function tossIssueBillingKey({ authKey, customerKey }) {
  const res = await fetch('https://api.tosspayments.com/v1/billing/authorizations/issue', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${tossBasicToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey, customerKey })
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function tossChargeBilling({ billingKey, customerKey, amount, orderId, orderName, customerEmail, customerName }) {
  const res = await fetch(`https://api.tosspayments.com/v1/billing/${encodeURIComponent(billingKey)}`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${tossBasicToken()}`, 'Content-Type': 'application/json' },
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
      customerKey,
      billingKey,
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
      paymentKey: paymentResult.paymentKey,
      orderId,
      status: 'paid',
      billingKey,
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
  });
}

// === 1) 빌링키 발급 + 첫 결제 ===
router.post('/subscription/issue-billing-key', async (req, res) => {
  const { idToken, authKey, customerKey, tier, customerEmail, customerName } = req.body;

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
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
    console.error('❌ 빌링키 발급 실패:', issued.data);
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
    customerName: customerName || null
  });

  if (!charged.ok) {
    console.error('❌ 첫 정기결제 실패:', charged.data);
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
      return res.status(400).json({ error: '이미 처리된 주문입니다.' });
    }
    console.error('❌ 구독 적용 실패:', e);
    return res.status(500).json({ error: '결제는 됐으나 구독 처리에 실패했습니다. 관리자에 문의해주세요.' });
  }

  console.log(`✅ 구독 시작: uid=${uid}, tier=${tier}, amount=${plan.amount}`);
  res.json({ ok: true, tier, amount: plan.amount, orderId });
});

// === 2) 정기결제 1건 처리 (cron 전용) ===
router.post('/subscription/charge', async (req, res) => {
  const { uid, internalKey } = req.body;
  if (internalKey !== process.env.CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
  if (!uid) return res.status(400).json({ error: 'uid required' });

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

  const cycleTs = now;
  const orderId = buildOrderId(uid, cycleTs);

  // 멱등성: 같은 사이클 시작 ms 기준 orderId 중복이면 즉시 반환
  const orderSnap = await db.collection('subscriptionOrders').doc(orderId).get();
  if (orderSnap.exists) return res.json({ ok: true, deduped: true });

  let charged = await tossChargeBilling({
    billingKey: sub.billingKey,
    customerKey: sub.customerKey,
    amount: plan.amount,
    orderId,
    orderName: plan.name
  });

  // 카드사 일시 오류 대비 1회 재시도 (1.5초 후)
  if (!charged.ok) {
    console.warn(`⚠️ 정기결제 1차 실패 → 재시도 uid=${uid}:`, charged.data?.code);
    await new Promise(r => setTimeout(r, 1500));
    charged = await tossChargeBilling({
      billingKey: sub.billingKey,
      customerKey: sub.customerKey,
      amount: plan.amount,
      orderId,
      orderName: plan.name
    });
  }

  if (!charged.ok) {
    console.error(`❌ 정기결제 최종 실패 uid=${uid}:`, charged.data);
    await userRef.update({
      'subscription.status': 'past_due',
      'plan': 'free'
    });
    await db.collection('subscriptionOrders').doc(orderId).set({
      uid, tier: sub.tier,
      amount: plan.amount,
      orderId,
      status: 'failed',
      billingKey: sub.billingKey,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      failReason: charged.data.message || 'unknown'
    });
    return res.status(charged.status).json({ error: '정기결제 실패' });
  }

  try {
    await applySubscriptionCycle({
      uid, tier: sub.tier, plan,
      paymentResult: { paymentKey: charged.data.paymentKey, orderId },
      billingKey: sub.billingKey,
      cardCompany: sub.cardCompany, cardNumber: sub.cardNumber,
      customerKey: sub.customerKey, isFirst: false
    });
  } catch (e) {
    if (e.message === 'DUPLICATE_ORDER') return res.json({ ok: true, deduped: true });
    console.error('❌ 사이클 적용 실패:', e);
    return res.status(500).json({ error: '사이클 적용 실패' });
  }

  console.log(`🔁 정기결제 성공: uid=${uid}, tier=${sub.tier}`);
  res.json({ ok: true, orderId });
});

// === 3) 매시간 cron 진입점 핵심 로직 ===
async function runProcessDue(internalKey) {
  const now = admin.firestore.Timestamp.now();
  const results = { processed: 0, charged: 0, failed: 0, expired: 0 };

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
      console.error('cron charge fail:', doc.id, e);
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
    if (sub?.billingKey) await tossDeleteBillingKey(sub.billingKey);
    batch.update(doc.ref, {
      'subscription.status': 'expired',
      'subscription.billingKey': null,
      'plan': 'free',
      'coupon.remaining': 0
    });
    results.expired++;
  }
  if (results.expired) await batch.commit();

  console.log(`🕐 cron 결과: ${JSON.stringify(results)}`);
  return results;
}

// POST 진입점 (기존 호환)
router.post('/subscription/process-due', async (req, res) => {
  const { internalKey } = req.body;
  if (internalKey !== process.env.CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
  try {
    const results = await runProcessDue(internalKey);
    res.json({ ok: true, ...results });
  } catch (e) {
    console.error('❌ process-due fail:', e?.message, e?.stack);
    res.status(500).json({ error: 'process-due failed', detail: e?.message || String(e) });
  }
});

// GET 진입점 (Render Cron Job 셸 인용 회피용 — 쿼리스트링 인증)
router.get('/subscription/process-due', async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
  try {
    const results = await runProcessDue(key);
    res.json({ ok: true, ...results });
  } catch (e) {
    console.error('❌ process-due fail:', e?.message, e?.stack);
    res.status(500).json({ error: 'process-due failed', detail: e?.message || String(e) });
  }
});

// === 4) 사용자 취소 ===
router.post('/subscription/cancel', async (req, res) => {
  const { idToken } = req.body;
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });

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

  console.log(`🛑 구독 취소: uid=${uid}, tier=${sub.tier}`);
  res.json({ ok: true, message: '구독이 취소되었습니다. 다음 결제일까지 사용 가능합니다.' });
});

// === 5) 사용자 재개 ===
router.post('/subscription/resume', async (req, res) => {
  const { idToken } = req.body;
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });

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

  res.json({ ok: true, message: '구독이 재개되었습니다.' });
});

// === 6) 상태 조회 ===
router.get('/subscription/status', async (req, res) => {
  const idToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.idToken;
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return res.json({ ok: true, subscription: null, coupon: null });

  const d = snap.data();
  res.json({ ok: true, subscription: d.subscription || null, coupon: d.coupon || null, plan: d.plan || 'free' });
});

// === 7) 토스 웹훅 ===
// 토스는 10초 내 200 응답 필수. 이벤트 처리는 응답 후 비동기로 진행.
// 등록 URL: https://ai-backend-3xtk.onrender.com/toss/webhook
// 구독 이벤트: PAYMENT_STATUS_CHANGED, BILLING_DELETED, CANCEL_STATUS_CHANGED
router.post('/toss/webhook', async (req, res) => {
  res.status(200).send('OK');

  const { eventType, data } = req.body || {};
  console.log(`📨 toss webhook: ${eventType}`);

  try {
    if (eventType === 'PAYMENT_STATUS_CHANGED') {
      const { orderId, status, paymentKey } = data || {};
      if (!orderId) return;
      const orderRef = db.collection('subscriptionOrders').doc(orderId);
      const snap = await orderRef.get();
      if (!snap.exists) return;
      await orderRef.update({
        webhookStatus: status,
        webhookPaymentKey: paymentKey || null,
        webhookUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // 외부에서 결제가 취소/만료된 경우 사용자 구독 정리
      if (status === 'CANCELED' || status === 'ABORTED' || status === 'EXPIRED') {
        const order = snap.data();
        if (order.uid) {
          await db.collection('users').doc(order.uid).update({
            'subscription.status': 'refunded',
            'plan': 'free'
          });
        }
      }
    } else if (eventType === 'BILLING_DELETED') {
      const { billingKey } = data || {};
      if (!billingKey) return;
      const found = await db.collection('users')
        .where('subscription.billingKey', '==', billingKey)
        .limit(1).get();
      if (!found.empty) {
        await found.docs[0].ref.update({
          'subscription.status': 'cancelled',
          'subscription.billingKey': null,
          'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
          'subscription.billingKeyDeleted': true
        });
      }
    } else if (eventType === 'CANCEL_STATUS_CHANGED') {
      const { paymentKey, cancelStatus } = data || {};
      if (!paymentKey) return;
      await db.collection('webhookLogs').add({
        eventType, paymentKey, cancelStatus,
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (e) {
    console.error('webhook handler fail:', e);
  }
});

module.exports = router;
