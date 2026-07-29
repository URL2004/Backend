// [events] 클라이언트발 이벤트(문의 등록·신규 가입·친구 초대)를 운영 알림(Discord)으로 중계.
// 문의/가입/초대는 프론트가 Firestore에 직접 쓰는 구조라 서버를 안 거치므로, 이 얇은 relay로 알림만 보냄.
// 스푸핑 최소화: idToken 검증(로그인 사용자만) + per-uid 레이트리밋 + 문의는 실제 문서 조회로 본인 확인.
const express = require('express');
const { db, verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const { realClientIp } = require('../lib/clientip');

const router = express.Router();
const ALLOWED = new Set(['inquiry', 'signup', 'referral', 'payment_error']);

const hits = new Map(); // uid -> [timestamps]
function rateLimited(uid) {
  const now = Date.now(), win = 5 * 60 * 1000, max = 20;
  const arr = (hits.get(uid) || []).filter(t => now - t < win);
  arr.push(now);
  hits.set(uid, arr);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.some(t => now - t < win)) hits.delete(k);
  return arr.length > max;
}

function text(value, max = 160) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function logPaymentError(req, uid) {
  const b = req.body || {};
  logger.warn('client.payment_error', {
    uid: uid || undefined,
    authenticated: !!uid,
    stage: text(b.stage, 60),
    checkoutType: text(b.checkoutType || b.checkout_type, 40),
    code: text(b.code, 80),
    message: text(b.message, 300),
    status: int(b.status),
    orderId: text(b.orderId, 120),
    amount: int(b.amount),
    credits: int(b.credits),
    plan: text(b.plan, 80),
    tier: text(b.tier, 80),
    endpoint: text(b.endpoint, 120),
    page: text(b.page, 120),
    userUidPresent: !!b.uid,
    trafficSource: text(b.trafficSource || b.traffic_source, 60)
  });
}

router.post('/events', async (req, res) => {
  const { idToken, type } = req.body || {};
  if (!ALLOWED.has(type)) return res.status(400).json({ error: 'unknown event' });
  const uid = await verifyToken(idToken);

  if (type === 'payment_error') {
    if (uid) setLogContext({ uid });
    const key = uid || `anon:${realClientIp(req)}`;
    if (rateLimited(key)) return res.json({ ok: true, throttled: true });
    logPaymentError(req, uid);
    return res.json({ ok: true });
  }

  if (!discord.enabled()) return res.json({ ok: true, skipped: true }); // 알림 미설정 시 즉시 종료(0 비용)
  if (!uid) return res.status(401).json({ error: 'auth required' });
  setLogContext({ uid });
  if (rateLimited(uid)) return res.json({ ok: true, throttled: true });

  try {
    if (type === 'inquiry') {
      const id = String(req.body.id || '').slice(0, 200);
      if (!id || !db) return res.json({ ok: true });
      const snap = await db.collection('qna').doc(id).get();
      if (!snap.exists) return res.json({ ok: true });
      const q = snap.data() || {};
      if (q.authorId !== uid) return res.json({ ok: true }); // 본인 문의만 알림
      discord.inquiry({ id, title: q.title, body: q.body, author: q.isAnon ? '익명' : (q.authorName || '회원'), uid });
    } else if (type === 'signup') {
      discord.signup({ uid, via: String(req.body.via || '').slice(0, 20) || '직접' });
    } else if (type === 'referral') {
      discord.referral({ inviter: uid, invitee: String(req.body.invitee || '').slice(0, 60) });
    }
  } catch (e) {
    logger.warn('events.notify_failed', { type, err: e });
  }
  res.json({ ok: true });
});

module.exports = router;
