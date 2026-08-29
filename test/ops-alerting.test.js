// 장애 알림 경로 회귀 테스트(2026-08-29 운영 로그 개편).
//
// 왜 이 테스트가 필요한가: 개편 전에는 알림 경로에 테스트가 0건이었고, 그 결과
//   · 결제 실패 대부분이 warn이라 알림이 한 건도 안 갔고,
//   · Discord가 읽는 필드명(reqId)이 로거가 쓰는 이름(requestId)과 달라 추적키가 항상 비어 나갔다.
// 둘 다 코드를 읽어야만 보이는 종류의 사고라, 여기서 문자열이 아니라 "실제 전송 페이로드"를 잠근다.

const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const path = require('node:path');

// ── https.request를 가로채 전송 페이로드를 수집한다(실제 네트워크 호출 없음) ──
const sent = [];
const realRequest = https.request;
https.request = function stubRequest(options, callback) {
  let body = '';
  const res = { on: (evt, fn) => { if (evt === 'end') setImmediate(fn); return res; } };
  return {
    on() { return this; },
    write(chunk) { body += chunk.toString(); },
    end() {
      try { sent.push({ host: options.hostname, payload: JSON.parse(body) }); } catch (_) { sent.push({ host: options.hostname, raw: body }); }
      if (callback) setImmediate(() => callback(res));
    },
    destroy() {}
  };
};

// 채널 URL은 모듈 로드 시점에 읽히므로 require 전에 설정해야 한다.
process.env.DISCORD_WEBHOOK_ALERT = 'https://discord.test/webhooks/alert';
process.env.DISCORD_WEBHOOK_SEV1 = 'https://discord.test/webhooks/sev1';
process.env.DISCORD_WEBHOOK_SEV3 = 'https://discord.test/webhooks/sev3';
process.env.LOG_LEVEL = 'debug';

const opsEvents = require('../lib/opsEvents');
const discord = require('../lib/discord');

function reset() { sent.length = 0; }
function lastEmbed() { return sent.length ? sent[sent.length - 1].payload.embeds[0] : null; }
function fieldValue(embed, name) {
  const f = (embed.fields || []).find(x => x.name === name);
  return f ? f.value : null;
}
// 억제(throttle)는 이벤트명 단위라 테스트마다 다른 이벤트명을 써야 한다.
let seq = 0;
function uniqueEvent(base) { return `${base}.t${++seq}`; }

test.after(() => { https.request = realRequest; });

test('카탈로그: 결제 실패는 warn이어도 알림 대상이다(개편 전에는 전부 침묵했다)', () => {
  // 개편 전 조건("error/fatal만 알림")이었다면 아래는 전부 알림이 안 갔다.
  assert.equal(opsEvents.classify('client.payment_error', 'warn').sev, 'SEV2');
  assert.equal(opsEvents.classify('payment.toss_confirm_failed', 'warn').sev, 'SEV2');
  assert.equal(opsEvents.classify('payment.uid_mismatch_blocked', 'warn').sev, 'SEV1');
  // ★ 과거 실사고(매시간 403으로 구독 갱신이 조용히 멈춤)와 같은 경로
  assert.equal(opsEvents.classify('subscription.cron_secret_rejected', 'warn').sev, 'SEV1');
  assert.equal(opsEvents.classify('subscription.first_charge_failed', 'warn').sev, 'SEV2');
  assert.equal(opsEvents.classify('toss.webhook_ignored', 'warn').sev, 'SEV2');
});

test('카탈로그: 카드사 거절은 조용히, 미등록 warn은 알리지 않는다(알림 피로 방지)', () => {
  assert.equal(opsEvents.classify('client.payment_declined', 'warn').sev, 'SEV3');
  assert.equal(opsEvents.classify('transform.limit_blocked', 'warn').sev, null, '미등록 warn은 알림 대상이 아니어야 한다');
  assert.equal(opsEvents.classify('some.unknown_event', 'error').sev, 'SEV2', '미등록 error는 SEV2로 폴백해야 한다');
  assert.equal(opsEvents.classify('some.unknown_event', 'fatal').sev, 'SEV1');
});

test('모든 카탈로그 항목은 등급과 대응 안내를 갖는다(새벽에 봐도 움직일 수 있게)', () => {
  for (const [event, meta] of Object.entries(opsEvents.CATALOG)) {
    assert.ok(['SEV1', 'SEV2', 'SEV3'].includes(meta.sev), `${event}: 등급 누락`);
    assert.ok(meta.domain && typeof meta.domain === 'string', `${event}: 도메인 누락`);
    assert.ok(meta.action && meta.action.length >= 10, `${event}: 대응 안내가 비었다`);
  }
});

test('알림 페이로드에 추적키와 비즈니스 식별자가 들어간다', () => {
  reset();
  const event = uniqueEvent('payment.apply_failed_reconciliation_required');
  discord.opsAlert({
    event,
    level: 'error',
    message: '크레딧 지급 실패',
    requestId: 'req-abc-123',      // ← 개편 전에는 discord가 record.reqId를 읽어 항상 비었다
    uid: 'user-9',
    orderId: 'order-77',
    jobId: 'job-5',
    amount: 14500,
    credits: 600,
    env: 'production',
    method: 'POST',
    path: '/confirm-payment'
  }, { sev: 'SEV1', domain: 'payment', action: '수동 지급 필요', cataloged: true }, { count: 1 });

  const embed = lastEmbed();
  assert.ok(embed, '알림이 전송돼야 한다');
  assert.equal(fieldValue(embed, 'requestId'), 'req-abc-123', 'requestId가 실려야 한다(reqId 오타 회귀 방지)');
  assert.equal(fieldValue(embed, '회원(uid)'), 'user-9');
  assert.equal(fieldValue(embed, '주문'), 'order-77');
  assert.equal(fieldValue(embed, '작업'), 'job-5');
  assert.match(fieldValue(embed, '금액'), /14,500/, '금액이 사람이 읽는 형식이어야 한다');
  assert.match(fieldValue(embed, '금액'), /600크레딧/);
  assert.equal(fieldValue(embed, '대응'), '수동 지급 필요');
  assert.match(embed.title, /SEV1/);
  assert.match(embed.title, /payment/);
});

test('SEV1은 전용 채널로 가고 멘션을 붙인다', () => {
  reset();
  discord.opsAlert({ event: uniqueEvent('payment.status_unknown'), level: 'error', message: 'x' },
    { sev: 'SEV1', domain: 'payment', action: '확인', cataloged: true }, { count: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.embeds[0].title.includes('SEV1'), true);
  assert.ok(String(sent[0].payload.content || '').includes('SEV1'), 'SEV1은 멘션 본문이 있어야 한다');
  // 대량 멘션 사고 방지: allowed_mentions가 everyone(=@here)만 허용해야 한다
  assert.deepEqual(sent[0].payload.allowed_mentions, { parse: ['everyone'] });
});

test('SEV3는 멘션 없이 조용한 채널로 간다', () => {
  reset();
  discord.opsAlert({ event: uniqueEvent('client.payment_declined'), level: 'warn', message: '카드사 거절' },
    { sev: 'SEV3', domain: 'payment', action: '개별 대응 불필요', cataloged: true }, { count: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.content, undefined, 'SEV3에는 멘션이 없어야 한다');
  assert.match(sent[0].payload.embeds[0].title, /SEV3/);
});

test('반복 사건은 억제하되 발생 건수를 함께 알린다(사고 규모가 보여야 한다)', () => {
  reset();
  const event = uniqueEvent('payment.toss_confirm_failed');
  const cls = { sev: 'SEV2', domain: 'payment', action: '확인', cataloged: true };
  discord.opsAlert({ event, level: 'warn', message: '실패' }, cls, { count: 37 });
  const first = lastEmbed();
  assert.match(first.title, /37건/, '제목에 건수가 보여야 한다');
  assert.equal(fieldValue(first, '발생'), '37건(최근 1분)');

  const before = sent.length;
  discord.opsAlert({ event, level: 'warn', message: '실패' }, cls, { count: 38 });
  assert.equal(sent.length, before, '같은 이벤트는 억제 창 안에서 다시 보내지 않아야 한다');
});

test('억제 키는 메시지가 아니라 이벤트 기준이다(고유 메시지로 억제가 뚫리지 않게)', () => {
  reset();
  const event = uniqueEvent('refund.toss_cancel_failed');
  const cls = { sev: 'SEV2', domain: 'refund', action: '확인', cataloged: true };
  discord.opsAlert({ event, level: 'error', message: '주문 A 실패' }, cls, { count: 1 });
  discord.opsAlert({ event, level: 'error', message: '주문 B 실패' }, cls, { count: 2 });
  discord.opsAlert({ event, level: 'error', message: '주문 C 실패' }, cls, { count: 3 });
  assert.equal(sent.length, 1, '메시지가 달라도 같은 이벤트면 한 번만 보내야 한다');
});

test('등급이 없는 기록은 전송하지 않는다', () => {
  reset();
  discord.opsAlert({ event: uniqueEvent('noise'), level: 'warn' }, { sev: null, domain: 'ops', action: '' }, { count: 1 });
  assert.equal(sent.length, 0);
});

test('logger는 카탈로그 등급에 따라 알림을 보내고 미등록 warn은 조용하다', () => {
  reset();
  const { logger } = require('../lib/logger');
  // 미등록 warn → 알림 없음
  logger.warn('transform.limit_blocked', { uid: 'u1' });
  assert.equal(sent.length, 0, '미등록 warn은 알림이 없어야 한다');

  // 카탈로그 등록 warn → 알림 발생 + 식별자 전달
  logger.warn('payment.uid_mismatch_blocked', { clientUid: 'a', verifiedUid: 'b', orderId: 'ord-x', amount: 2900 });
  assert.equal(sent.length, 1, '카탈로그 등록 warn은 알림이 가야 한다');
  const embed = lastEmbed();
  assert.match(embed.title, /SEV1/);
  assert.equal(fieldValue(embed, '주문'), 'ord-x');

  // 접근 로그(noAlert)는 5xx여도 Discord로 중복 발송하지 않는다(실제 에러는 별도 이벤트가 보낸다).
  // 다만 기록은 남아야 한다 — 5xx 급증 탐지와 사후 분석에 쓰인다.
  reset();
  const opsLog = require('../lib/opsLog');
  const beforeRing = opsLog.recentFromMemory(300).length;
  logger.error('http.request', { statusCode: 500, noAlert: true, path: '/confirm-payment' });
  assert.equal(sent.length, 0, 'noAlert는 Discord 중복 발송을 막아야 한다');
  const afterRing = opsLog.recentFromMemory(300);
  assert.ok(afterRing.length > beforeRing, 'noAlert여도 기록은 남아야 한다(관리자 화면·급증 탐지용)');
  assert.equal(afterRing[0].event, 'http.request');
});

test('opsLog는 사건을 기록하고 같은 사건을 창 안에서 병합한다', () => {
  const opsLog = require('../lib/opsLog');
  const cls = { sev: 'SEV2', domain: 'payment', action: '확인', cataloged: true };
  const event = uniqueEvent('payment.merge_check');
  const first = opsLog.record({ event, level: 'warn', message: '1', uid: 'u1' }, cls);
  assert.equal(first.merged, false, '첫 건은 병합이 아니어야 한다');
  const recent = opsLog.recentFromMemory(5);
  assert.ok(recent.some(r => r.event === event), '메모리 링버퍼에 남아야 한다');
  // 링버퍼 항목은 판단에 필요한 필드를 보존한다
  const row = recent.find(r => r.event === event);
  assert.equal(row.severity, 'SEV2');
  assert.equal(row.domain, 'payment');
  assert.equal(row.uid, 'u1');
});

test('opsLog는 도메인 실패가 임계를 넘으면 급증을 보고한다', () => {
  const opsLog = require('../lib/opsLog');
  const cls = { sev: 'SEV2', domain: 'refund', action: '확인', cataloged: true };
  let surge = null;
  // refund 임계 3건
  for (let i = 0; i < 4 && !surge; i++) {
    const out = opsLog.record({ event: uniqueEvent('refund.surge_check'), level: 'error', message: String(i) }, cls);
    surge = out.surge;
  }
  assert.ok(surge, '임계 초과 시 급증이 보고돼야 한다');
  assert.equal(surge.domain, 'refund');
  assert.ok(surge.count >= surge.threshold);
});

test('민감정보는 알림 경로에도 실리지 않는다', () => {
  reset();
  const { logger } = require('../lib/logger');
  const sensitivePaymentKey = 'payment-key-sensitive-sample';
  logger.error('payment.apply_failed_reconciliation_required', {
    uid: 'u1', orderId: 'o1', paymentKey: sensitivePaymentKey, email: 'someone@example.com'
  });
  const raw = JSON.stringify(sent);
  assert.ok(!raw.includes(sensitivePaymentKey), 'paymentKey 원문이 알림에 실리면 안 된다');
  assert.ok(!raw.includes('someone@example.com'), '이메일 원문이 알림에 실리면 안 된다');
});

test('부재 감지: 하트비트가 기대 주기를 넘기면 stale로 판정한다', async () => {
  const hb = require('../lib/opsHeartbeat');
  await hb.beat('subscription.process_due', { processed: 3 });
  const rows = await hb.readAll();
  const due = rows.find(r => r.name === 'subscription.process_due');
  assert.equal(due.state, 'ok', '방금 뛰었으면 ok여야 한다');
  // 한 번도 안 뛴 항목은 unknown(배포 직후를 장애로 단정하지 않는다)
  const never = rows.find(r => r.state === 'unknown');
  assert.ok(never === undefined || never.lastBeatMs === 0);
  // 감시 대상에는 과거 사고 유형(구독 갱신 배치)이 반드시 포함돼야 한다
  assert.ok(hb.EXPECTED['subscription.process_due'], '구독 갱신 배치는 감시 대상이어야 한다');
});

test('라우트 계약: 결제 오류는 우리 장애와 카드 거절을 다른 이벤트로 남긴다', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'events.js'), 'utf8');
  assert.match(src, /client\.payment_declined/, '카드 거절 전용 이벤트가 있어야 한다');
  assert.match(src, /client\.payment_error_flood/, '리포트 폭주(대량 장애 신호)를 남겨야 한다');
  assert.match(src, /client_error/, '프론트 전역 오류 수집 경로가 있어야 한다');
});
