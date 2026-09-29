'use strict';

const express = require('express');
const { db, verifyAdminToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');
const publicMetrics = require('../lib/publicMetrics');

// 검증 전 503은 설계된 응답이다. 요청마다 warn을 남기면(9/29 실측 하루 779줄) 진짜 경고가 묻히므로
// 사유별로 1시간에 한 번만 public_metrics.unavailable을 남기고, 접근 로그는 info로 내린다.
const UNAVAILABLE_LOG_INTERVAL_MS = 60 * 60 * 1000;
const ADMIN_ACTIONS = new Set(['inspect', 'verify', 'unverify']);

function createPublicMetricsRouter({
  database = db,
  routeLogger = logger,
  verifyAdmin = verifyAdminToken,
  tokenFromRequest = bearerToken,
  now = () => Date.now()
} = {}) {
  const router = express.Router();
  const lastUnavailableLogAt = new Map();   // reason -> ms

  function noteUnavailable(reason, body) {
    const at = now();
    const last = lastUnavailableLogAt.get(reason) || 0;
    if (at - last < UNAVAILABLE_LOG_INTERVAL_MS) return false;
    lastUnavailableLogAt.set(reason, at);
    routeLogger.warn('public_metrics.unavailable', {
      reason,
      verified: body?.verified === true,
      asOf: body?.asOf || null,
      totals: body?.totals,
      message: reason === 'not_initialized'
        ? '공개 지표 집계 문서가 아직 없다(완료 작업이 한 건도 집계되지 않음).'
        : '공개 지표 집계는 쌓이고 있으나 verified 플래그가 없어 503으로 응답 중(랜딩은 정책 문구로 폴백).'
    });
    return true;
  }

  router.get('/public/metrics', async (_req, res) => {
    try {
      const result = await publicMetrics.readPublicMetrics({ db: database });
      res.set('Cache-Control', result.status === 200
        ? 'public, max-age=60, stale-while-revalidate=300'
        : 'no-store');
      if (result.status !== 200) {
        res.locals.logExpectedStatus = true;
        noteUnavailable(result.reason || 'unavailable', result.body);
      }
      return res.status(result.status).json(result.body);
    } catch (error) {
      routeLogger.warn('public_metrics.read_failed', { err: error });
      res.set('Cache-Control', 'no-store');
      return res.status(503).json(publicMetrics.emptyPayload());
    }
  });

  // 관리자: 집계 문서를 들여다보고(inspect) 검증 플래그를 켜거나(verify) 끈다(unverify).
  // verified는 "숫자를 사람이 확인했다"는 운영 결정이라 코드가 자동으로 켜지 않는다 — 이 엔드포인트가 유일한 경로.
  router.post('/admin/public-metrics', express.json({ limit: '4kb' }), async (req, res) => {
    const adminUid = await verifyAdmin(tokenFromRequest(req));
    if (adminUid === false) return res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' });
    if (!adminUid) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
    setLogContext({ uid: adminUid, actorUid: adminUid });
    if (!database) return res.status(503).json({ ok: false, error: 'Firestore가 비활성 상태입니다.' });

    const action = String(req.body?.action || 'inspect').trim();
    if (!ADMIN_ACTIONS.has(action)) return res.status(400).json({ ok: false, error: 'action은 inspect|verify|unverify 중 하나여야 합니다.' });

    const ref = database.collection(publicMetrics.METRICS_COLLECTION).doc(publicMetrics.METRICS_DOCUMENT);
    try {
      const before = await publicMetrics.readPublicMetrics({ db: database });
      if (action === 'inspect') {
        return res.json({ ok: true, action, status: before.status, reason: before.reason, metrics: before.body });
      }
      if (action === 'verify' && before.reason === 'not_initialized') {
        return res.status(409).json({ ok: false, error: '집계 문서가 아직 없어 검증할 수 없습니다(완료 작업이 집계된 뒤 다시 시도).', reason: before.reason });
      }
      const verifiedAt = new Date(now()).toISOString();
      const requestedSince = req.body?.since ? new Date(req.body.since) : null;
      const since = before.body.since
        || (requestedSince && Number.isFinite(requestedSince.getTime()) ? requestedSince.toISOString() : null)
        || before.body.asOf
        || verifiedAt;
      await ref.set({
        schemaVersion: publicMetrics.SCHEMA_VERSION,
        verified: action === 'verify',
        since,
        verifiedAt,
        verifiedBy: adminUid
      }, { merge: true });
      routeLogger.warn('public_metrics.verification_changed', {
        action, verified: action === 'verify', since, totals: before.body.totals, noAlert: true
      });
      const after = await publicMetrics.readPublicMetrics({ db: database });
      return res.json({ ok: true, action, status: after.status, reason: after.reason, metrics: after.body });
    } catch (error) {
      routeLogger.error('public_metrics.admin_failed', { action, err: error });
      return res.status(500).json({ ok: false, error: '공개 지표 처리에 실패했습니다.' });
    }
  });

  return router;
}

const router = createPublicMetricsRouter();
router.createPublicMetricsRouter = createPublicMetricsRouter;
router.UNAVAILABLE_LOG_INTERVAL_MS = UNAVAILABLE_LOG_INTERVAL_MS;

module.exports = router;
