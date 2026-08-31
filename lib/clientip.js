// [lib/clientip.js] 실제 클라이언트 IP 판별(2026-07-20)
// ────────────────────────────────────────────────────────────────
// Render(onrender.com)는 Cloudflare 뒤에 있어(Server: cloudflare·CF-RAY 확인),
// app.set('trust proxy', 1) 상태의 req.ip는 매 요청 달라지는 CF 엣지 IP가 된다.
// 실사고: 무료 감지 일일 한도(3회/IP) 키가 엣지 IP별로 흩어져 사실상 무제한
// (같은 IP 연속 4회가 remainingToday 2,2,1,0 — 402 전환 없음, 2026-07-20 실측).
//
// cf-connecting-ip는 Cloudflare를 강제하는 ingress에서만 신뢰할 수 있다. Render의
// onrender.com 직접 주소에서는 공격자가 같은 이름의 헤더를 보낼 수 있으므로 명시적
// TRUST_CF_CONNECTING_IP=1 없이는 사용하지 않는다. XFF 첫 항목도 같은 이유로 직접 읽지 않는다.
const net = require('node:net');

function validIp(value) {
  const candidate = String(value || '').trim();
  return net.isIP(candidate) ? candidate : '';
}

function realClientIp(req) {
  if (process.env.TRUST_CF_CONNECTING_IP === '1') {
    const cf = validIp(req.headers && req.headers['cf-connecting-ip']);
    if (cf) return cf;
  }
  return validIp(req.ip) || validIp(req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { realClientIp, validIp };
