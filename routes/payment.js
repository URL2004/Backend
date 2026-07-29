// [결제] 토스페이먼츠 결제 확인 + Firebase 크레딧 지급 처리

const express = require('express');
const { admin, db, ADMIN_UIDS, verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const { getRevenue } = require('../lib/revenue');
const detectCalibration = require('../lib/detectCalibration');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { buildHumanizeQualityReport } = require('../lib/humanizeQualityReport');
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

router.post('/confirm-payment', async (req, res) => {
  const { paymentKey, orderId, amount, customerEmail, uid, idToken } = req.body;

  // 서버에서 금액 기준으로 크레딧 직접 계산
  const CREDIT_MAP = { 2900: 110, 8700: 330, 14500: 600, 29000: 1300, 58000: 2700 };
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
            paymentKeyPresent: true,   // ★ C-04: paymentKey 원문은 사용자가 읽는 주문 문서가 아니라 서버전용으로 분리
            customerEmail: typeof customerEmail === 'string' ? customerEmail.slice(0, 160) : '',
            status: 'paid',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          // ★ C-04: 결제 운영키(paymentKey)는 Rules deny-all인 paymentSecrets에 보관 — 환불 시 서버가 읽는다.
          transaction.set(db.collection('paymentSecrets').doc(orderId), {
            paymentKey, uid: verifiedUid, createdAt: admin.firestore.FieldValue.serverTimestamp()
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
  const ledgerDelta = sortedCreditHistory.reduce((sum, h) => sum + auditNumber(h.amount) - auditNumber(h.used), 0);
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
  return (order && order.paymentKey) || null;
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

  // 환불 모드: 'remaining'(미사용분 비례·기본) | 'full'(잔액 전부) | 'custom'(금액 직접 입력)
  // 누적 부분환불 지원: 이미 환불된 금액/크레딧을 빼고 "남은 잔액" 기준으로 계산한다.
  const refundMode = ['remaining', 'full', 'custom'].includes(mode) ? mode : 'remaining';
  const priorRefundedAmount = Number(order.refundedAmount) || 0;
  const priorRefundedCredits = Number(order.refundedCredits) || 0;
  const remainingMoney = orderAmount - priorRefundedAmount;          // 추가로 환불 가능한 결제 잔액
  const remainingOrderCredits = Math.max(0, safeCreditsTotal - priorRefundedCredits);
  if (remainingMoney <= 0) {
    throw Object.assign(new Error('이미 전액 환불된 주문입니다.'), { status: 400 });
  }
  const reqAmount = parseInt(customAmount, 10);
  if (refundMode === 'custom' && (!Number.isFinite(reqAmount) || reqAmount <= 0 || reqAmount > remainingMoney)) {
    throw Object.assign(new Error(`직접 입력 환불 금액은 1원 이상 환불 가능액(${remainingMoney.toLocaleString('ko-KR')}원) 이하여야 합니다.`), { status: 400 });
  }

  let refundAmount, refundableCredits, willBeFullyRefunded;
  try {
    const result = await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const currentCredits = userSnap.exists ? (Number(userSnap.data().credits) || 0) : 0;
      const usableCredits = Math.min(currentCredits, remainingOrderCredits); // 음수 방지: 남은 주문 크레딧·현재 잔액 한도

      let amount, creditsToDeduct;
      if (refundMode === 'full') {
        // 전액(잔액) 환불: 남은 결제 잔액 전부 환불, 크레딧은 가능한 만큼만 차감
        amount = remainingMoney;
        creditsToDeduct = usableCredits;
      } else if (refundMode === 'custom') {
        // 직접 입력: 입력 금액 환불, 크레딧은 금액 비례로 차감(잔액 한도 내)
        amount = reqAmount;
        creditsToDeduct = Math.min(usableCredits, Math.floor(safeCreditsTotal * amount / orderAmount));
      } else {
        // 남은건 환불(기본): 미사용 크레딧 비례 (남은 잔액으로 cap)
        if (usableCredits <= 0) throw new Error('NO_REFUNDABLE');
        amount = Math.min(remainingMoney, Math.floor(orderAmount * usableCredits / safeCreditsTotal));
        creditsToDeduct = usableCredits;
      }
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');

      const newRefundedAmount = priorRefundedAmount + amount;
      const newRefundedCredits = priorRefundedCredits + creditsToDeduct;
      transaction.update(userRef, { credits: currentCredits - creditsToDeduct });
      transaction.update(orderRef, {
        cancelReason,
        refundMode,
        refundAmount: newRefundedAmount,    // 누적(레거시 표시 호환)
        refundedAmount: newRefundedAmount,  // 누적 환불 금액
        refundedCredits: newRefundedCredits // 누적 환불 크레딧
      });
      return { amount, creditsToDeduct, fully: newRefundedAmount >= orderAmount };
    });
    refundAmount = result.amount;
    refundableCredits = result.creditsToDeduct;
    willBeFullyRefunded = result.fully;
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
        // 이번 회차분만 되돌린다 — 이전 누적 부분환불 기록은 보존
        transaction.update(orderRef, {
          refundAmount: priorRefundedAmount > 0 ? priorRefundedAmount : admin.firestore.FieldValue.delete(),
          refundedAmount: priorRefundedAmount > 0 ? priorRefundedAmount : admin.firestore.FieldValue.delete(),
          refundedCredits: priorRefundedCredits > 0 ? priorRefundedCredits : admin.firestore.FieldValue.delete()
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
      status: willBeFullyRefunded ? 'refunded' : 'partially_refunded',
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundedBy: adminUid
    });
    transaction.set(userRef.collection('creditHistory').doc(), {
      type: 'refund',
      used: 0,
      amount: -refundableCredits,
      remaining: remainingCredits,
      orderId: orderRef.id,
      detail: willBeFullyRefunded ? '관리자 직접 환불' : '관리자 부분 환불',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return {
    refundAmount,
    refundedCredits: refundableCredits,
    fullyRefunded: willBeFullyRefunded,
    message: willBeFullyRefunded ? '크레딧 결제 환불이 완료되었습니다.' : '부분 환불이 완료되었습니다.'
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
    createdAtMs: Number(j.createdAt) || timestampMs(j.createdAt),
    updatedAtMs: Number(j.updatedAtMs) || 0,
    processingDurationMs: finiteOrNull(j.processingDurationMs),
    totalDurationMs: finiteOrNull(j.totalDurationMs),
    textLength: Number(j.textLength) || 0,
    resultLength: Number(j.resultLength) || 0,
    candidatesCount: Number(j.candidatesCount) || 0,
    error: j.error || '',
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
    semanticJudgeRan: j.semanticJudgeRan === true,
    humanizationDepthApplicable: j.humanizationDepthApplicable === true,
    humanizationDepthPass: typeof j.humanizationDepthPass === 'boolean' ? j.humanizationDepthPass : null,
    humanizationMinimumEffectPass: typeof j.humanizationMinimumEffectPass === 'boolean' ? j.humanizationMinimumEffectPass : null,
    humanizationDepthSoftDelivered: j.humanizationDepthSoftDelivered === true,
    humanizationNoBenefitDelivered: j.humanizationNoBenefitDelivered === true,
    humanizationNoEffectRetryAttemptCount: finiteOrNull(j.humanizationNoEffectRetryAttemptCount),
    humanizationDeliveryDepthBand: j.humanizationDeliveryDepthBand || '',
    humanizationTargetDepthMet: typeof j.humanizationTargetDepthMet === 'boolean'
      ? j.humanizationTargetDepthMet
      : null,
    humanizationTargetDepthGap: finiteOrNull(j.humanizationTargetDepthGap),
    substantiveEditRatio: finiteOrNull(j.substantiveEditRatio),
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
    quoteContentChangedCount: finiteOrNull(j.quoteContentChangedCount),
    quoteIntegrityRestoreCount: finiteOrNull(j.quoteIntegrityRestoreCount),
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

    const result = await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const debitSnap = await t.get(debitRef);
      const restoreSnap = action === 'restore' ? await t.get(restoreRef) : null;
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
        !!debit.resolveCreditHistoryId ||
        !!(restoreSnap && restoreSnap.exists);
      const current = auditNumber(userSnap.data().credits);
      const used = auditNumber(debit.used);
      if (alreadyHandled) {
        return {
          alreadyHandled: true,
          before: current,
          after: current,
          restoredCredits: auditNumber(debit.restoredCredits) || used,
          resolveCreditHistoryId: debit.restoreCreditHistoryId || debit.resolveCreditHistoryId || (restoreSnap && restoreSnap.exists ? restoreRef.id : null)
        };
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      if (action === 'restore') {
        const next = current + used;
        t.update(userRef, {
          credits: next,
          lastAdminOrphanDebitResolvedAt: now
        });
        t.set(restoreRef, {
          type: `${debit.type}_restore`,
          used: -used,
          amount: 0,
          remaining: next,
          ...(debit.mode ? { mode: String(debit.mode) } : {}),
          ...(debit.evidence != null ? { evidence: !!debit.evidence } : {}),
          ...(debit.fallback ? { fallback: true } : {}),
          ...(debit.requestId ? { requestId: debit.requestId } : {}),
          detail: reason,
          adminUid,
          originalType: debit.type,
          originalCreditHistoryId: creditHistoryId,
          restoredDebitId: creditHistoryId,
          orphanDebitResolved: true,
          orphanDebitResolution: 'credit_restore',
          createdAt: now
        });
        t.update(debitRef, {
          orphanDebitResolved: true,
          orphanDebitResolution: 'credit_restore',
          restoredCredits: used,
          restoreCreditHistoryId: restoreRef.id,
          restoredAt: now,
          restoredBy: adminUid,
          restoreReason: reason
        });
        return {
          alreadyHandled: false,
          before: current,
          after: next,
          restoredCredits: used,
          resolveCreditHistoryId: restoreRef.id
        };
      }

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
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('admin.direct_refund_failed', { adminUid, orderId, kind, err });
    res.status(500).json({ error: '환불 처리에 실패했습니다.' });
  }
});

const REFUND_POLICY_VERSION = '2026-07-20';
const REFUND_WINDOW_DAYS = 7;
const REFUND_WINDOW_MS = REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const UNLIMITED_REFUND_SETTLEMENT_USES = 50;
// 무료 보너스(회원가입 10 + 추천 20×N)는 결제 크레딧보다 먼저 소진된다고 가정.
// → 지갑에 남은 크레딧은 모두 결제분으로 간주하고 주문 크레딧 수만큼만 cap.

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

function calculateCreditPolicyRefund({ orderAmount, purchasedCredits, currentCredits }) {
  const amount = Math.max(0, Math.floor(Number(orderAmount) || 0));
  const purchased = Math.max(0, Math.floor(Number(purchasedCredits) || 0));
  const balance = Math.max(0, Math.floor(Number(currentCredits) || 0));
  const refundableCredits = Math.min(balance, purchased);
  const usedCredits = Math.max(0, purchased - refundableCredits);
  const refundAmount = purchased > 0
    ? Math.min(amount, Math.floor(amount * refundableCredits / purchased))
    : 0;
  return { refundAmount, refundableCredits, usedCredits, purchasedCredits: purchased };
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
    } else {
      const calculation = calculateCreditPolicyRefund({
        orderAmount: order.amount,
        purchasedCredits: order.safeCredits,
        currentCredits: user.credits
      });
      if (calculation.refundAmount <= 0 || calculation.refundableCredits <= 0) {
        return res.status(400).json({
          error: '구매한 크레딧을 모두 사용해 일반 환불 가능 금액이 없습니다. 서비스 오류는 고객센터로 문의해주세요.',
          code: 'NO_REFUNDABLE_CREDITS'
        });
      }
      policySnapshot = {
        requestedRefundAmount: calculation.refundAmount,
        requestedRefundCredits: calculation.refundableCredits,
        refundUsedCredits: calculation.usedCredits
      };
    }

    await orderRef.update({
      status: 'refund_requested',
      cancelReason: cancelReason.trim(),
      kind,
      refundPolicyVersion: REFUND_POLICY_VERSION,
      ...policySnapshot,
      refundRequestedAt: admin.firestore.FieldValue.serverTimestamp()
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
      refundPolicyVersion: REFUND_POLICY_VERSION
    });
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
      const cancelBody = { cancelReason: order.cancelReason || '고객 요청 환불' };
      if (!isFullRefund) cancelBody.cancelAmount = calculation.refundAmount;
      const tossRes = await fetch(tossUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basicToken}`, 'Content-Type': 'application/json' },
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
      const fullyRefunded = refundAmount >= orderAmount;
      transaction.update(orderRef, {
        status: fullyRefunded ? 'refunded' : 'partially_refunded',
        refundedAmount: refundAmount,
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
    res.json({
      ok: true,
      message: '환불이 완료되었습니다.',
      refundAmount,
      partiallyRefunded: refundAmount < orderAmount
    });
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
  splitAdminCreditHistory
};
router.refundPolicy = {
  REFUND_POLICY_VERSION,
  REFUND_WINDOW_DAYS,
  REFUND_WINDOW_MS,
  UNLIMITED_REFUND_SETTLEMENT_USES,
  refundPaidAtMs,
  refundWindowState,
  calculateCreditPolicyRefund,
  calculateSubscriptionPolicyRefund,
  currentSubscriptionRefundContext
};

module.exports = router;
