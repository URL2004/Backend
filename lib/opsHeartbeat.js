// lib/opsHeartbeat.js — 부재 감지(dead man's switch).
//
// 왜 필요한가: 우리 알림은 앱이 스스로 보낸다. 그래서 "무언가 일어났을 때"만 알 수 있고
// "일어나야 할 일이 안 일어난 것"은 영원히 모른다. 실제로 구독 갱신 cron이 매시간 403으로
// 조용히 죽어 있던 사고가 이 유형이었다(로그는 warn 한 줄, 알림 0건).
//
// 동작: 주기 작업이 성공할 때마다 beat()로 도장을 찍고,
//       워치독(POST /cron/ops-watchdog)이 "예상 주기 × 여유"를 넘도록 도장이 없으면 SEV1을 만든다.
//
// 저장: Firestore `opsHeartbeats/{name}`. Firestore가 없으면 메모리로만 동작(단일 인스턴스 한정).

const COLLECTION = 'opsHeartbeats';

// 감시 대상과 기대 주기(분). graceMinutes를 넘겨 도장이 없으면 장애로 본다.
const EXPECTED = {
  'subscription.process_due': { everyMinutes: 60, graceMinutes: 150, label: '구독 갱신 배치' },
  'revenue.daily_report': { everyMinutes: 1440, graceMinutes: 2160, label: '일일 매출 리포트' },
  'ops.digest': { everyMinutes: 1440, graceMinutes: 2160, label: '운영 다이제스트' }
};

let _cfg;
function getDb() {
  if (_cfg === undefined) { try { _cfg = require('../config'); } catch (_) { _cfg = null; } }
  return (_cfg && _cfg.db) || null;
}

const memory = new Map();

// 주기 작업이 성공했음을 기록한다. 절대 예외를 던지지 않는다.
function beat(name, meta) {
  const nowMs = Date.now();
  memory.set(name, { at: nowMs, meta: meta || null });
  const db = getDb();
  if (!db) return Promise.resolve(false);
  return db.collection(COLLECTION).doc(name).set({
    name,
    lastBeatAt: new Date(nowMs).toISOString(),
    lastBeatMs: nowMs,
    meta: meta || null
  }, { merge: true }).then(() => true).catch(() => false);
}

async function readAll() {
  const db = getDb();
  const out = {};
  for (const [name, cfg] of Object.entries(EXPECTED)) {
    out[name] = { name, label: cfg.label, everyMinutes: cfg.everyMinutes, graceMinutes: cfg.graceMinutes, lastBeatMs: 0, source: 'none' };
  }
  for (const [name, v] of memory) {
    if (!out[name]) out[name] = { name, label: name, everyMinutes: 0, graceMinutes: 0, lastBeatMs: 0, source: 'none' };
    out[name].lastBeatMs = v.at;
    out[name].source = 'memory';
  }
  if (db) {
    try {
      const snap = await db.collection(COLLECTION).get();
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const name = doc.id;
        if (!out[name]) out[name] = { name, label: name, everyMinutes: 0, graceMinutes: 0, lastBeatMs: 0, source: 'none' };
        if (Number(d.lastBeatMs) > (out[name].lastBeatMs || 0)) {
          out[name].lastBeatMs = Number(d.lastBeatMs) || 0;
          out[name].source = 'firestore';
        }
        out[name].meta = d.meta || out[name].meta || null;
      });
    } catch (_) { /* 조회 실패 시 메모리 값만 사용 */ }
  }
  const nowMs = Date.now();
  return Object.values(out).map((h) => {
    const ageMinutes = h.lastBeatMs ? Math.round((nowMs - h.lastBeatMs) / 60000) : null;
    const grace = h.graceMinutes || 0;
    // 한 번도 뛴 적이 없으면(배포 직후 등) 장애로 단정하지 않고 unknown으로 둔다.
    const state = !h.lastBeatMs ? 'unknown' : (grace && ageMinutes > grace ? 'stale' : 'ok');
    return { ...h, ageMinutes, state, lastBeatAt: h.lastBeatMs ? new Date(h.lastBeatMs).toISOString() : null };
  });
}

module.exports = { COLLECTION, EXPECTED, beat, readAll };
