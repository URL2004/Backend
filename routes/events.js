// [events] 클라이언트발 이벤트(문의 등록·신규 가입·친구 초대)를 운영 알림(Discord)으로 중계.
// 문의/가입/초대는 프론트가 Firestore에 직접 쓰는 구조라 서버를 안 거치므로, 이 얇은 relay로 알림만 보냄.
// 스푸핑 최소화: idToken 검증(로그인 사용자만) + per-uid 레이트리밋 + 문의는 실제 문서 조회로 본인 확인.
const express = require('express');
const { db, verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');

const router = express.Router();
const ALLOWED = new Set(['inquiry', 'signup', 'referral']);

const hits = new Map(); // uid -> [timestamps]
function rateLimited(uid) {
  const now = Date.now(), win = 5 * 60 * 1000, max = 20;
  const arr = (hits.get(uid) || []).filter(t => now - t < win);
  arr.push(now);
  hits.set(uid, arr);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.some(t => now - t < win)) hits.delete(k);
  return arr.length > max;
}

router.post('/events', async (req, res) => {
  if (!discord.enabled()) return res.json({ ok: true, skipped: true }); // 알림 미설정 시 즉시 종료(0 비용)
  const { idToken, type } = req.body || {};
  if (!ALLOWED.has(type)) return res.status(400).json({ error: 'unknown event' });
  const uid = await verifyToken(idToken);
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
