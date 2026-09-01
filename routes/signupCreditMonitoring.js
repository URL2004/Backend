'use strict';

const express = require('express');
const { db, verifyAdminToken } = require('../config');
const { logger } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');
const {
  DEFAULT_MAX_EVENTS,
  MAX_WINDOW_MS,
  aggregateSignupCreditEvents,
  scanSignupCreditEvents
} = require('../lib/signupCreditMonitoring');

function createSignupCreditMonitoringRouter({
  database = db,
  verifyAdmin = verifyAdminToken,
  routeLogger = logger,
  now = () => Date.now(),
  maxEvents = DEFAULT_MAX_EVENTS
} = {}) {
  const router = express.Router();

  router.post('/admin/signup-credit-summary', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const adminUid = await verifyAdmin(bearerToken(req));
    if (adminUid === false) {
      return res.status(403).json({ ok: false, status: 'error', error: 'ADMIN_REQUIRED' });
    }
    if (!adminUid) {
      return res.status(401).json({ ok: false, status: 'error', error: 'AUTH_REQUIRED' });
    }

    const nowMs = now();
    try {
      const scan = await scanSignupCreditEvents({
        db: database,
        sinceMs: nowMs - MAX_WINDOW_MS,
        limit: maxEvents
      });
      return res.json({
        ok: true,
        ...aggregateSignupCreditEvents(scan.events, {
          nowMs,
          source: scan.source,
          truncated: scan.truncated,
          scanned: scan.scanned
        })
      });
    } catch (error) {
      routeLogger.warn('signup_credit.summary_failed', { err: error, noAlert: true });
      return res.status(503).json({
        ok: false,
        ...aggregateSignupCreditEvents([], {
          nowMs,
          source: 'unavailable',
          scanStatus: 'error',
          scanned: 0
        }),
        error: 'SIGNUP_CREDIT_SUMMARY_UNAVAILABLE'
      });
    }
  });

  return router;
}

const router = createSignupCreditMonitoringRouter();
router.createSignupCreditMonitoringRouter = createSignupCreditMonitoringRouter;

module.exports = router;
