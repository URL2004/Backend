'use strict';

const express = require('express');
const { db } = require('../config');
const { logger } = require('../lib/logger');
const publicMetrics = require('../lib/publicMetrics');

function createPublicMetricsRouter({ database = db, routeLogger = logger } = {}) {
  const router = express.Router();

  router.get('/public/metrics', async (_req, res) => {
    try {
      const result = await publicMetrics.readPublicMetrics({ db: database });
      res.set('Cache-Control', result.status === 200
        ? 'public, max-age=60, stale-while-revalidate=300'
        : 'no-store');
      return res.status(result.status).json(result.body);
    } catch (error) {
      routeLogger.warn('public_metrics.read_failed', { err: error });
      res.set('Cache-Control', 'no-store');
      return res.status(503).json(publicMetrics.emptyPayload());
    }
  });

  return router;
}

const router = createPublicMetricsRouter();
router.createPublicMetricsRouter = createPublicMetricsRouter;

module.exports = router;
