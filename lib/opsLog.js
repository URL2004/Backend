// lib/opsLog.js — 장애 로그 영속화 + 급증 감지.
//
// 역할:
//   1) 알림 대상 사건을 Firestore `opsLogs`에 남긴다 → 관리자 페이지에서 검색·확인(ack)할 수 있다.
//      (Render stdout은 보존 기간이 짧아 며칠 지난 사고의 사후 분석이 불가능했다.)
//   2) 같은 사건이 몰릴 때 문서를 새로 만들지 않고 기존 문서의 count를 올린다 → 폭주 시 비용·노이즈 방지.
//      "30초에 1건만 알림" 때문에 사고 규모가 안 보이던 문제를 count로 해결한다.
//   3) 도메인별 5분 실패 건수를 세어 임계 초과 시 급증(ops.rate_threshold_exceeded)을 만든다.
//   4) Firestore가 없거나 실패해도 메모리 링버퍼로 최근 사건은 계속 보여준다.
//
// 철칙:
//   · 요청 흐름을 절대 막지 않는다(모두 fire-and-forget).
//   · 이 파일 안에서는 logger를 호출하지 않는다 — logger가 이 파일을 부르므로 무한 루프가 된다.
//     자체 실패는 stats().writeErrors로만 노출한다.
//   · config는 지연 require한다(logger ↔ config 순환 방지).

const COLLECTION = 'opsLogs';
const RING_MAX = 300;                 // 메모리 보관 건수(Firestore 실패 시 백업 표시용)
const MERGE_WINDOW_MS = 60 * 1000;    // 같은 사건을 한 문서로 합치는 창
const RATE_WINDOW_MS = 5 * 60 * 1000; // 급증 판정 창
const RETENTION_DAYS = 30;

// 도메인별 5분 임계치. 초과하면 SEV1 급증 사건을 1회 만든다.
const RATE_THRESHOLDS = { payment: 5, refund: 3, subscription: 5, webhook: 5, billing: 3, auth: 10, engine: 20, infra: 10 };

let _cfg;
function getDb() {
  if (_cfg === undefined) { try { _cfg = require('../config'); } catch (_) { _cfg = null; } }
  return (_cfg && _cfg.db) || null;
}
function getAdmin() {
  if (_cfg === undefined) { try { _cfg = require('../config'); } catch (_) { _cfg = null; } }
  return (_cfg && _cfg.admin) || null;
}

const ring = [];
const stats = { written: 0, merged: 0, writeErrors: 0, lastWriteError: '', dropped: 0 };

// 같은 사건 병합용: groupKey -> { docId, firstMs, lastMs, count }
const openGroups = new Map();
// 급증 판정용: domain -> number[] (발생 시각)
const rateHits = new Map();
// 급증 알림 중복 방지: domain -> 마지막 발화 시각
const rateFired = new Map();

function cut(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function pickNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// 로그 레코드에서 "사람이 판단에 쓰는" 필드만 추린다. 원문·결과문은 애초에 로그에 없다.
function extract(record) {
  const err = record.err || {};
  return {
    event: cut(record.event || 'log', 160),
    level: cut(record.level || 'error', 10),
    message: cut(record.message || err.message || '', 600),
    errName: err.name ? cut(err.name, 80) : undefined,
    errCode: err.code ? cut(err.code, 80) : undefined,
    errStatus: pickNumber(err.status),
    stack: err.stack ? cut(err.stack, 1800) : undefined,
    requestId: record.requestId ? cut(record.requestId, 100) : undefined,
    uid: record.uid ? cut(record.uid, 128) : undefined,
    actorUid: record.actorUid ? cut(record.actorUid, 128) : undefined,
    orderId: record.orderId ? cut(record.orderId, 128) : undefined,
    jobId: record.jobId ? cut(record.jobId, 128) : undefined,
    amount: pickNumber(record.amount),
    credits: pickNumber(record.credits ?? record.needed ?? record.cost),
    mode: record.mode ? cut(record.mode, 40) : undefined,
    stage: record.stage ? cut(record.stage, 60) : undefined,
    code: record.code ? cut(record.code, 80) : undefined,
    tier: record.tier ? cut(record.tier, 60) : undefined,
    plan: record.plan ? cut(record.plan, 60) : undefined,
    path: record.path ? cut(record.path, 200) : undefined,
    method: record.method ? cut(record.method, 10) : undefined,
    statusCode: pickNumber(record.statusCode),
    reason: record.reason ? cut(record.reason, 300) : undefined,
    authSource: record.authSource ? cut(record.authSource, 80) : undefined,
    authReason: record.authReason ? cut(record.authReason, 80) : undefined,
    hasCredential: typeof record.hasCredential === 'boolean' ? record.hasCredential : undefined,
    suppliedLength: pickNumber(record.suppliedLength),
    sourceCount: pickNumber(record.sourceCount),
    credentialConflict: typeof record.credentialConflict === 'boolean' ? record.credentialConflict : undefined,
    userAgentFamily: record.userAgentFamily ? cut(record.userAgentFamily, 40) : undefined,
    env: cut(record.env || '', 40),
    service: cut(record.service || '', 60),
    commit: record.commit ? cut(record.commit, 40) : undefined
  };
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function pushRing(entry) {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

// 급증 감지: 창 안의 같은 도메인 건수가 임계를 넘으면 { domain, count, threshold } 반환.
function bumpRate(domain, nowMs) {
  const threshold = RATE_THRESHOLDS[domain];
  if (!threshold) return null;
  const arr = (rateHits.get(domain) || []).filter(t => nowMs - t < RATE_WINDOW_MS);
  arr.push(nowMs);
  rateHits.set(domain, arr);
  if (arr.length < threshold) return null;
  const firedAt = rateFired.get(domain) || 0;
  if (nowMs - firedAt < RATE_WINDOW_MS) return null;   // 창당 1회만
  rateFired.set(domain, nowMs);
  return { domain, count: arr.length, threshold, windowMinutes: Math.round(RATE_WINDOW_MS / 60000) };
}

function pruneGroups(nowMs) {
  if (openGroups.size < 200) return;
  for (const [k, g] of openGroups) if (nowMs - g.lastMs > MERGE_WINDOW_MS * 5) openGroups.delete(k);
}

async function persist(entry, groupKey, nowMs) {
  const db = getDb();
  if (!db) { stats.dropped++; return; }
  const adminSdk = getAdmin();
  const FieldValue = adminSdk && adminSdk.firestore && adminSdk.firestore.FieldValue;

  const open = openGroups.get(groupKey);
  // 같은 사건이 창 안에 또 오면 새 문서 대신 count만 올린다.
  if (open && open.docId && nowMs - open.firstMs < MERGE_WINDOW_MS) {
    open.lastMs = nowMs;
    open.count += 1;
    try {
      await db.collection(COLLECTION).doc(open.docId).update(stripUndefined({
        count: FieldValue ? FieldValue.increment(1) : open.count,
        lastSeenAt: new Date(nowMs).toISOString(),
        lastSeenMs: nowMs
      }));
      stats.merged++;
    } catch (e) {
      stats.writeErrors++;
      stats.lastWriteError = cut(e && e.message, 200);
    }
    return;
  }

  const doc = stripUndefined({
    ...entry,
    count: 1,
    firstSeenAt: new Date(nowMs).toISOString(),
    lastSeenAt: new Date(nowMs).toISOString(),
    createdMs: nowMs,
    lastSeenMs: nowMs,
    acked: false,
    expireAt: new Date(nowMs + RETENTION_DAYS * 86400000)
  });

  try {
    const ref = await db.collection(COLLECTION).add(doc);
    openGroups.set(groupKey, { docId: ref.id, firstMs: nowMs, lastMs: nowMs, count: 1 });
    stats.written++;
  } catch (e) {
    stats.writeErrors++;
    stats.lastWriteError = cut(e && e.message, 200);
  }
}

/**
 * 알림 대상 사건을 기록한다.
 * @returns {{ merged:boolean, surge:object|null }} merged=true면 창 안 중복(알림 억제 대상)
 */
function makeGroupKey(entry) {
  // Authentication probes for different routes/sources are distinct incidents.
  // This prevents /charge and /process-due failures from being merged together.
  const authSuffix = entry.authReason
    ? `|${entry.path || ''}|${entry.authSource || ''}|${entry.authReason}`
    : '';
  return `${entry.event}|${entry.severity}${authSuffix}`;
}

function record(record_, classification) {
  const nowMs = Date.now();
  const base = extract(record_);
  const severity = classification.sev;
  const domain = classification.domain;
  const entry = {
    ...base,
    severity,
    domain,
    action: cut(classification.action || '', 300),
    cataloged: !!classification.cataloged
  };

  pushRing({ ...entry, id: `mem-${nowMs}-${ring.length}`, count: 1, firstSeenAt: entry.firstSeenAt || new Date(nowMs).toISOString(), lastSeenAt: new Date(nowMs).toISOString(), createdMs: nowMs, acked: false, memoryOnly: true });

  const groupKey = makeGroupKey(entry);
  const open = openGroups.get(groupKey);
  const merged = !!(open && nowMs - open.firstMs < MERGE_WINDOW_MS);

  pruneGroups(nowMs);
  // 급증은 병합 여부와 무관하게 "발생 건수"로 센다.
  const surge = entry.event === 'ops.rate_threshold_exceeded' ? null : bumpRate(domain, nowMs);

  void persist(entry, groupKey, nowMs);

  return { merged, surge, entry };
}

// 창이 닫힌 뒤 몇 건이 쌓였는지(알림 요약용)
function groupCount(event, severity, details) {
  const g = openGroups.get(makeGroupKey({
    event,
    severity,
    path: details && details.path,
    authSource: details && details.authSource,
    authReason: details && details.authReason
  }));
  return g ? g.count : 1;
}

function recentFromMemory(limit = 100) {
  return ring.slice(-limit).reverse();
}

function statsSnapshot() {
  return { ...stats, ringSize: ring.length, openGroups: openGroups.size };
}

module.exports = {
  COLLECTION,
  RETENTION_DAYS,
  RATE_THRESHOLDS,
  record,
  groupCount,
  recentFromMemory,
  stats: statsSnapshot
};
