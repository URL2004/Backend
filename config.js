// [설정] Firebase 초기화, CORS 허용 도메인, 요청 제한(Rate Limiter)을 관리하는 파일

const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { logger } = require('./lib/logger');

// 렌더 환경변수에 파이어베이스 키를 넣었다면 이렇게 사용.
// ★ 로컬 엔진 테스트: FIREBASE_SERVICE_ACCOUNT 미설정 시 Firebase 초기화를 건너뛴다(require 시 crash 방지).
//   프로덕션(env 설정)에서는 기존과 100% 동일하게 초기화. admin/db는 미설정 시 null이며,
//   인증·결제 경로(/analyze 등)는 동작하지 않지만 엔진(humanize) 단독 테스트는 가능.
let admin = null;
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin = require('firebase-admin');
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

// 로컬 개발 origin은 포트 무관 전부 허용(localhost/127.0.0.1 — Live Server 5500, http.server 8741 등 어떤 포트든).
// CORS는 브라우저 보호 장치일 뿐 인증이 아니므로(인증은 idToken) localhost 허용은 보안상 무해.
const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const corsMiddleware = cors({
  origin: (origin, callback) => {
    const allowedBySuffix = origin && allowedOriginSuffixes.some(suffix => origin.endsWith(suffix));
    if (!origin || allowedOrigins.includes(origin) || allowedBySuffix || LOCAL_DEV_ORIGIN.test(origin)) {
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
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1000,
  message: { error: '일일 사용량을 초과했습니다. 내일 다시 시도해주세요.' },
});

// 관리자 UID 화이트리스트 (프론트엔드 ADMIN_ROLES와 동일하게 유지)
const ADMIN_UIDS = ['nC90IyjgaIZ8Z0JTABMTiyQHF9g1', 'qa0iQAeVmMOxoy6Vg5ENTRKk0Vm2', 'upyxtXMQEgQXfqTUWPrf6QS9EqE2', '9i6YA66mpXSBcpPJqNmJQ5jnJsT2'];

// Firebase ID Token 검증 헬퍼 (실패 시 null)
async function verifyToken(idToken) {
  if (!idToken || !admin) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (e) {
    return null;
  }
}

module.exports = { admin, db, corsMiddleware, limiter, dailyLimiter, ADMIN_UIDS, verifyToken };
