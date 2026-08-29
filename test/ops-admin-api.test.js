// 관리자 장애 로그 API 계약 테스트(2026-08-29).
// config를 스텁으로 갈아끼워 Firebase 없이 라우트 자체의 인증·필터·응답 형태를 잠근다.
// 여기서 지키려는 것: ① 비관리자 차단 ② 등급/도메인/검색 필터 ③ 확인(ack) 기록
//                   ④ 저장소 장애 시에도 화면이 비지 않는 폴백.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

// ── config 스텁: require.cache에 먼저 심어야 라우트가 이걸 집는다 ──
const configPath = require.resolve('../config');
const docs = new Map();
let failReads = false;

function makeDoc(id, data) { docs.set(id, { id, ...data }); }

const fakeDb = {
  collection(name) {
    return {
      orderBy() { return this; },
      limit() { return this; },
      async get() {
        if (failReads) throw new Error('firestore unavailable');
        const rows = [...docs.values()].sort((a, b) => b.createdMs - a.createdMs);
        return { forEach: (fn) => rows.forEach(r => fn({ id: r.id, data: () => r })) };
      },
      doc(id) {
        return {
          async update(patch) {
            if (!docs.has(id)) throw new Error('not found');
            docs.set(id, { ...docs.get(id), ...patch });
          },
          async set(patch) { docs.set(id, { ...(docs.get(id) || {}), ...patch }); }
        };
      }
    };
  }
};

require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, exports: {
    db: fakeDb,
    admin: null,
    ADMIN_UIDS: ['admin-uid'],
    // 토큰 문자열을 그대로 uid로 취급하는 스텁
    verifyToken: async (token) => (token ? String(token) : null),
    verifyFirebaseIdToken: async (token) => ({ uid: String(token) })
  }
};

const opsRouter = require('../routes/opsLogs');

let server, baseUrl;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', opsRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); delete require.cache[configPath]; });

async function post(pathname, body, token) {
  const res = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function seed() {
  docs.clear();
  const now = Date.now();
  makeDoc('i1', { event: 'payment.apply_failed_reconciliation_required', severity: 'SEV1', domain: 'payment', message: '크레딧 지급 실패', uid: 'user-9', orderId: 'order-77', amount: 14500, count: 1, createdMs: now - 1000, lastSeenMs: now - 1000, acked: false, action: '수동 지급' });
  makeDoc('i2', { event: 'client.payment_declined', severity: 'SEV3', domain: 'payment', message: '카드사 거절', uid: 'user-3', count: 5, createdMs: now - 2000, lastSeenMs: now - 2000, acked: false });
  makeDoc('i3', { event: 'transform.persist_failed', severity: 'SEV2', domain: 'engine', message: '작업 저장 실패', jobId: 'job-1', count: 2, createdMs: now - 3000, lastSeenMs: now - 3000, acked: true });
  failReads = false;
}

test('비로그인·비관리자는 장애 로그에 접근할 수 없다', async () => {
  seed();
  assert.equal((await post('/admin/ops-logs', {})).status, 401, '토큰 없으면 401');
  const forbidden = await post('/admin/ops-logs', {}, 'someone-else');
  assert.equal(forbidden.status, 403, '관리자 UID가 아니면 403');
  assert.equal((await post('/admin/ops-summary', {}, 'someone-else')).status, 403);
  assert.equal((await post('/admin/ops-ack', { id: 'i1' }, 'someone-else')).status, 403);
});

test('목록은 등급·도메인·미확인·검색어로 걸러진다', async () => {
  seed();
  const all = await post('/admin/ops-logs', {}, 'admin-uid');
  assert.equal(all.status, 200);
  assert.equal(all.body.items.length, 3);
  assert.deepEqual(all.body.domains, ['engine', 'payment'], '도메인 목록이 필터 옵션으로 내려와야 한다');

  const sev1 = await post('/admin/ops-logs', { severity: 'SEV1' }, 'admin-uid');
  assert.equal(sev1.body.items.length, 1);
  assert.equal(sev1.body.items[0].event, 'payment.apply_failed_reconciliation_required');

  const engine = await post('/admin/ops-logs', { domain: 'engine' }, 'admin-uid');
  assert.equal(engine.body.items.length, 1);

  const open = await post('/admin/ops-logs', { onlyOpen: true }, 'admin-uid');
  assert.equal(open.body.items.length, 2, '확인 완료 건은 미확인 목록에서 빠져야 한다');

  // 고객 문의 대응 시나리오: 주문번호로 바로 찾을 수 있어야 한다
  const byOrder = await post('/admin/ops-logs', { q: 'order-77' }, 'admin-uid');
  assert.equal(byOrder.body.items.length, 1);
  assert.equal(byOrder.body.items[0].uid, 'user-9');

  const minSev = await post('/admin/ops-logs', { minSeverity: 'SEV2' }, 'admin-uid');
  assert.equal(minSev.body.items.length, 2, 'SEV2 이상만 남아야 한다');
});

test('요약은 등급 합계와 미확인 SEV1, 하트비트, 알림 상태를 함께 준다', async () => {
  seed();
  const { status, body } = await post('/admin/ops-summary', { hours: 24 }, 'admin-uid');
  assert.equal(status, 200);
  // count(발생 횟수)까지 합산해야 사고 규모가 보인다
  assert.equal(body.bySeverity.SEV1, 1);
  assert.equal(body.bySeverity.SEV3, 5, '병합된 발생 횟수가 반영돼야 한다');
  assert.equal(body.occurrences, 8);
  assert.equal(body.openSev1, 1);
  assert.ok(Array.isArray(body.heartbeats) && body.heartbeats.length, '주기 작업 상태가 포함돼야 한다');
  assert.ok(body.heartbeats.some(h => h.name === 'subscription.process_due'));
  assert.ok(body.alerting && typeof body.alerting.discord === 'boolean', '알림 채널 상태가 포함돼야 한다');
  assert.ok(body.topEvents[0].action !== undefined, '많이 난 사건에 대응 안내가 붙어야 한다');
});

test('확인 처리는 누가 했는지 남기고 미확인 목록에서 뺀다', async () => {
  seed();
  const ack = await post('/admin/ops-ack', { id: 'i1', acked: true, note: '수동 지급 완료' }, 'admin-uid');
  assert.equal(ack.status, 200);
  const row = docs.get('i1');
  assert.equal(row.acked, true);
  assert.equal(row.ackedBy, 'admin-uid');
  assert.equal(row.ackNote, '수동 지급 완료');
  assert.ok(row.ackedAt, '확인 시각이 남아야 한다');

  const open = await post('/admin/ops-logs', { onlyOpen: true }, 'admin-uid');
  assert.ok(!open.body.items.some(i => i.id === 'i1'));

  // 되돌리기도 가능해야 한다(오확인 복구)
  await post('/admin/ops-ack', { id: 'i1', acked: false }, 'admin-uid');
  assert.equal(docs.get('i1').acked, false);
  assert.equal(docs.get('i1').ackedBy, null);
});

test('저장소 조회가 실패해도 화면은 비지 않는다(메모리 폴백)', async () => {
  seed();
  failReads = true;
  const { status, body } = await post('/admin/ops-logs', {}, 'admin-uid');
  failReads = false;
  assert.equal(status, 200, '조회 실패가 500으로 새어나가면 안 된다');
  assert.equal(body.source, 'memory_fallback');
  assert.ok(Array.isArray(body.items));
});

test('워치독은 cron 시크릿을 요구하고, 실패를 조용히 넘기지 않는다', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'sekret';
  try {
    const bad = await fetch(baseUrl + '/cron/ops-watchdog', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': 'wrong' }, body: '{}'
    });
    assert.equal(bad.status, 401);

    const ok = await fetch(baseUrl + '/cron/ops-watchdog', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': 'sekret' }, body: '{}'
    });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.ok(Array.isArray(data.beats));
    assert.ok(data.beats.some(b => b.name === 'subscription.process_due'), '과거 사고 유형(구독 갱신)이 감시 대상이어야 한다');
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
});

test('LOGGING 문서와 카탈로그가 같은 이벤트 이름을 쓴다', () => {
  const fs = require('node:fs');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'LOGGING.md'), 'utf8');
  const opsEvents = require('../lib/opsEvents');
  // 문서가 "주요 이벤트"로 안내하는 결제 항목은 카탈로그에도 있어야 한다(문서-코드 드리프트 방지)
  for (const name of ['payment.toss_confirm_failed', 'subscription.charge_failed', 'toss.webhook_handler_failed']) {
    assert.ok(doc.includes(name), `LOGGING.md에 ${name}가 있어야 한다`);
    assert.ok(opsEvents.CATALOG[name], `카탈로그에 ${name}가 있어야 한다`);
  }
});
