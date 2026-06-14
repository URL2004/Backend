// [결제] 토스페이먼츠 결제 확인 + Firebase 크레딧 지급 처리

const express = require('express');
const { admin, db, ADMIN_UIDS, verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const { getRevenue } = require('../lib/revenue');

const router = express.Router();

function tossBasicToken(res) {
  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) {
    logger.error('payment.toss_secret_missing');
    if (res) res.status(503).json({ error: '결제 서버 설정이 완료되지 않았습니다.' });
    return null;
  }
  return Buffer.from(secretKey + ':').toString('base64');
}

router.post('/confirm-payment', async (req, res) => {
  const { paymentKey, orderId, amount, customerEmail, uid, idToken } = req.body;

  // 서버에서 금액 기준으로 크레딧 직접 계산
  const CREDIT_MAP = { 2900: 100, 8700: 330, 14500: 600, 29000: 1300, 58000: 2700 };
  const safeCredits = CREDIT_MAP[parseInt(amount)];
  if (!safeCredits) {
    return res.status(400).json({ error: "유효하지 않은 결제 금액입니다." });
  }

  // Firebase ID Token 필수 검증 — fallback 없음
  if (!idToken) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  let verifiedUid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    verifiedUid = decoded.uid;
    setLogContext({ uid: verifiedUid });
  } catch (e) {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인 후 결제를 완료해주세요.' });
  }
  if (uid && uid !== verifiedUid) {
    logger.warn('payment.uid_mismatch_blocked', { clientUid: uid, verifiedUid, orderId, amount });
    return res.status(403).json({ error: '사용자 정보가 일치하지 않습니다.' });
  }

  const basicToken = tossBasicToken(res);
  if (!basicToken) return;

  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ paymentKey, orderId, amount })
    });

    const result = await response.json();

    if (response.ok) {
      // 단일 트랜잭션으로 orders + credits + creditHistory 원자적 처리
      const orderRef = db.collection('orders').doc(orderId);
      const userRef = db.collection('users').doc(verifiedUid);

      try {
        await db.runTransaction(async (transaction) => {
          // === 모든 READ 먼저 ===
          const orderSnap = await transaction.get(orderRef);
          if (orderSnap.exists) {
            throw new Error('이미 처리된 결제입니다.');
          }
          const userSnap = await transaction.get(userRef);
          const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
          const newCredits = currentCredits + safeCredits;

          // === 모든 WRITE 후 ===
          transaction.set(orderRef, {
            uid: verifiedUid, amount, safeCredits,
            paymentKey,
            status: 'paid',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          if (userSnap.exists) {
            transaction.update(userRef, {
              credits: newCredits,
              lastPayment: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            transaction.set(userRef, {
              credits: newCredits,
              lastPayment: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          const historyRef = db.collection('users').doc(verifiedUid)
            .collection('creditHistory').doc();
          transaction.set(historyRef, {
            type: 'charge', used: 0, amount: safeCredits,
            remaining: newCredits, plan: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });

        logger.info('payment.confirmed', {
          uid: verifiedUid,
          orderId,
          amount: parseInt(amount, 10),
          credits: safeCredits,
          customerEmail
        });
        discord.paymentDone({ uid: verifiedUid, amount: parseInt(amount, 10), credits: safeCredits, kind: '크레딧 충전', name: customerEmail });
        res.json({ ok: true, message: "충전 성공", creditAmount: safeCredits });
      } catch (e) {
        if (e.message === '이미 처리된 결제입니다.') {
          logger.warn('payment.duplicate_confirm_blocked', { uid: verifiedUid, orderId, amount: parseInt(amount, 10) });
          return res.status(400).json({ error: "이미 처리된 결제입니다." });
        }
        throw e;
      }
    } else {
      logger.warn('payment.toss_confirm_failed', { uid: verifiedUid, orderId, amount: parseInt(amount, 10), status: response.status, toss: result });
      res.status(response.status).json(result);
    }
  } catch (err) {
    logger.error('payment.confirm_failed', { uid: verifiedUid, orderId, amount: parseInt(amount, 10), err });
    res.status(500).json({ error: '서버 에러 발생' });
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
    used: Number(h.used) || 0,
    amount: Number(h.amount) || 0,
    remaining: Number(h.remaining) || 0,
    plan: h.plan || null,
    orderId: h.orderId || null,
    detail: h.detail || '',
    adminUid: h.adminUid || null,
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
    safeCredits: Number(o.safeCredits) || 0,
    tier: o.tier || null,
    paymentKey: o.paymentKey ? 'present' : null,
    cancelReason: o.cancelReason || '',
    rejectReason: o.rejectReason || '',
    refundAmount: Number(o.refundAmount) || 0,
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

  const [creditSnap, subSnap, histSnap] = await Promise.all([
    db.collection('orders').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(30).get(),
    db.collection('subscriptionOrders').where('uid', '==', uid).limit(30).get(),
    userRef.collection('creditHistory').orderBy('createdAt', 'desc').limit(30).get()
  ]);

  const orders = [
    ...creditSnap.docs.map(d => serializeOrderDoc(d, 'order')),
    ...subSnap.docs.map(d => serializeOrderDoc(d, 'subscription'))
  ];
  orders.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

  const userByUid = { [uid]: userSnap.data() || {} };
  const creditHistory = histSnap.docs.map(d => serializeCreditHistoryDoc(d, userByUid));

  return {
    user: serializeUserDoc(userSnap),
    orders,
    creditHistory
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

async function processRefund({ orderRef, orderSnap, kind, adminUid, reason, mode, customAmount }) {
  const order = orderSnap.data();
  if (!['paid', 'refund_requested', 'refund_rejected'].includes(order.status)) {
    throw Object.assign(new Error('환불할 수 없는 주문 상태입니다. 현재: ' + order.status), { status: 400 });
  }
  if (!order.paymentKey) {
    throw Object.assign(new Error('paymentKey가 없어 환불할 수 없습니다. (이전 결제건)'), { status: 400 });
  }

  const userRef = db.collection('users').doc(order.uid);
  const basicToken = tossBasicToken();
  if (!basicToken) {
    throw Object.assign(new Error('결제 서버 설정이 완료되지 않았습니다.'), { status: 503, code: 'TOSS_SECRET_MISSING' });
  }
  const tossUrl = `https://api.tosspayments.com/v1/payments/${order.paymentKey}/cancel`;
  const cancelReason = String(reason || order.cancelReason || '관리자 직접 환불').trim();

  if (kind === 'subscription') {
    const tossRes = await fetch(tossUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicToken}`, 'Content-Type': 'application/json' },
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
      t.set(userRef.collection('couponHistory').doc(), {
        type: 'refund',
        tier: order.tier,
        amount: 0,
        remaining: 0,
        orderId: orderRef.id,
        detail: '관리자 직접 환불',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return {
      refundAmount: Number(order.amount) || 0,
      refundedCredits: 0,
      message: '정기결제 환불이 완료되었습니다.'
    };
  }

  const orderAmount = parseInt(order.amount, 10);
  const safeCreditsTotal = parseInt(order.safeCredits, 10);
  if (!Number.isFinite(orderAmount) || orderAmount <= 0 ||
      !Number.isFinite(safeCreditsTotal) || safeCreditsTotal <= 0) {
    throw Object.assign(new Error('주문 데이터가 올바르지 않아 환불 계산이 불가합니다.'), { status: 400 });
  }

  // 환불 모드: 'remaining'(미사용분 비례·기본) | 'full'(전액) | 'custom'(금액 직접 입력)
  const refundMode = ['remaining', 'full', 'custom'].includes(mode) ? mode : 'remaining';
  const reqAmount = parseInt(customAmount, 10);
  if (refundMode === 'custom' && (!Number.isFinite(reqAmount) || reqAmount <= 0 || reqAmount > orderAmount)) {
    throw Object.assign(new Error(`직접 입력 환불 금액은 1원 이상 결제금액(${orderAmount.toLocaleString('ko-KR')}원) 이하여야 합니다.`), { status: 400 });
  }

  let refundAmount, refundableCredits;
  try {
    const result = await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const currentCredits = userSnap.exists ? (Number(userSnap.data().credits) || 0) : 0;
      const usableCredits = Math.min(currentCredits, safeCreditsTotal); // 음수 방지: 이 주문 크레딧·현재 잔액 한도

      let amount, creditsToDeduct;
      if (refundMode === 'full') {
        // 전액 환불: 결제금액 전부 환불, 크레딧은 가능한 만큼만 차감(이미 쓴 분은 재차감 안 함)
        amount = orderAmount;
        creditsToDeduct = usableCredits;
      } else if (refundMode === 'custom') {
        // 직접 입력: 입력 금액 환불, 크레딧은 금액 비례로 차감(잔액 한도 내)
        amount = reqAmount;
        creditsToDeduct = Math.min(usableCredits, Math.floor(safeCreditsTotal * amount / orderAmount));
      } else {
        // 남은건 환불(기본): 미사용 크레딧 비례
        if (usableCredits <= 0) throw new Error('NO_REFUNDABLE');
        amount = Math.floor(orderAmount * usableCredits / safeCreditsTotal);
        creditsToDeduct = usableCredits;
      }
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
      transaction.update(userRef, { credits: currentCredits - creditsToDeduct });
      transaction.update(orderRef, {
        cancelReason,
        refundMode,
        refundAmount: amount,
        refundedCredits: creditsToDeduct
      });
      return { refundAmount: amount, refundableCredits: creditsToDeduct };
    });
    refundAmount = result.refundAmount;
    refundableCredits = result.refundableCredits;
  } catch (e) {
    if (e.message === 'NO_REFUNDABLE') {
      throw Object.assign(new Error('이미 모든 크레딧을 사용해 환불 가능 금액이 없습니다. (전액/직접입력 모드를 사용하세요)'), { status: 400 });
    }
    if (e.message === 'INVALID_AMOUNT') {
      throw Object.assign(new Error('환불 금액 계산 오류'), { status: 400 });
    }
    throw e;
  }

  const tossRes = await fetch(tossUrl, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basicToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelReason, cancelAmount: refundAmount })
  });
  const tossResult = await tossRes.json();
  if (!tossRes.ok) {
    try {
      await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const currentCredits = userSnap.exists ? (Number(userSnap.data().credits) || 0) : 0;
        transaction.update(userRef, { credits: currentCredits + refundableCredits });
        transaction.update(orderRef, {
          refundAmount: admin.firestore.FieldValue.delete(),
          refundedCredits: admin.firestore.FieldValue.delete()
        });
      });
    } catch (compErr) {
      logger.error('refund.compensation_failed_manual_action', {
        orderId: orderRef.id, uid: order.uid, refundableCredits, refundAmount, compErr
      });
    }
    throw Object.assign(new Error('토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')), {
      status: tossRes.status,
      toss: tossResult
    });
  }

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const remainingCredits = userSnap.exists ? (Number(userSnap.data().credits) || 0) : 0;
    transaction.update(orderRef, {
      status: 'refunded',
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundedBy: adminUid
    });
    transaction.set(userRef.collection('creditHistory').doc(), {
      type: 'refund',
      used: 0,
      amount: -refundableCredits,
      remaining: remainingCredits,
      orderId: orderRef.id,
      detail: '관리자 직접 환불',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return {
    refundAmount,
    refundedCredits: refundableCredits,
    message: '크레딧 결제 미사용분 환불이 완료되었습니다.'
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
    logger.info('admin.user_summary_loaded', { adminUid, targetUid: uid });
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
    const result = await db.runTransaction(async (t) => {
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
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('admin.direct_refund_failed', { adminUid, orderId, kind, err });
    res.status(500).json({ error: '환불 처리에 실패했습니다.' });
  }
});

const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// 무료 보너스(회원가입 10 + 추천 20×N)는 결제 크레딧보다 먼저 소진된다고 가정.
// → 지갑에 남은 크레딧은 모두 결제분으로 간주하고 주문 크레딧 수만큼만 cap.

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

    // 정기결제 환불 자격: 결제일 7일 이내 + 이번 사이클 쿠폰 미사용
    if (kind === 'subscription') {
      const approvedMs = order.approvedAt?.toMillis ? order.approvedAt.toMillis()
        : (order.requestedAt?.toMillis ? order.requestedAt.toMillis() : 0);
      if (!approvedMs || Date.now() - approvedMs > REFUND_WINDOW_MS) {
        return res.status(400).json({ error: '결제일로부터 7일이 지나 환불할 수 없습니다.' });
      }
      // 사용자 doc에서 현재 사이클 쿠폰 사용 여부 확인
      const userSnap = await db.collection('users').doc(uid).get();
      const coupon = userSnap.exists ? userSnap.data().coupon : null;
      const sub = userSnap.exists ? userSnap.data().subscription : null;
      const subCycleMs = sub?.cycleStartedAt?.toMillis ? sub.cycleStartedAt.toMillis() : 0;
      // 환불하려는 결제가 "현재 사이클"에 해당하는 경우에만 미사용 검증
      if (subCycleMs && Math.abs(subCycleMs - approvedMs) < 60 * 1000) {
        const used = coupon?.used || 0;
        if (used > 0) {
          return res.status(400).json({ error: '이번 사이클 쿠폰을 이미 사용해 환불할 수 없습니다.' });
        }
      } else {
        // 과거 사이클 결제는 환불 불가 (해당 사이클 사용 여부를 더 이상 추적할 수 없음)
        return res.status(400).json({ error: '과거 사이클의 정기결제는 환불할 수 없습니다.' });
      }
    } else {
      // 크레딧 환불: 잔액이 0이면 신청 차단
      const userSnap = await db.collection('users').doc(uid).get();
      const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
      const refundableCredits = Math.min(currentCredits, parseInt(order.safeCredits) || 0);
      if (refundableCredits <= 0) {
        return res.status(400).json({ error: '이미 모든 크레딧을 사용해 환불 가능 금액이 없습니다.' });
      }
    }

    await orderRef.update({
      status: 'refund_requested',
      cancelReason: cancelReason.trim(),
      kind,
      refundRequestedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info('refund.requested', {
      uid,
      orderId,
      kind,
      reasonLength: cancelReason.trim().length
    });
    discord.refundRequest({ uid, amount: order.amount, credits: order.safeCredits, reason: cancelReason.trim(), name: order.customerEmail });
    res.json({ ok: true, message: '환불 요청이 접수되었습니다.' });
  } catch (err) {
    logger.error('refund.request_failed', { uid, orderId, kind, err });
    res.status(500).json({ error: '서버 에러 발생' });
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
    if (order.status !== 'refund_requested') {
      return res.status(400).json({ error: '환불 요청 상태가 아닙니다. 현재: ' + order.status });
    }
    if (!order.paymentKey) {
      return res.status(400).json({ error: 'paymentKey가 없어 환불할 수 없습니다. (이전 결제건)' });
    }

    const userRef = db.collection('users').doc(order.uid);
    const basicToken = tossBasicToken(res);
    if (!basicToken) return;
    const tossUrl = `https://api.tosspayments.com/v1/payments/${order.paymentKey}/cancel`;

    if (kind === 'subscription') {
      // 정기결제: 전액 취소
      const tossRes = await fetch(tossUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basicToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelReason: order.cancelReason || '고객 요청 환불' })
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
          status: 'refunded',
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
        const histRef = userRef.collection('couponHistory').doc();
        t.set(histRef, {
          type: 'refund', tier: order.tier, amount: 0, remaining: 0,
          orderId, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      logger.info('refund.subscription_approved', { orderId, uid: order.uid, adminUid, tier: order.tier });
      return res.json({ ok: true, message: '환불이 완료되었습니다.' });
    }

    // 크레딧 부분환불: 토스 호출 전에 트랜잭션으로 선차감 → 토스 → 확정/보상
    const orderAmount = parseInt(order.amount);
    const safeCreditsTotal = parseInt(order.safeCredits);
    if (!Number.isFinite(orderAmount) || orderAmount <= 0 ||
        !Number.isFinite(safeCreditsTotal) || safeCreditsTotal <= 0) {
      return res.status(400).json({ error: '주문 데이터가 올바르지 않아 환불 계산이 불가합니다.' });
    }
    let refundAmount, refundableCredits;
    try {
      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
        const refundable = Math.min(currentCredits, safeCreditsTotal);
        if (refundable <= 0) throw new Error('NO_REFUNDABLE');
        const amount = Math.floor(orderAmount * refundable / safeCreditsTotal);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
        transaction.update(userRef, { credits: currentCredits - refundable });
        transaction.update(orderRef, {
          refundAmount: amount,
          refundedCredits: refundable
        });
        return { refundAmount: amount, refundableCredits: refundable };
      });
      refundAmount = result.refundAmount;
      refundableCredits = result.refundableCredits;
    } catch (e) {
      if (e.message === 'NO_REFUNDABLE') {
        return res.status(400).json({ error: '이미 모든 크레딧을 사용해 환불 가능 금액이 없습니다.' });
      }
      if (e.message === 'INVALID_AMOUNT') {
        return res.status(400).json({ error: '환불 금액 계산 오류' });
      }
      throw e;
    }

    const tossRes = await fetch(tossUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cancelReason: order.cancelReason || '고객 요청 환불',
        cancelAmount: refundAmount
      })
    });
    const tossResult = await tossRes.json();

    if (!tossRes.ok) {
      // 보상: 선차감한 크레딧 복구 + 임시 필드 제거
      try {
        await db.runTransaction(async (transaction) => {
          const userSnap = await transaction.get(userRef);
          const currentCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
          transaction.update(userRef, { credits: currentCredits + refundableCredits });
          transaction.update(orderRef, {
            refundAmount: admin.firestore.FieldValue.delete(),
            refundedCredits: admin.firestore.FieldValue.delete()
          });
        });
      } catch (compErr) {
        logger.error('refund.compensation_failed_manual_action', {
          orderId, uid: order.uid, refundableCredits, refundAmount, compErr
        });
      }
      logger.error('refund.toss_cancel_failed', { orderId, kind, uid: order.uid, status: tossRes.status, toss: tossResult });
      return res.status(tossRes.status).json({
        error: '토스 환불 처리 실패: ' + (tossResult.message || '알 수 없는 오류')
      });
    }

    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const remainingCredits = userSnap.exists ? (userSnap.data().credits || 0) : 0;
      transaction.update(orderRef, {
        status: 'refunded',
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundedBy: adminUid
      });
      const historyRef = db.collection('users').doc(order.uid).collection('creditHistory').doc();
      transaction.set(historyRef, {
        type: 'refund',
        used: 0,
        amount: -refundableCredits,
        remaining: remainingCredits,
        orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    logger.info('refund.credit_approved', {
      orderId,
      uid: order.uid,
      adminUid,
      refundableCredits,
      refundAmount
    });
    res.json({ ok: true, message: '환불이 완료되었습니다.' });
  } catch (err) {
    logger.error('refund.approve_failed', { orderId, kind, adminUid, err });
    res.status(500).json({ error: '서버 에러 발생' });
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
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

    const order = orderSnap.data();
    if (order.status !== 'refund_requested') {
      return res.status(400).json({ error: '환불 요청 상태가 아닙니다. 현재: ' + order.status });
    }

    await orderRef.update({
      status: 'refund_rejected',
      rejectReason: rejectReason.trim(),
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectedBy: adminUid
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
    res.status(500).json({ error: '서버 에러 발생' });
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

    // 4. 추천인 찾기
    const referrerSnap = await db.collection('users').where('refCode', '==', refCode).limit(1).get();
    if (referrerSnap.empty) return res.status(400).json({ error: '유효하지 않은 추천 코드' });
    const referrerDoc = referrerSnap.docs[0];
    const referrerUid = referrerDoc.id;

    // 5. 양쪽에 20크레딧 지급 (트랜잭션)
    await db.runTransaction(async (t) => {
      t.update(db.collection('users').doc(newUid), {
        credits: admin.firestore.FieldValue.increment(20),
        referredBy: refCode
      });
      t.update(db.collection('users').doc(referrerUid), {
        credits: admin.firestore.FieldValue.increment(20)
      });
    });

    // 6. 크레딧 히스토리 기록
    const now = admin.firestore.FieldValue.serverTimestamp();
    const newUserCredits = (newUserSnap.data().credits || 0) + 20;
    const referrerCredits = (referrerDoc.data().credits || 0) + 20;

    await db.collection('users').doc(newUid).collection('creditHistory').add({
      type: 'referral', used: 0, amount: 20, remaining: newUserCredits,
      detail: '친구 추천 보상 (가입)', createdAt: now
    });
    await db.collection('users').doc(referrerUid).collection('creditHistory').add({
      type: 'referral', used: 0, amount: 20, remaining: referrerCredits,
      detail: '친구 추천 보상 (초대)', createdAt: now
    });

    logger.info('referral.applied', { referrerUid, newUid, credits: 20 });
    discord.referral({ inviter: referrerDoc.data().name || referrerUid, invitee: newUserSnap.data().name || newUid });
    res.json({ ok: true });
  } catch (err) {
    logger.error('referral.failed', { err });
    res.status(500).json({ error: '추천 처리 실패' });
  }
});

module.exports = router;
