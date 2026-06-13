const crypto = require('crypto');
const { logger, runWithLogContext } = require('../lib/logger');

function sanitizeRequestId(value) {
  const id = String(value || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100);
  return id || crypto.randomUUID();
}

function requestContext(req, res, next) {
  const requestId = sanitizeRequestId(req.get('x-request-id') || req.get('x-correlation-id'));
  const start = process.hrtime.bigint();
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const context = {
    requestId,
    method: req.method,
    path: req.path,
    ip,
    origin: req.get('origin') || undefined,
    userAgent: req.get('user-agent') || undefined
  };

  res.setHeader('x-request-id', requestId);

  runWithLogContext(context, () => {
    let loggedClose = false;
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      if ((req.path === '/healthz' || req.path === '/api/health') && process.env.LOG_HTTP_HEALTH !== '1') return;
      const fields = {
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
        responseBytes: Number(res.getHeader('content-length')) || undefined
      };
      const event = 'http.request';
      if (res.statusCode >= 500) logger.error(event, fields);
      else if (res.statusCode >= 400) logger.warn(event, fields);
      else logger.info(event, fields);
    });

    res.on('close', () => {
      if (res.writableEnded || loggedClose) return;
      loggedClose = true;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.warn('http.request_aborted', {
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs)
      });
    });

    next();
  });
}

module.exports = requestContext;
