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
const { bearerToken } = require('../lib/reqtoken');
const paymentFailures = require('../lib/paymentFailureTaxonomy');

const router = express.Router();
const ALLOWED = new Set(['inquiry', 'signup', 'referral', 'payment_error', 'client_error']);

// 카드사/사용자 사유로 결제가 안 된 경우는 "정상 이탈"이라 깨울 일이 아니다.
// 반대로 SDK 로드 실패·네트워크·승인 API 오류는 우리 쪽 장애다. 둘을 다른 이벤트로 나눠
// 카탈로그(lib/opsEvents)가 등급을 다르게 매기게 한다.
//
// 판정 규칙은 서버 승인 경로와 같은 표(lib/paymentFailureTaxonomy)를 쓴다. 2026-09-04에는
// 여기 규칙만 따로 있어서, 서버가 내려보낸 PAYMENT_ABORTED가 목록에 없다는 이유로
// 잔액부족 이탈이 client.payment_error(SEV2)로 올라왔다.
const DECLINE_STAGE_RE = /(fail_redirect)$/i;

// 반환값은 거절 카테고리(잔액부족·한도초과 등) 또는 null. null이면 우리 쪽 장애로 본다.
function declineCategory(code, stage, status) {
  const mapped = paymentFailures.declineCategoryForCode(code);
  if (mapped) return mapped;
  // fail_redirect는 대부분 카드사 거절이지만, 코드가 없으면 판단 불가라 우리 쪽으로 본다(놓치는 것보다 낫다).
  if (DECLINE_STAGE_RE.test(String(stage || '')) && code) return 'provider_declined';
  if (Number(status) === 402) return 'provider_declined';
  return null;
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
  const orderId = text(b.orderId, 120);
  const serverCategory = declineCategory(code, stage, status);
  // 프런트가 보낸 분류는 우리 서버 응답에서 온 값이지만 위조될 수 있다. 등급을 낮추는 데는
  // 쓰지 않고, 우리 판정이 이미 "거절"일 때 사유를 더 정확히 적는 용도로만 쓴다.
  const reportedCategory = text(b.declineCategory, 40);
  const category = serverCategory
    ? (reportedCategory && paymentFailures.CATEGORY_LABEL[reportedCategory] ? reportedCategory : serverCategory)
    : null;
  const decline = !!category;
  const amount = int(b.amount);
  // 같은 실패는 서버 승인 경로가 이미 셌다. 여기서 또 기록하면 두 번 세어지므로 읽기만 한다.
  const retry = paymentFailures.peekFailures({ uid, orderId });
  const label = category ? (paymentFailures.CATEGORY_LABEL[category] || category) : '우리 쪽 장애 추정';
  const won = Number.isFinite(amount) ? `${amount.toLocaleString('ko-KR')}원` : '금액미상';
  // 우리 쪽 장애면 client.payment_error(SEV2 — 알림), 카드사 거절이면 client.payment_declined(SEV3 — 기록만).
  logger.warn(decline ? 'client.payment_declined' : 'client.payment_error', {
    uid: uid || undefined,
    authenticated: !!uid,
    stage,
    checkoutType: text(b.checkoutType || b.checkout_type, 40),
    code,
    clientMessage: text(b.message, 300),
    status,
    orderId,
    amount,
    credits: int(b.credits),
    plan: text(b.plan, 80),
    tier: text(b.tier, 80),
    endpoint: text(b.endpoint, 120),
    page: text(b.page, 120),
    userUidPresent: !!b.uid,
    trafficSource: text(b.trafficSource || b.traffic_source, 60),
    // 분류 — 서버 승인 경로와 같은 어휘를 쓴다. 두 로그를 orderId로 이어 붙여 볼 수 있다.
    outcome: decline ? paymentFailures.OUTCOME_CUSTOMER_DECLINED : 'client_side_failure',
    failureCategory: category || 'client_reported',
    actionRequired: decline ? 'none' : 'monitor',
    moneyAtRisk: false,
    reportedBy: 'client',
    retryUidFailures5m: retry.uidFailures5m || undefined,
    retryUidDistinctOrders5m: retry.uidDistinctOrders5m || undefined,
    retryOrderAttempt: retry.orderAttempt || undefined,
    message: `[프런트 보고] ${label}${code ? `(${code})` : ''} — ${won}, 단계 ${stage || '미상'}${text(b.message, 200) ? ` · "${text(b.message, 200)}"` : ''}`
  });
}

router.post('/events', async (req, res) => {
  const { type } = req.body || {};
  const idToken = bearerToken(req);
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
