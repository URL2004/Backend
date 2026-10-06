'use strict';

const express = require('express');
const { db, verifyAdminToken, ADMIN_UIDS } = require('../config');
const { logger } = require('../lib/logger');
const { summaryOptions, aggregateSignupAttribution, scanSignupAccounts } = require('../lib/signupAttributionSummary');

function createSignupAttributionRouter({ database = db, verifyAdmin = verifyAdminToken, excludedUids = ADMIN_UIDS || [], now = () => Date.now(), limit } = {}) {
  const router = express.Router();
  router.post('/admin/signup-attribution-summary', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || '';
    try {
      const uid = token ? await verifyAdmin(token) : null;
      if (uid === false) return res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' });
      if (!uid) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
      const options = summaryOptions(req.body, now());
      const scan = await scanSignupAccounts({ database, ...options, limit });
      return res.json({ ok: true, ...aggregateSignupAttribution(scan.accounts, { ...options, excludedUids, truncated: scan.truncated }) });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ ok: false, error: error.message });
      logger.warn('signup_attribution.summary_failed', { err: error, noAlert: true });
      return res.status(503).json({ ok: false, error: '가입 유입 통계를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });
  return router;
}

const router = createSignupAttributionRouter();
router.createSignupAttributionRouter = createSignupAttributionRouter;
module.exports = router;
