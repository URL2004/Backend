// [lib/clientip.js] 실제 클라이언트 IP 판별(2026-07-20)
// ────────────────────────────────────────────────────────────────
// Render(onrender.com)는 Cloudflare 뒤에 있어(Server: cloudflare·CF-RAY 확인),
// app.set('trust proxy', 1) 상태의 req.ip는 매 요청 달라지는 CF 엣지 IP가 된다.
// 실사고: 무료 감지 일일 한도(3회/IP) 키가 엣지 IP별로 흩어져 사실상 무제한
// (같은 IP 연속 4회가 remainingToday 2,2,1,0 — 402 전환 없음, 2026-07-20 실측).
//
// 우선순위:
//  ① cf-connecting-ip — CF가 항상 실제 접속 IP로 덮어쓰므로 클라이언트가 위조 불가(전 트래픽이 CF 경유일 때).
//  ② x-forwarded-for 첫 항목 — CF 미경유 배포(로컬·다른 호스트) 폴백. 클라이언트가 앞에 끼워 넣을 수
//     있어 어뷰즈 키로는 약하지만(감사 M-1), 정상 사용자에겐 안정적인 값.
//  ③ req.ip — 직접 연결.
function realClientIp(req) {
  const cf = req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return (req.ip || '').toString() || 'unknown';
}

module.exports = { realClientIp };
