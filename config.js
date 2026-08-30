// [설정] Firebase 초기화, CORS 허용 도메인, 요청 제한(Rate Limiter)을 관리하는 파일

const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { logger } = require('./lib/logger');
const { realClientIp } = require('./lib/clientip');

// 렌더 환경변수에 파이어베이스 키를 넣었다면 이렇게 사용.
// ★ 로컬 엔진 테스트: FIREBASE_SERVICE_ACCOUNT 미설정 시 Firebase 초기화를 건너뛴다(require 시 crash 방지).
//   프로덕션(env 설정)에서는 기존과 100% 동일하게 초기화. admin/db는 미설정 시 null이며,
//   인증·결제 경로(/analyze 등)는 동작하지 않지만 엔진(humanize) 단독 테스트는 가능.
let admin = null;
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin = require('./lib/firebaseAdminCompat');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
} else {
  logger.warn('config.firebase_disabled', {
    message: 'FIREBASE_SERVICE_ACCOUNT 미설정 - Firebase 비활성'
  });
}

// CORS 설정 — 기본 도메인 + env CORS_ORIGINS(콤마 구분)로 추가. 도메인 바뀔 때 코드 수정 없이 env로 대응.
const allowedOrigins = [
  'https://gpkorea.ai.kr',
  'https://www.gpkorea.ai.kr',
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
];
const allowedOriginSuffixes = (process.env.CORS_ORIGIN_SUFFIXES || '').split(',').map(s => s.trim()).filter(Boolean);

// 로컬 개발에서만 localhost/127.0.0.1의 임의 포트를 허용한다.
// 운영에서는 로컬 origin을 제외해 브라우저 기반 우회 호출 표면을 불필요하게 열지 않는다.
const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// ★ H-10: 경계 없는 endsWith는 example.com 허용 시 evil-example.com도 통과시킨다.
//    origin을 파싱해 호스트네임만 비교하고, 정확히 일치하거나 '.suffix'로 끝나는 경우만 허용한다.
function originHostname(o) { try { return new URL(o).hostname; } catch { return ''; } }
function normalizeSuffix(s) { return (s.includes('://') ? originHostname(s) : s).replace(/^\.+/, ''); }
const normalizedSuffixes = allowedOriginSuffixes.map(normalizeSuffix).filter(Boolean);

const corsMiddleware = cors({
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  origin: (origin, callback) => {
    const host = origin ? originHostname(origin) : '';
    const allowedBySuffix = !!host && normalizedSuffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));
    const localDevelopmentOrigin = process.env.NODE_ENV !== 'production' && LOCAL_DEV_ORIGIN.test(origin || '');
    if (!origin || allowedOrigins.includes(origin) || allowedBySuffix || localDevelopmentOrigin) {
      callback(null, true);
    } else {
      logger.warn('cors.origin_rejected', { origin });
      callback(new Error('허용되지 않은 접근입니다.'));
    }
  }
});

// Rate Limiter
// 긴 글은 프런트가 청크로 쪼개 순차 호출하므로 한 작업이 여러 요청으로 카운트된다.
// 쿠폰 모드 50,000자 = 최대 ~9청크 → 분당 10 제한이면 정상 1회 사용도 막혔다.
// 청크 순차 호출 + 짧은 재시도까지 감안해 30으로 상향 (과금은 크레딧으로 별도 제어).
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => realClientIp(req),
});

function rateLimitResponse(_req, res) {
  return res.status(429).json({
    ok: false,
    code: 'RATE_LIMITED',
    error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
  });
}

// Login and Discord use dedicated conservative ceilings. This prevents a
// credential-stuffing/CPU flood without sharing the AI request bucket.
const kakaoAuthLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Math.max(5, Number(process.env.KAKAO_LOGIN_RATE_LIMIT || 20) || 20),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => realClientIp(req),
  handler: rateLimitResponse
});

const discordInteractionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(30, Number(process.env.DISCORD_INTERACTION_RATE_LIMIT || 120) || 120),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => realClientIp(req),
  handler: rateLimitResponse
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1000,
  message: { error: '일일 사용량을 초과했습니다. 내일 다시 시도해주세요.' },
  keyGenerator: req => realClientIp(req),
});

// 관리자 UID 화이트리스트 (프론트엔드 ADMIN_ROLES와 동일하게 유지)
const ADMIN_UIDS = ['nC90IyjgaIZ8Z0JTABMTiyQHF9g1', 'qa0iQAeVmMOxoy6Vg5ENTRKk0Vm2', 'upyxtXMQEgQXfqTUWPrf6QS9EqE2', '9i6YA66mpXSBcpPJqNmJQ5jnJsT2'];

// Firebase ID Token 검증 헬퍼. 인증 필수 라우트는 원본 검증 결과를 사용하고,
// 기존 선택 인증 라우트는 verifyToken의 null 반환 계약을 유지한다.
async function verifyFirebaseIdToken(idToken, options = {}) {
  if (!idToken || !admin) {
    throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'auth/id-token-required' });
  }
  const checkRevoked = options === true || (options && options.checkRevoked === true);
  return admin.auth().verifyIdToken(idToken, checkRevoked);
}

async function verifyToken(idToken, options = {}) {
  try {
    return (await verifyFirebaseIdToken(idToken, options)).uid;
  } catch (e) {
    return null;
  }
}

// 관리자 작업은 결제·쿠폰·운영 로그·실험 설정처럼 권한 반경이 크다.
// Firebase에서 세션을 폐기한 뒤에도 ID token의 남은 수명 동안 접근되는 일을 막기 위해
// 모든 관리자 라우트가 이 단일 검증기를 사용하고 checkRevoked=true를 강제한다.
async function verifyAdminToken(idToken) {
  try {
    const decoded = await verifyFirebaseIdToken(idToken, { checkRevoked: true });
    // null = invalid/expired/revoked, false = authenticated but not an admin.
    // Keeping those states distinct preserves the API's 401/403 contract.
    return ADMIN_UIDS.includes(decoded.uid) ? decoded.uid : false;
  } catch (e) {
    return null;
  }
}

// ★ H-05: App Check 토큰 검증 헬퍼. 정상 앱(reCAPTCHA App Check)에서 온 요청만 통과시킨다.
//   무인증 비용 민감 라우트(코치 등)에서 봇 호출을 차단하는 용도. admin 미설정 시 false.
async function verifyAppCheck(token) {
  if (!token || !admin) return false;
  try { await admin.appCheck().verifyToken(token); return true; }
  catch (e) { return false; }
}

module.exports = {
  admin,
  db,
  corsMiddleware,
  limiter,
  dailyLimiter,
  kakaoAuthLimiter,
  discordInteractionLimiter,
  ADMIN_UIDS,
  verifyFirebaseIdToken,
  verifyToken,
  verifyAdminToken,
  verifyAppCheck
};
