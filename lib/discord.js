// lib/discord.js — 운영 알림용 Discord 웹훅.
// 설계 원칙:
//  - 채널 분리: cs(문의·환불·결제실패) / sales(매출) / alert(장애, 로그 연동) / growth(가입·쿠폰·초대).
//    각 DISCORD_WEBHOOK_<CHANNEL> env, 없으면 DISCORD_WEBHOOK_URL 단일 채널로 폴백. 둘 다 없으면 no-op.
//  - fire-and-forget: 절대 요청 흐름을 막거나 실패시키지 않음(웹훅 오류는 삼킴, 4초 타임아웃).
//  - 알림 폭주 방지: 같은 키 N초 내 중복 억제(특히 에러).
//  - logger와 의존성 없음(순환 방지) — 자체 실패는 조용히 무시.
const https = require('https');

function envUrl(name) {
  return process.env['DISCORD_WEBHOOK_' + name] || process.env.DISCORD_WEBHOOK_URL || '';
}
const CHANNELS = {
  cs: envUrl('CS'),
  sales: envUrl('SALES'),
  alert: envUrl('ALERT'),
  growth: envUrl('GROWTH')
};
const COLORS = { cs: 0x5a5bd8, sales: 0x3f9e63, alert: 0xe05a4b, growth: 0x7c6bff };

const recent = new Map();
function throttled(key, windowMs) {
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last < windowMs) return true;
  recent.set(key, now);
  if (recent.size > 500) { for (const [k, t] of recent) if (now - t > 600000) recent.delete(k); }
  return false;
}

function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function field(name, value, inline = true) { return { name: cut(name, 256), value: cut(value == null || value === '' ? '-' : value, 1024), inline }; }

function postWebhook(url, payload) {
  return new Promise((resolve) => {
    try {
      const data = Buffer.from(JSON.stringify(payload));
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 4000
      }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(data); req.end();
    } catch (_) { resolve(false); }
  });
}

function send(channel, embed) {
  const url = CHANNELS[channel];
  if (!url) return;
  const payload = { embeds: [{ color: COLORS[channel] || 0x5a5bd8, timestamp: new Date().toISOString(), ...embed }] };
  postWebhook(url, payload).catch(() => {});
}

module.exports = {
  send,
  enabled: () => Object.values(CHANNELS).some(Boolean),

  // ── ① CS (즉시 대응) ──
  inquiry({ title, body, author, uid, id }) {
    send('cs', {
      title: '🆕 새 문의가 등록됐어요',
      description: (title ? `**${cut(title, 200)}**\n` : '') + cut(body || '', 600),
      fields: [field('작성자', author || '익명'), id ? field('문의ID', id) : null, uid ? field('UID', uid) : null].filter(Boolean)
    });
  },
  refundRequest({ uid, amount, credits, reason, name }) {
    send('cs', {
      title: '💸 환불 요청',
      fields: [field('회원', name || uid), field('금액', amount != null ? `₩${Number(amount).toLocaleString()}` : '-'), field('크레딧', credits), field('사유', reason || '-', false)]
    });
  },
  paymentFailed({ uid, tier, reason, name }) {
    send('cs', { title: '⚠️ 정기결제 실패(past_due)', fields: [field('회원', name || uid), field('플랜', tier), field('사유', reason || '-', false)] });
  },

  // ── ② 매출 ──
  paymentDone({ uid, amount, credits, kind, name }) {
    send('sales', {
      title: '💰 결제 완료' + (kind ? ` · ${kind}` : ''),
      fields: [field('금액', `₩${Number(amount || 0).toLocaleString()}`), field('크레딧', credits != null ? `+${credits}` : '-'), field('회원', name || uid)]
    });
  },
  subscription({ uid, tier, action, name }) {
    send('sales', { title: `🔁 구독 ${action || ''}`.trim(), fields: [field('플랜', tier), field('회원', name || uid)] });
  },

  // ── ③ 장애 (로그 시스템 연동) ──
  alertFromLog(record) {
    if (!CHANNELS.alert || !record) return;
    const err = record.err || {};
    const key = (record.event || 'log') + ':' + (err.message || record.message || '');
    if (throttled('alert:' + key, 30000)) return;   // 같은 에러 30초 억제
    send('alert', {
      title: `${record.level === 'fatal' ? '🛑 FATAL' : '🚨 ERROR'} · ${cut(record.event || 'log', 200)}`,
      description: cut(record.message || err.message || '(메시지 없음)', 600),
      fields: [
        field('env', record.env || '-'), field('서비스', record.service || '-'),
        record.reqId ? field('reqId', record.reqId) : null,
        record.method && record.path ? field('요청', `${record.method} ${record.path}`, false) : (record.path ? field('path', record.path, false) : null),
        err.status ? field('status', err.status) : null,
        err.stack ? field('stack', '```' + cut(err.stack, 900) + '```', false) : null
      ].filter(Boolean)
    });
  },

  // ── ④ 성장 ──
  signup({ uid, via, name }) {
    send('growth', { title: '🎉 신규 가입', fields: [field('경로', via || '-'), field('회원', name || uid)] });
  },
  couponUsed({ uid, code, credits, name }) {
    send('growth', { title: '🎟️ 쿠폰 사용', fields: [field('코드', code), field('크레딧', credits != null ? `+${credits}` : '-'), field('회원', name || uid)] });
  },
  referral({ inviter, invitee }) {
    send('growth', { title: '🤝 친구 초대 성공', fields: [field('초대자', inviter || '-'), field('가입자', invitee || '-')] });
  }
};
