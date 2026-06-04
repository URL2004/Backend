// [쿠폰] 관리자 일괄 발급 + 사용자 코드 적용으로 크레딧 지급
// ★ couponBatches, couponCodes 컬렉션 신설. 기존 users.coupon(구독용)과 무관.

const express = require('express');
const crypto = require('crypto');
const { admin, db, ADMIN_UIDS, verifyToken } = require('../config');

const router = express.Router();

// 32자 (0/O/1/I/L 제외) — 2^5라 randomBytes % 32 균등 분포
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const MAX_COUNT_PER_BATCH = 400;
const MAX_CREDITS_PER_CODE = 10000;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CHARSET[bytes[i] & 31];
  return s;
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function normalizeCode(input) {
  return String(input || '').replace(/[-\s]/g, '').toUpperCase();
}

// ───────────────────────────────────────────
// 관리자: 쿠폰 일괄 발급
// ───────────────────────────────────────────
router.post('/admin/create-coupons', async (req, res) => {
  const { idToken, credits, count, expiresAt } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }

  const creditsInt = parseInt(credits, 10);
  const countInt = parseInt(count, 10);
  if (!Number.isInteger(creditsInt) || creditsInt < 1 || creditsInt > MAX_CREDITS_PER_CODE) {
    return res.status(400).json({ error: `크레딧은 1~${MAX_CREDITS_PER_CODE} 사이의 정수여야 해요.` });
  }
  if (!Number.isInteger(countInt) || countInt < 1 || countInt > MAX_COUNT_PER_BATCH) {
    return res.status(400).json({ error: `발급 개수는 1~${MAX_COUNT_PER_BATCH} 사이여야 해요.` });
  }

  let expiresAtTs = null;
  if (expiresAt) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) {
      return res.status(400).json({ error: '만료일 형식이 올바르지 않아요.' });
    }
    if (t.getTime() < Date.now()) {
      return res.status(400).json({ error: '만료일은 현재 이후여야 해요.' });
    }
    expiresAtTs = admin.firestore.Timestamp.fromDate(t);
  }

  try {
    // 배치 내 중복 방지를 위한 메모리 Set
    const codes = new Set();
    while (codes.size < countInt) codes.add(generateCode());
    const codeList = Array.from(codes);

    // 외부 충돌(다른 배치와 같은 코드)이 있는지 사전 확인.
    // 32^12라 사실상 0이지만, 안전을 위해 검사.
    const refs = codeList.map(c => db.collection('couponCodes').doc(c));
    const snaps = await db.getAll(...refs);
    const collided = [];
    snaps.forEach((s, i) => { if (s.exists) collided.push(codeList[i]); });
    // 충돌한 자리는 재생성 (단순 루프, 충돌 확률 무시 가능)
    for (let i = 0; i < collided.length; i++) {
      let fresh;
      do { fresh = generateCode(); } while (codes.has(fresh));
      const idx = codeList.indexOf(collided[i]);
      codes.delete(collided[i]);
      codes.add(fresh);
      codeList[idx] = fresh;
    }

    const batchRef = db.collection('couponBatches').doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Firestore WriteBatch는 한 번에 500개 한도. count<=400 + batch문서 1 = 401 OK.
    const wb = db.batch();
    wb.set(batchRef, {
      adminUid,
      credits: creditsInt,
      count: countInt,
      expiresAt: expiresAtTs,
      redeemedCount: 0,
      voidedCount: 0,
      createdAt: now
    });
    codeList.forEach(c => {
      wb.set(db.collection('couponCodes').doc(c), {
        credits: creditsInt,
        batchId: batchRef.id,
        status: 'unused',
        expiresAt: expiresAtTs,
        redeemedBy: null,
        redeemedAt: null,
        createdAt: now
      });
    });
    await wb.commit();

    console.log(`✅ 쿠폰 발급: admin=${adminUid}, ${creditsInt}크레딧 × ${countInt}개, batchId=${batchRef.id}`);

    res.json({
      ok: true,
      batchId: batchRef.id,
      credits: creditsInt,
      count: countInt,
      codes: codeList.map(c => ({ raw: c, display: formatCode(c) }))
    });
  } catch (err) {
    console.error('❌ 쿠폰 발급 실패:', err);
    res.status(500).json({ error: '쿠폰 발급 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 사용자: 쿠폰 코드 적용
// ───────────────────────────────────────────
router.post('/redeem-coupon', async (req, res) => {
  const { idToken, code } = req.body || {};

  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: '로그인이 필요해요.' });

  const normalized = normalizeCode(code);
  if (normalized.length !== CODE_LENGTH) {
    return res.status(400).json({ error: '쿠폰 코드 형식이 올바르지 않아요.' });
  }

  const couponRef = db.collection('couponCodes').doc(normalized);
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (t) => {
      // READ 먼저
      const couponSnap = await t.get(couponRef);
      if (!couponSnap.exists) {
        throw Object.assign(new Error('쿠폰 코드를 찾을 수 없어요.'), { status: 404 });
      }
      const coupon = couponSnap.data();
      if (coupon.status === 'redeemed') {
        throw Object.assign(new Error('이미 사용된 쿠폰이에요.'), { status: 409 });
      }
      if (coupon.status === 'voided') {
        throw Object.assign(new Error('이 쿠폰은 더 이상 사용할 수 없어요.'), { status: 410 });
      }
      if (coupon.expiresAt && coupon.expiresAt.toMillis() < Date.now()) {
        throw Object.assign(new Error('만료된 쿠폰이에요.'), { status: 410 });
      }
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) {
        throw Object.assign(new Error('사용자 정보를 찾을 수 없어요.'), { status: 404 });
      }
      const currentCredits = userSnap.data().credits || 0;
      const newCredits = currentCredits + coupon.credits;

      // WRITE
      t.update(couponRef, {
        status: 'redeemed',
        redeemedBy: uid,
        redeemedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.update(userRef, { credits: newCredits });
      // 배치 카운트 증가 (read 없이 atomic)
      const batchRef = db.collection('couponBatches').doc(coupon.batchId);
      t.update(batchRef, { redeemedCount: admin.firestore.FieldValue.increment(1) });
      const histRef = userRef.collection('creditHistory').doc();
      t.set(histRef, {
        type: 'coupon_redeem',
        used: 0,
        amount: coupon.credits,
        remaining: newCredits,
        couponCode: normalized,
        batchId: coupon.batchId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { granted: coupon.credits, newBalance: newCredits };
    });

    console.log(`✅ 쿠폰 사용: uid=${uid}, code=${normalized}, +${result.granted}크레딧`);
    res.json({ ok: true, credits: result.granted, newBalance: result.newBalance });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('❌ 쿠폰 사용 실패:', err);
    res.status(500).json({ error: '쿠폰 사용 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 관리자: 발급 이력 목록
// ───────────────────────────────────────────
router.post('/admin/list-coupon-batches', async (req, res) => {
  const { idToken, limit, cursor } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }

  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  try {
    let q = db.collection('couponBatches').orderBy('createdAt', 'desc').limit(lim);
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        q = q.startAfter(admin.firestore.Timestamp.fromDate(cursorDate));
      }
    }
    const snap = await q.get();
    // 1차 발급분(redeemedCount/voidedCount 필드 없음)은 실측 fallback.
    // 2차 이후 발급분은 fast path.
    const batches = await Promise.all(snap.docs.map(async (d) => {
      const b = d.data();
      let redeemedCount = b.redeemedCount;
      let voidedCount = b.voidedCount;
      if (typeof redeemedCount !== 'number' || typeof voidedCount !== 'number') {
        const codesSnap = await db.collection('couponCodes').where('batchId', '==', d.id).get();
        redeemedCount = 0; voidedCount = 0;
        codesSnap.docs.forEach(s => {
          const st = s.data().status;
          if (st === 'redeemed') redeemedCount++;
          else if (st === 'voided') voidedCount++;
        });
      }
      return {
        batchId: d.id,
        adminUid: b.adminUid,
        credits: b.credits,
        count: b.count,
        redeemedCount,
        voidedCount,
        unusedCount: (b.count || 0) - redeemedCount - voidedCount,
        expiresAt: b.expiresAt ? b.expiresAt.toMillis() : null,
        createdAt: b.createdAt ? b.createdAt.toMillis() : null
      };
    }));
    const last = snap.docs[snap.docs.length - 1];
    const nextCursor = (snap.size === lim && last && last.data().createdAt)
      ? new Date(last.data().createdAt.toMillis()).toISOString()
      : null;
    res.json({ ok: true, batches, nextCursor });
  } catch (err) {
    console.error('❌ 쿠폰 이력 조회 실패:', err);
    res.status(500).json({ error: '쿠폰 이력 조회 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 관리자: 배치 상세 (코드 목록 + 사용자 조인)
// ───────────────────────────────────────────
router.post('/admin/get-coupon-batch', async (req, res) => {
  const { idToken, batchId } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }
  if (!batchId || typeof batchId !== 'string') {
    return res.status(400).json({ error: '배치 ID가 필요해요.' });
  }

  try {
    const batchSnap = await db.collection('couponBatches').doc(batchId).get();
    if (!batchSnap.exists) {
      return res.status(404).json({ error: '배치를 찾을 수 없어요.' });
    }
    const b = batchSnap.data();
    const codesSnap = await db.collection('couponCodes').where('batchId', '==', batchId).get();

    // 사용자 정보 조인 (redeemedBy uid 모아 한 번에 getAll)
    const uidSet = new Set();
    codesSnap.docs.forEach(d => { const v = d.data().redeemedBy; if (v) uidSet.add(v); });
    const userMap = {};
    if (uidSet.size > 0) {
      const userRefs = Array.from(uidSet).map(u => db.collection('users').doc(u));
      const userSnaps = await db.getAll(...userRefs);
      userSnaps.forEach(s => {
        if (s.exists) {
          const u = s.data();
          userMap[s.id] = { uid: s.id, nickname: u.nickname || u.displayName || '(이름없음)', email: u.email || '' };
        }
      });
    }

    // 코드 fetch 결과로 카운트 실측 (1차 발급분 fallback 겸용)
    let realRedeemed = 0, realVoided = 0;
    codesSnap.docs.forEach(s => {
      const st = s.data().status;
      if (st === 'redeemed') realRedeemed++;
      else if (st === 'voided') realVoided++;
    });

    const codes = codesSnap.docs.map(d => {
      const c = d.data();
      const code = d.id;
      const display = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
      return {
        code,
        display,
        status: c.status,
        credits: c.credits,
        expiresAt: c.expiresAt ? c.expiresAt.toMillis() : null,
        redeemedAt: c.redeemedAt ? c.redeemedAt.toMillis() : null,
        redeemedBy: c.redeemedBy ? (userMap[c.redeemedBy] || { uid: c.redeemedBy, nickname: '(알 수 없음)', email: '' }) : null,
        voidedAt: c.voidedAt ? c.voidedAt.toMillis() : null
      };
    });
    codes.sort((a, b) => (a.redeemedAt ? 0 : 1) - (b.redeemedAt ? 0 : 1)); // 사용된 것 위로

    const redeemedCount = typeof b.redeemedCount === 'number' ? b.redeemedCount : realRedeemed;
    const voidedCount = typeof b.voidedCount === 'number' ? b.voidedCount : realVoided;
    res.json({
      ok: true,
      batch: {
        batchId: batchSnap.id,
        adminUid: b.adminUid,
        credits: b.credits,
        count: b.count,
        redeemedCount,
        voidedCount,
        unusedCount: (b.count || 0) - redeemedCount - voidedCount,
        expiresAt: b.expiresAt ? b.expiresAt.toMillis() : null,
        createdAt: b.createdAt ? b.createdAt.toMillis() : null
      },
      codes
    });
  } catch (err) {
    console.error('❌ 배치 상세 조회 실패:', err);
    res.status(500).json({ error: '배치 상세 조회 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 관리자: 쿠폰 무효화 (배치 또는 개별)
// ───────────────────────────────────────────
router.post('/admin/void-coupons', async (req, res) => {
  const { idToken, batchId, code } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }

  // 개별 모드: code 우선
  if (code) {
    const normalized = normalizeCode(code);
    if (normalized.length !== CODE_LENGTH) {
      return res.status(400).json({ error: '쿠폰 코드 형식이 올바르지 않아요.' });
    }
    const couponRef = db.collection('couponCodes').doc(normalized);
    try {
      const result = await db.runTransaction(async (t) => {
        const snap = await t.get(couponRef);
        if (!snap.exists) {
          throw Object.assign(new Error('쿠폰 코드를 찾을 수 없어요.'), { status: 404 });
        }
        const c = snap.data();
        if (c.status === 'redeemed') {
          throw Object.assign(new Error('이미 사용된 쿠폰은 무효화할 수 없어요.'), { status: 409 });
        }
        if (c.status === 'voided') {
          throw Object.assign(new Error('이미 무효화된 쿠폰이에요.'), { status: 409 });
        }
        const batchRef = db.collection('couponBatches').doc(c.batchId);
        t.update(couponRef, {
          status: 'voided',
          voidedBy: adminUid,
          voidedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        t.update(batchRef, { voidedCount: admin.firestore.FieldValue.increment(1) });
        return { batchId: c.batchId };
      });
      console.log(`✅ 쿠폰 개별 무효화: admin=${adminUid}, code=${normalized}, batchId=${result.batchId}`);
      return res.json({ ok: true, voidedCount: 1 });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('❌ 쿠폰 개별 무효화 실패:', err);
      return res.status(500).json({ error: '쿠폰 무효화 중 오류가 발생했어요.' });
    }
  }

  // 배치 모드
  if (!batchId || typeof batchId !== 'string') {
    return res.status(400).json({ error: '배치 ID 또는 쿠폰 코드가 필요해요.' });
  }
  const batchRef = db.collection('couponBatches').doc(batchId);
  try {
    const voidedCount = await db.runTransaction(async (t) => {
      const batchSnap = await t.get(batchRef);
      if (!batchSnap.exists) {
        throw Object.assign(new Error('배치를 찾을 수 없어요.'), { status: 404 });
      }
      const q = db.collection('couponCodes')
        .where('batchId', '==', batchId)
        .where('status', '==', 'unused');
      const snap = await t.get(q);
      if (snap.empty) return 0;
      const now = admin.firestore.FieldValue.serverTimestamp();
      snap.docs.forEach(d => {
        t.update(d.ref, { status: 'voided', voidedBy: adminUid, voidedAt: now });
      });
      t.update(batchRef, { voidedCount: admin.firestore.FieldValue.increment(snap.size) });
      return snap.size;
    });
    console.log(`✅ 쿠폰 배치 무효화: admin=${adminUid}, batchId=${batchId}, ${voidedCount}개`);
    res.json({ ok: true, voidedCount });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('❌ 쿠폰 배치 무효화 실패:', err);
    res.status(500).json({ error: '쿠폰 무효화 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 관리자: 배치 기록 영구 삭제 (잔여 미사용 0일 때만)
// ───────────────────────────────────────────
router.post('/admin/delete-coupon-batch', async (req, res) => {
  const { idToken, batchId } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }
  if (!batchId || typeof batchId !== 'string') {
    return res.status(400).json({ error: '배치 ID가 필요해요.' });
  }

  const batchRef = db.collection('couponBatches').doc(batchId);
  try {
    const deletedCount = await db.runTransaction(async (t) => {
      const batchSnap = await t.get(batchRef);
      if (!batchSnap.exists) {
        throw Object.assign(new Error('배치를 찾을 수 없어요.'), { status: 404 });
      }
      const codesQ = db.collection('couponCodes').where('batchId', '==', batchId);
      const codesSnap = await t.get(codesQ);
      const hasUnused = codesSnap.docs.some(d => d.data().status === 'unused');
      if (hasUnused) {
        throw Object.assign(new Error('미사용 쿠폰이 남아있어 삭제할 수 없어요. 먼저 배치 무효화를 해주세요.'), { status: 409 });
      }
      codesSnap.docs.forEach(d => t.delete(d.ref));
      t.delete(batchRef);
      return codesSnap.size;
    });
    console.log(`✅ 배치 기록 삭제: admin=${adminUid}, batchId=${batchId}, codes=${deletedCount}개`);
    res.json({ ok: true, deletedCodes: deletedCount });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('❌ 배치 기록 삭제 실패:', err);
    res.status(500).json({ error: '배치 삭제 중 오류가 발생했어요.' });
  }
});

// ───────────────────────────────────────────
// 관리자: 배치 만료일 일괄 변경 (부활 / 무기한 전환 허용)
// ───────────────────────────────────────────
router.post('/admin/update-batch-expiry', async (req, res) => {
  const { idToken, batchId, expiresAt } = req.body || {};

  const adminUid = await verifyToken(idToken);
  if (!adminUid) return res.status(401).json({ error: '로그인이 필요해요.' });
  if (!ADMIN_UIDS.includes(adminUid)) {
    return res.status(403).json({ error: '관리자 권한이 없어요.' });
  }
  if (!batchId || typeof batchId !== 'string') {
    return res.status(400).json({ error: '배치 ID가 필요해요.' });
  }

  // expiresAt 파싱: null/빈값 = 무기한, 미래 날짜만 허용
  let expiresAtTs = null;
  if (expiresAt) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) {
      return res.status(400).json({ error: '만료일 형식이 올바르지 않아요.' });
    }
    if (t.getTime() < Date.now()) {
      return res.status(400).json({ error: '새 만료일은 현재 이후여야 해요.' });
    }
    expiresAtTs = admin.firestore.Timestamp.fromDate(t);
  }

  const batchRef = db.collection('couponBatches').doc(batchId);
  try {
    const updated = await db.runTransaction(async (t) => {
      const batchSnap = await t.get(batchRef);
      if (!batchSnap.exists) {
        throw Object.assign(new Error('배치를 찾을 수 없어요.'), { status: 404 });
      }
      const codesQ = db.collection('couponCodes').where('batchId', '==', batchId);
      const codesSnap = await t.get(codesQ);
      t.update(batchRef, { expiresAt: expiresAtTs });
      codesSnap.docs.forEach(d => t.update(d.ref, { expiresAt: expiresAtTs }));
      return codesSnap.size;
    });
    const expStr = expiresAtTs ? new Date(expiresAtTs.toMillis()).toISOString() : '무기한';
    console.log(`✅ 배치 만료일 변경: admin=${adminUid}, batchId=${batchId}, expiresAt=${expStr}, codes=${updated}`);
    res.json({ ok: true, updatedCodes: updated, expiresAt: expiresAtTs ? expiresAtTs.toMillis() : null });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('❌ 배치 만료일 변경 실패:', err);
    res.status(500).json({ error: '만료일 변경 중 오류가 발생했어요.' });
  }
});

module.exports = router;
