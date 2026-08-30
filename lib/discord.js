// lib/discord.js — 운영 알림용 Discord 웹훅.
// 설계 원칙:
//  - 채널 분리: cs(문의·환불·결제실패) / sales(매출) / alert(장애, 로그 연동) / growth(가입·쿠폰·초대).
//    각 DISCORD_WEBHOOK_<CHANNEL> env, 없으면 DISCORD_WEBHOOK_URL 단일 채널로 폴백. 둘 다 없으면 no-op.
//  - fire-and-forget: 절대 요청 흐름을 막거나 실패시키지 않음(웹훅 오류는 삼킴, 4초 타임아웃).
//  - 알림 폭주 방지: 같은 키 N초 내 중복 억제(특히 에러).
//  - logger와 의존성 없음(순환 방지) — 자체 실패는 조용히 무시.
const https = require('https');
const { assertOutboundUrl } = require('./outboundPolicy');

function envUrl(name) {
  return process.env['DISCORD_WEBHOOK_' + name] || process.env.DISCORD_WEBHOOK_URL || '';
}
const CHANNELS = {
  cs: envUrl('CS'),
  sales: envUrl('SALES'),
  alert: envUrl('ALERT'),
  growth: envUrl('GROWTH'),
  // 장애 등급별 채널. 미설정이면 alert로 폴백해 기존 동작을 유지한다.
  //  · sev1: 지금 깨워야 하는 것(돈·정합성) — 멘션 포함
  //  · sev3: 기록만 남기는 잡음 — 별도 채널로 빼야 sev1이 묻히지 않는다
  sev1: process.env.DISCORD_WEBHOOK_SEV1 || envUrl('ALERT'),
  sev3: process.env.DISCORD_WEBHOOK_SEV3 || envUrl('ALERT')
};
const COLORS = { cs: 0x5a5bd8, sales: 0x3f9e63, alert: 0xe05a4b, growth: 0x7c6bff, sev1: 0xc0392b, sev3: 0x8a919e };
// SEV1은 기본적으로 @here를 붙인다(DISCORD_ALERT_MENTION으로 변경/해제 가능).
const SEV1_MENTION = process.env.DISCORD_ALERT_MENTION === '' ? '' : (process.env.DISCORD_ALERT_MENTION || '@here');

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
      const u = assertOutboundUrl(url, 'discord');
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

// 웹훅 전송 실패 카운터 — 예전에는 전송이 죽어도 아무도 몰랐다(조용한 게 정상인지 알림이 죽은 건지 구분 불가).
const sendStats = { sent: 0, failed: 0, lastFailedAt: 0, lastChannel: '' };

function send(channel, embed, extra) {
  const url = CHANNELS[channel];
  if (!url) return;
  const payload = {
    ...(extra && extra.content ? { content: cut(extra.content, 1500) } : {}),
    // 멘션은 @here만 허용(역할/개인 대량 멘션 사고 방지)
    allowed_mentions: { parse: ['everyone'] },
    embeds: [{ color: COLORS[channel] || 0x5a5bd8, timestamp: new Date().toISOString(), ...embed }]
  };
  postWebhook(url, payload).then((ok) => {
    if (ok) { sendStats.sent++; return; }
    sendStats.failed++;
    sendStats.lastFailedAt = Date.now();
    sendStats.lastChannel = channel;
  }).catch(() => {});
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
  // 결과 유실 의심 — 차감됐는데 사용자가 결과 화면을 못 봤을 가능성(폴링 401 반복 등). 결과는 서버에 보관됨.
  resultRisk({ uid, jobId, kind, credits, reason, name }) {
    send('cs', {
      title: '⚠️ 결과 유실 의심 — 확인 필요',
      description: '차감은 됐는데 사용자가 결과 화면을 못 봤을 수 있어요. 결과는 서버에 보관돼 있으니 재전송 또는 복구해 주세요.',
      fields: [
        field('회원', name || uid),
        jobId ? field('작업ID', jobId) : null,
        field('종류', kind),
        field('차감', credits != null ? `${credits} 크레딧` : '-'),
        field('상황', reason || '-', false)
      ].filter(Boolean)
    });
  },
  billingFailure({ uid, jobId, mode, credits, billingMode, reason, name }) {
    send('alert', {
      title: '🚨 휴머나이징 과금 실패 — 정산 필요',
      description: '결과는 사용자에게 전달됐지만 실제 차감이 완료되지 않았어요. 멱등 작업 ID로 재정산 여부를 확인해 주세요.',
      fields: [
        field('회원', name || uid),
        jobId ? field('작업ID', jobId) : null,
        field('요청', mode || 'humanize'),
        field('결제 수단', billingMode || 'credit'),
        field('예정 차감', credits != null ? `${credits} 크레딧` : '-'),
        field('사유', reason || '-', false)
      ].filter(Boolean)
    });
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
  // 집계 매출 리포트(일일 자동/온디맨드). fields는 lib/revenue 의 revenueField/revenueEmbed.fields 사용.
  revenueReport({ title, description, fields }) {
    send('sales', { title: title || '📊 매출 리포트', description: description || undefined, fields: fields || [] });
  },

  // ── ③ 장애 알림 (lib/logger → lib/opsEvents 심각도 기반) ──
  // 이전 alertFromLog의 3가지 문제를 고친다:
  //   ① reqId 필드명이 로거(requestId)와 달라 추적키가 항상 비어 나갔다.
  //   ② uid/orderId/jobId/amount 같은 식별자가 빠져 영향 범위를 알 수 없었다.
  //   ③ 억제 키가 상수로 굳어 100건 실패가 알림 1건으로 압축됐다 → 이제 건수를 함께 싣는다.
  opsAlert(record, classification, meta) {
    if (!record || !classification || !classification.sev) return;
    const sev = classification.sev;
    const channel = sev === 'SEV1' ? 'sev1' : (sev === 'SEV3' ? 'sev3' : 'alert');
    if (!CHANNELS[channel]) return;

    const count = (meta && meta.count) || 1;
    // 억제는 이벤트+등급 단위로만 건다(메시지의 고유값 때문에 억제가 무력화되던 문제 제거).
    // SEV1은 억제 창을 짧게 둬서 사고 진행 상황을 놓치지 않는다.
    const windowMs = sev === 'SEV1' ? 60000 : (sev === 'SEV2' ? 180000 : 900000);
    if (throttled('ops:' + record.event + ':' + sev, windowMs)) return;

    const err = record.err || {};
    const icon = sev === 'SEV1' ? '🛑' : (sev === 'SEV2' ? '🚨' : 'ℹ️');
    const badge = count > 1 ? ` · ${count}건` : '';
    const money = [
      record.amount != null ? `₩${Number(record.amount).toLocaleString('ko-KR')}` : null,
      record.credits != null ? `${record.credits}크레딧` : null
    ].filter(Boolean).join(' · ');

    send(channel, {
      title: cut(`${icon} ${sev} · ${classification.domain} · ${record.event || 'log'}${badge}`, 250),
      description: cut(record.message || err.message || '(메시지 없음)', 600),
      fields: [
        // 무엇을 해야 하는지를 알림 안에 넣는다 — 새벽에 봐도 바로 움직일 수 있게.
        classification.action ? field('대응', classification.action, false) : null,
        count > 1 ? field('발생', `${count}건(최근 1분)`) : null,
        // 영향 범위 식별자 — 이게 없어서 매번 Render 로그를 다시 뒤져야 했다.
        record.uid ? field('회원(uid)', record.uid) : null,
        record.orderId ? field('주문', record.orderId) : null,
        record.jobId ? field('작업', record.jobId) : null,
        money ? field('금액', money) : null,
        record.stage ? field('단계', record.stage) : null,
        record.code ? field('코드', record.code) : null,
        record.tier || record.plan ? field('플랜', record.tier || record.plan) : null,
        record.requestId ? field('requestId', record.requestId) : null,   // ← 필드명 수정(이전엔 reqId라 항상 누락)
        record.method && record.path ? field('요청', `${record.method} ${record.path}`) : (record.path ? field('path', record.path) : null),
        err.status || record.statusCode ? field('status', err.status || record.statusCode) : null,
        field('env', `${record.env || '-'}${record.commit ? ` · ${String(record.commit).slice(0, 7)}` : ''}`),
        err.stack ? field('stack', '```' + cut(err.stack, 800) + '```', false) : null
      ].filter(Boolean)
    }, sev === 'SEV1' && SEV1_MENTION ? { content: `${SEV1_MENTION} SEV1 — ${cut(record.event, 120)}` } : null);
  },

  // 하위호환: 예전 이름으로 호출하던 코드가 남아 있어도 동작하게 둔다(레벨만으로 등급 추정).
  alertFromLog(record) {
    if (!record || record.noAlert) return;
    let opsEvents = null;
    try { opsEvents = require('./opsEvents'); } catch (_) { return; }
    const classification = opsEvents.classify(record.event, record.level);
    if (!classification.sev) return;
    module.exports.opsAlert(record, classification, { count: 1 });
  },

  // 주기 리포트(장애 다이제스트) — 매출 리포트와 같은 패턴.
  opsDigest({ title, description, fields, severe }) {
    send(severe ? 'sev1' : 'alert', {
      title: title || '🩺 운영 다이제스트',
      description: description || undefined,
      fields: fields || []
    });
  },

  webhookStats() { return { ...sendStats }; },

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
