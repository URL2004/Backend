const crypto = require('crypto');
const { logger, runWithLogContext } = require('../lib/logger');
const { realClientIp } = require('../lib/clientip');

function sanitizeRequestId(value) {
  const id = String(value || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100);
  return id || crypto.randomUUID();
}

function requestContext(req, res, next) {
  const requestId = sanitizeRequestId(req.get('x-request-id') || req.get('x-correlation-id'));
  const start = process.hrtime.bigint();
  const ip = realClientIp(req);
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
        responseBytes: Number(res.getHeader('content-length')) || undefined,
        // 접근 로그는 Discord 중복/무내용 알림을 안 보냄 — 실제 에러는 errorHandler(http.unhandled_error)나
        // 라우트의 logger.error가 메시지·스택과 함께 보낸다.
        noAlert: true
      };
      const event = 'http.request';
      // 503은 기대된 백프레셔(드레이닝·동시한도)라 서버 에러가 아님 → warn으로(알림도 안 감).
      if (res.statusCode >= 500 && res.statusCode !== 503) logger.error(event, fields);
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
