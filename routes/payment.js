// [결제] 토스페이먼츠 결제 확인 + Firebase 크레딧 지급 처리

const express = require('express');
const { admin, db, ADMIN_UIDS, verifyToken } = require('../config');

const router = express.Router();

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
  } catch (e) {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인 후 결제를 완료해주세요.' });
  }
  if (uid && uid !== verifiedUid) {
    console.warn(`UID mismatch blocked: client=${uid}, token=${verifiedUid}`);
    return res.status(403).json({ error: '사용자 정보가 일치하지 않습니다.' });
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  const basicToken = Buffer.from(secretKey + ":").toString("base64");

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

        console.log(`✅ 성공: ${customerEmail}(${verifiedUid})님께 ${safeCredits}크레딧 지급 완료!`);
        res.json({ ok: true, message: "충전 성공", creditAmount: safeCredits });
      } catch (e) {
        if (e.message === '이미 처리된 결제입니다.') {
          console.log(`⚠️ 중복 요청 차단: ${orderId}`);
          return res.status(400).json({ error: "이미 처리된 결제입니다." });
        }
        throw e;
      }
    } else {
      res.status(response.status).json(result);
    }
  } catch (err) {
    console.error("❌ 서버 에러:", err);
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

const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// 무료 보너스(회원가입 10 + 추천 20×N)는 결제 크레딧보다 먼저 소진된다고 가정.
// → 지갑에 남은 크레딧은 모두 결제분으로 간주하고 주문 크레딧 수만큼만 cap.

// 환불 요청 (사용자용) — kind: 'order' (기본, 크레딧 일회성) | 'subscription' (정기결제)
router.post('/request-refund', async (req, res) => {
  const { orderId, idToken, cancelReason, kind: rawKind } = req.body;
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다.' });
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

    console.log(`📋 환불 요청 (${kind}): ${orderId} (사유: ${cancelReason.trim()})`);
    res.json({ ok: true, message: '환불 요청이 접수되었습니다.' });
  } catch (err) {
    console.error('❌ 환불 요청 에러:', err);
    res.status(500).json({ error: '서버 에러 발생' });
  }
});

// 환불 승인 (관리자용)
router.post('/approve-refund', async (req, res) => {
  const { orderId, idToken, kind: rawKind } = req.body;
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
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
    const secretKey = process.env.TOSS_SECRET_KEY;
    const basicToken = Buffer.from(secretKey + ':').toString('base64');
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
        console.error('❌ 토스 환불 실패:', tossResult);
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
      console.log(`✅ 정기결제 환불 완료: ${orderId} (uid=${order.uid}, 관리자=${adminUid})`);
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
        console.error('🚨 보상 트랜잭션 실패. 수동 복구 필요:', {
          orderId, uid: order.uid, refundableCredits, refundAmount, compErr
        });
      }
      console.error('❌ 토스 환불 실패:', tossResult);
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

    console.log(`✅ 크레딧 부분환불 완료: ${orderId} (${refundableCredits}크레딧/${refundAmount}원, 관리자: ${adminUid})`);
    res.json({ ok: true, message: '환불이 완료되었습니다.' });
  } catch (err) {
    console.error('❌ 환불 승인 에러:', err);
    res.status(500).json({ error: '서버 에러 발생' });
  }
});

// 환불 거절 (관리자용)
router.post('/reject-refund', async (req, res) => {
  const { orderId, idToken, rejectReason, kind: rawKind } = req.body;
  const kind = rawKind === 'sub' || rawKind === 'subscription' ? 'subscription' : 'order';

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요합니다.' });
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

    console.log(`❌ 환불 거절 (${kind}): ${orderId} (사유: ${rejectReason.trim()}, 관리자: ${adminUid})`);
    res.json({ ok: true, message: '환불 요청이 거절되었습니다.' });
  } catch (err) {
    console.error('❌ 환불 거절 에러:', err);
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

    console.log(`🎉 추천 완료: ${referrerUid} → ${newUid} (각 20크레딧)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ 추천 에러:', err);
    res.status(500).json({ error: '추천 처리 실패' });
  }
});

module.exports = router;
