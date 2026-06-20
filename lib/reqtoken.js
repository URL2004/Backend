// [lib/reqtoken.js] 요청에서 Firebase idToken 추출 — Authorization: Bearer 우선, body/query는 폴백(deprecated).
// ────────────────────────────────────────────────────────────────
//   감사 권고(2026-06-19): idToken을 query/body로 받으면 접근 로그·referrer·프록시에 장기 토큰이 노출된다.
//   ★무파손 전환: 헤더를 우선 받되 body/query 폴백은 유지(프론트 미전환 호출도 그대로 200). 폴백을 탔을 때만
//   경고 로그를 남겨 "아직 헤더로 안 옮긴 호출"의 잔여량을 측정 → 0에 수렴하면 폴백 제거(별도 작업).
const { logger } = require('./logger');

// Express req에서 Bearer 토큰을 뽑는다. req.get(Express)·req.headers(테스트 목) 둘 다 지원.
function bearerToken(req) {
  if (!req) return '';
  const auth = (typeof req.get === 'function' ? req.get('authorization') : '')
    || (req.headers && req.headers.authorization) || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  // ── 폴백(deprecated) — 잔여 측정 후 제거 예정 ──
  const route = (req.path || req.originalUrl || req.url || '').toString().slice(0, 80);
  if (req.body && req.body.idToken) {
    try { logger.warn('auth.idtoken_in_body_deprecated', { route, via: 'body' }); } catch {}
    return req.body.idToken;
  }
  // ★ H-04: query(URL) 토큰 폴백 제거 — 접근로그·referrer·프록시에 장기 토큰이 남는 노출 경로 차단.
  return '';
}

module.exports = { bearerToken };
