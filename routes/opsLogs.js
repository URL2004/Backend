// routes/opsLogs.js — 관리자 장애 로그 조회/확인 + 부재 감지 워치독 + 일일 운영 다이제스트.
//
//  · POST /admin/ops-logs        : 장애 로그 목록(필터: 등급·도메인·확인여부·검색어·기간)
//  · POST /admin/ops-summary     : 24시간 요약 + 하트비트 상태 + 알림 전송 상태
//  · POST /admin/ops-ack         : 사건 확인 처리(누가 언제 봤는지 남긴다)
//  · POST /cron/ops-watchdog     : 주기 작업이 멈췄는지 검사 → 멈췄으면 SEV1 (앱 밖 스케줄러가 호출)
//  · POST /cron/ops-digest       : 하루치 요약을 Discord로 (매출 리포트와 같은 패턴)
//
// 조회는 Firestore 복합 인덱스를 요구하지 않도록 createdMs 정렬로만 가져와 메모리에서 거른다
// (opsLogs는 소량 컬렉션이라 이 편이 운영이 단순하다).

const express = require('express');
const router = express.Router();
const { db, ADMIN_UIDS, verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const opsLog = require('../lib/opsLog');
const opsEvents = require('../lib/opsEvents');
const opsHeartbeat = require('../lib/opsHeartbeat');
const discord = require('../lib/discord');
const { authLogFields, legacyQueryCredentialEnabled, verifyCronRequest } = require('../lib/cronAuth');

const MAX_SCAN = 600;

function bearer(req) {
  const raw = req.get('authorization') || '';
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}

// 관리자 페이지는 Authorization 헤더, 일부 기존 화면은 body.idToken을 쓴다 — 둘 다 받는다.
async function requireAdmin(req, res) {
  const idToken = bearer(req) || (req.body && req.body.idToken) || '';
  const uid = await verifyToken(idToken);
  if (!uid) { res.status(401).json({ ok: false, error: '로그인이 필요합니다.' }); return null; }
  setLogContext({ uid, actorUid: uid });
  if (!ADMIN_UIDS.includes(uid)) { res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' }); return null; }
  return uid;
}

function requireCron(req, res) {
  const auth = verifyCronRequest(req, { allowBearer: true, allowBody: true, allowQuery: legacyQueryCredentialEnabled() });
  if (auth.reason === 'secret_missing') {
    logger.error('ops.cron_secret_missing', { message: 'CRON_SECRET 미설정 — 운영 워치독/다이제스트 중단' });
    res.status(503).json({ ok: false, error: 'CRON_SECRET이 설정되지 않았습니다.' });
    return false;
  }
  if (!auth.ok) {
    logger.warn('ops.cron_auth_rejected', {
      ...authLogFields(auth),
      message: '운영 cron 인증 거부 — 실제 중단 여부는 heartbeat로 판정'
    });
    res.status(401).json({ ok: false, error: '권한이 없습니다.' });
    return false;
  }
  if (auth.authSource.includes('query')) {
    logger.warn('ops.cron_query_secret_deprecated', {
      message: 'query cron secret은 폐기 예정입니다. x-cron-secret 헤더로 전환하세요.'
    });
  }
  return true;
}

async function scanLogs({ sinceMs, limit }) {
  if (!db) return { rows: opsLog.recentFromMemory(limit || 100), source: 'memory' };
  try {
    let query = db.collection(opsLog.COLLECTION).orderBy('createdMs', 'desc').limit(Math.min(MAX_SCAN, (limit || 100) * 3));
    const snap = await query.get();
    const rows = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (sinceMs && Number(d.createdMs || 0) < sinceMs) return;
      rows.push({ id: doc.id, ...d });
    });
    return { rows, source: 'firestore' };
  } catch (e) {
    // 조회 실패해도 화면이 비지 않도록 메모리 링버퍼로 폴백한다.
    return { rows: opsLog.recentFromMemory(limit || 100), source: 'memory_fallback', error: e && e.message };
  }
}

function applyFilters(rows, f) {
  const q = String(f.q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (f.severity && r.severity !== f.severity) return false;
    if (f.minSeverity && !opsEvents.isAtLeast(r.severity, f.minSeverity)) return false;
    if (f.domain && r.domain !== f.domain) return false;
    if (f.event && r.event !== f.event) return false;
    if (f.onlyOpen && r.acked) return false;
    if (q) {
      const hay = [r.event, r.message, r.uid, r.orderId, r.jobId, r.requestId, r.code, r.stage, r.path, r.errCode]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ── 목록 ────────────────────────────────────────────────────────────────
router.post('/admin/ops-logs', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const b = req.body || {};
  const limit = Math.max(1, Math.min(200, Number(b.limit) || 60));
  const hours = Math.max(1, Math.min(24 * 30, Number(b.hours) || 24 * 7));
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const { rows, source, error } = await scanLogs({ sinceMs, limit });
  const filtered = applyFilters(rows, {
    severity: b.severity || '',
    minSeverity: b.minSeverity || '',
    domain: b.domain || '',
    event: b.event || '',
    onlyOpen: !!b.onlyOpen,
    q: b.q || ''
  });
  res.json({
    ok: true,
    source,
    scanned: rows.length,
    total: filtered.length,
    items: filtered.slice(0, limit),
    domains: [...new Set(rows.map(r => r.domain).filter(Boolean))].sort(),
    ...(error ? { warning: error } : {})
  });
});

// ── 요약(대시보드 상단) ──────────────────────────────────────────────────
router.post('/admin/ops-summary', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const hours = Math.max(1, Math.min(168, Number(req.body && req.body.hours) || 24));
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const { rows, source } = await scanLogs({ sinceMs, limit: MAX_SCAN });

  const bySeverity = { SEV1: 0, SEV2: 0, SEV3: 0 };
  const byDomain = {};
  const byEvent = {};
  let openSev1 = 0;
  let occurrences = 0;
  for (const r of rows) {
    const c = Number(r.count) || 1;
    occurrences += c;
    if (bySeverity[r.severity] !== undefined) bySeverity[r.severity] += c;
    byDomain[r.domain || 'ops'] = (byDomain[r.domain || 'ops'] || 0) + c;
    byEvent[r.event] = (byEvent[r.event] || 0) + c;
    if (r.severity === 'SEV1' && !r.acked) openSev1++;
  }
  const topEvents = Object.entries(byEvent).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([event, count]) => ({ event, count, ...opsEvents.classify(event, 'error') }));

  const heartbeats = await opsHeartbeat.readAll();
  res.json({
    ok: true,
    source,
    hours,
    incidents: rows.length,
    occurrences,
    bySeverity,
    byDomain,
    topEvents,
    openSev1,
    heartbeats,
    alerting: {
      discord: discord.enabled(),
      webhook: discord.webhookStats ? discord.webhookStats() : null,
      store: opsLog.stats()
    }
  });
});

// ── 확인 처리 ────────────────────────────────────────────────────────────
router.post('/admin/ops-ack', async (req, res) => {
  const adminUid = await requireAdmin(req, res);
  if (!adminUid) return;
  const id = String((req.body && req.body.id) || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });
  if (!db) return res.status(503).json({ ok: false, error: '저장소를 사용할 수 없습니다.' });
  const acked = (req.body && req.body.acked) !== false;
  const note = String((req.body && req.body.note) || '').slice(0, 500);
  try {
    await db.collection(opsLog.COLLECTION).doc(id).update({
      acked,
      ackedBy: acked ? adminUid : null,
      ackedAt: acked ? new Date().toISOString() : null,
      ackNote: note || null
    });
    logger.info('ops.incident_acked', { incidentId: id, acked, actorUid: adminUid });
    res.json({ ok: true });
  } catch (e) {
    logger.warn('ops.incident_ack_failed', { incidentId: id, err: e });
    res.status(500).json({ ok: false, error: '확인 처리에 실패했습니다.' });
  }
});

// ── 워치독: 주기 작업이 멈췄는지 검사 ────────────────────────────────────
// 이 엔드포인트 자체는 외부 스케줄러가 부른다. 앱이 죽으면 이것도 안 도는데,
// 그 경우는 외부 업타임 모니터(/healthz 폴링)가 잡는 역할 분담이다.
router.post('/cron/ops-watchdog', async (req, res) => {
  if (!requireCron(req, res)) return;
  try {
    const beats = await opsHeartbeat.readAll();
    const stale = beats.filter(b => b.state === 'stale');
    for (const b of stale) {
      logger.error('ops.watchdog_stale_heartbeat', {
        heartbeat: b.name,
        label: b.label,
        ageMinutes: b.ageMinutes,
        expectedEveryMinutes: b.everyMinutes,
        graceMinutes: b.graceMinutes,
        message: `${b.label}가 ${b.ageMinutes}분째 실행되지 않았어요(기대 주기 ${b.everyMinutes}분).`
      });
    }
    logger.info('ops.watchdog_completed', { checked: beats.length, stale: stale.length });
    res.json({ ok: true, checked: beats.length, stale: stale.map(s => s.name), beats });
  } catch (e) {
    logger.error('ops.watchdog_failed', { err: e });
    res.status(500).json({ ok: false, error: e && e.message });
  }
});

// ── 일일 운영 다이제스트 ─────────────────────────────────────────────────
router.post('/cron/ops-digest', async (req, res) => {
  if (!requireCron(req, res)) return;
  try {
    const hours = Math.max(1, Math.min(168, Number(req.body && req.body.hours) || 24));
    const sinceMs = Date.now() - hours * 3600 * 1000;
    const { rows } = await scanLogs({ sinceMs, limit: MAX_SCAN });

    const bySeverity = { SEV1: 0, SEV2: 0, SEV3: 0 };
    const byEvent = {};
    let openSev1 = [];
    for (const r of rows) {
      const c = Number(r.count) || 1;
      if (bySeverity[r.severity] !== undefined) bySeverity[r.severity] += c;
      byEvent[r.event] = (byEvent[r.event] || 0) + c;
      if (r.severity === 'SEV1' && !r.acked) openSev1.push(r);
    }
    const top = Object.entries(byEvent).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const beats = await opsHeartbeat.readAll();
    const stale = beats.filter(b => b.state === 'stale');

    const fields = [
      { name: '등급별', value: `SEV1 ${bySeverity.SEV1} · SEV2 ${bySeverity.SEV2} · SEV3 ${bySeverity.SEV3}`, inline: false },
      { name: '미확인 SEV1', value: openSev1.length ? `${openSev1.length}건 — 관리자 로그에서 확인 필요` : '없음', inline: false },
      { name: '주기 작업', value: stale.length ? stale.map(s => `⛔ ${s.label} ${s.ageMinutes}분 지연`).join('\n') : '전부 정상', inline: false },
      { name: '많이 난 사건', value: top.length ? top.map(([e, c]) => `${e} — ${c}건`).join('\n') : '없음', inline: false }
    ];
    discord.opsDigest({
      title: `🩺 운영 다이제스트 · 최근 ${hours}시간`,
      description: bySeverity.SEV1 || stale.length ? '확인이 필요한 항목이 있어요.' : '큰 이상은 없었어요.',
      fields,
      severe: !!(openSev1.length || stale.length)
    });
    require('../lib/opsHeartbeat').beat('ops.digest', { incidents: rows.length });
    logger.info('ops.digest_sent', { hours, incidents: rows.length, sev1: bySeverity.SEV1, stale: stale.length });
    res.json({ ok: true, hours, incidents: rows.length, bySeverity, stale: stale.map(s => s.name) });
  } catch (e) {
    logger.error('ops.digest_failed', { err: e });
    res.status(500).json({ ok: false, error: e && e.message });
  }
});

module.exports = router;
