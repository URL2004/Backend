// [events] 클라이언트발 이벤트(문의 등록·신규 가입·친구 초대)를 운영 알림(Discord)으로 중계.
// 문의/가입/초대는 프론트가 Firestore에 직접 쓰는 구조라 서버를 안 거치므로, 이 얇은 relay로 알림만 보냄.
// 스푸핑 최소화: idToken 검증(로그인 사용자만) + per-uid 레이트리밋 + 문의는 실제 문서 조회로 본인 확인.
const express = require('express');
const { db, verifyFirebaseIdToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const { realClientIp } = require('../lib/clientip');
const { userAgentFamily } = require('../lib/cronAuth');
const metaConversions = require('../lib/metaConversions');

const router = express.Router();
const ALLOWED = new Set(['inquiry', 'signup', 'referral', 'payment_error', 'client_error']);

// 카드사/사용자 사유로 결제가 안 된 경우는 "정상 이탈"이라 깨울 일이 아니다.
// 반대로 SDK 로드 실패·네트워크·승인 API 오류는 우리 쪽 장애다. 둘을 다른 이벤트로 나눠
// 카탈로그(lib/opsEvents)가 등급을 다르게 매기게 한다.
const DECLINE_CODE_RE = /(REJECT|INVALID_CARD|INSUFFICIENT|EXCEED|LIMIT|STOLEN|LOST|EXPIRED|SUSPEND|NOT_SUPPORTED|PASSWORD|CANCEL)/i;
const DECLINE_STAGE_RE = /(fail_redirect)$/i;

function isDeclineLike(code, stage, status) {
  if (code && DECLINE_CODE_RE.test(String(code))) return true;
  // fail_redirect는 대부분 카드사 거절이지만, 코드가 없으면 판단 불가라 우리 쪽으로 본다(놓치는 것보다 낫다).
  if (DECLINE_STAGE_RE.test(String(stage || '')) && code) return true;
  if (Number(status) === 402) return true;
  return false;
}

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

// 한도 초과 사실 자체를 알리는 것도 창당 1회로 제한한다(알림이 폭주의 일부가 되지 않게).
const floodNoticed = new Map();
function rateLimitNoticed(key) {
  const now = Date.now();
  const last = floodNoticed.get(key) || 0;
  if (now - last < 5 * 60 * 1000) return true;
  floodNoticed.set(key, now);
  if (floodNoticed.size > 1000) for (const [k, t] of floodNoticed) if (now - t > 15 * 60 * 1000) floodNoticed.delete(k);
  return false;
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function logPaymentError(req, uid) {
  const b = req.body || {};
  const code = text(b.code, 80);
  const stage = text(b.stage, 60);
  const status = int(b.status);
  const decline = isDeclineLike(code, stage, status);
  // 우리 쪽 장애면 client.payment_error(SEV2 — 알림), 카드사 거절이면 client.payment_declined(SEV3 — 기록만).
  logger.warn(decline ? 'client.payment_declined' : 'client.payment_error', {
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
  let decoded = null;
  try { decoded = idToken ? await verifyFirebaseIdToken(idToken) : null; }
  catch (_) { decoded = null; }
  const uid = decoded?.uid || null;

  if (type === 'payment_error') {
    if (uid) setLogContext({ uid });
    const key = uid || `anon:${realClientIp(req)}`;
    // 레이트리밋 초과분을 조용히 버리면 "사고가 클수록 신호가 줄어드는" 역방향 구조가 된다.
    // 버릴 때도 최소 1줄은 남겨서 규모를 알 수 있게 한다(로그 자체는 억제 창당 1회).
    if (rateLimited(key)) {
      if (!rateLimitNoticed(key)) {
        logger.warn('client.payment_error_flood', {
          uid: uid || undefined,
          keyKind: uid ? 'uid' : 'ip',
          windowMinutes: 5,
          limit: 20,
          message: '결제 오류 리포트가 한도를 초과해 일부가 기록되지 않았어요. 대량 결제 장애 가능성이 있어요.'
        });
      }
      return res.json({ ok: true, throttled: true });
    }
    logPaymentError(req, uid);
    return res.json({ ok: true });
  }

  // 프론트 전역 JS 오류(window.onerror / unhandledrejection). 이전에는 프론트 장애가
  // 결제 외에는 어디에도 남지 않았다 — SPA가 안 뜨면 요청 자체가 없으니 서버 로그도 비어 있었다.
  if (type === 'client_error') {
    const b = req.body || {};
    if (uid) setLogContext({ uid });
    const key = uid || `anon:${realClientIp(req)}`;
    if (rateLimited(key)) return res.json({ ok: true, throttled: true });
    logger.warn('client.app_error', {
      uid: uid || undefined,
      message: text(b.message, 300),
      source: text(b.source, 200),
      line: int(b.line),
      col: int(b.col),
      errorName: text(b.errorName, 80),
      stack: text(b.stack, 600),
      page: text(b.page, 120),
      release: text(b.release, 40),
      userAgentFamily: userAgentFamily(req)
    });
    return res.json({ ok: true });
  }

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
      if (!db) return res.json({ ok: true, skipped: 'firebase_disabled' });
      const userSnap = await db.collection('users').doc(uid).get();
      if (!userSnap.exists) return res.json({ ok: true, skipped: 'user_not_found' });
      const user = userSnap.data() || {};
      const createdAt = typeof user.createdAt === 'string' ? user.createdAt : '';
      const expectedEventId = createdAt ? metaConversions.stableEventId('sign_up', `${uid}|${createdAt}`) : '';
      const suppliedEventId = String(req.body.metaEventId || '').slice(0, 180);
      if (!expectedEventId || suppliedEventId !== expectedEventId) {
        logger.warn('meta.signup_event_id_rejected', { uid, eventIdPresent: !!suppliedEventId });
        return res.json({ ok: true, skipped: 'invalid_signup_event' });
      }
      void metaConversions.sendCompleteRegistration({
        eventId: expectedEventId,
        email: decoded?.email || user.email,
        externalId: uid,
        clientIp: realClientIp(req),
        userAgent: req.get('user-agent'),
        context: req.body
      });
      if (discord.enabled()) discord.signup({ uid, via: String(req.body.via || '').slice(0, 20) || '직접' });
    } else if (type === 'referral') {
      if (discord.enabled()) discord.referral({ inviter: uid, invitee: String(req.body.invitee || '').slice(0, 60) });
    }
  } catch (e) {
    logger.warn('events.notify_failed', { type, err: e });
  }
  res.json({ ok: true });
});

module.exports = router;
