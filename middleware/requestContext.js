const crypto = require('crypto');
const { logger, runWithLogContext } = require('../lib/logger');
const { realClientIp } = require('../lib/clientip');
const { userAgentFamily } = require('../lib/cronAuth');
const { clientHashForLog, originHostnameForLog } = require('../lib/requestLogPrivacy');

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
    clientHash: clientHashForLog(ip),
    originHost: originHostnameForLog(req.get('origin')),
    userAgentFamily: userAgentFamily(req)
  };

  res.setHeader('x-request-id', requestId);

  runWithLogContext(context, () => {
    let loggedClose = false;
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      if ((req.path === '/healthz' || req.path === '/api/health' || req.path === '/internal/health') && process.env.LOG_HTTP_HEALTH !== '1') return;
      const fields = {
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
        responseBytes: Number(res.getHeader('content-length')) || undefined,
        // 접근 로그는 Discord 중복/무내용 알림을 안 보냄 — 실제 에러는 errorHandler(http.unhandled_error)나
        // 라우트의 logger.error가 메시지·스택과 함께 보낸다.
        noAlert: true
      };
      const event = 'http.request';
      // 라우트가 "이 4xx/503은 설계된 응답"이라고 표시하면(res.locals.logExpectedStatus) warn이 아니라 info로 남긴다.
      // 예: 검증 전 /public/metrics 503 — 9/29 실측 하루 779줄이 warn으로 쌓여 진짜 경고를 가렸다.
      const expected = !!(res.locals && res.locals.logExpectedStatus === true);
      if (expected) fields.expectedStatus = true;
      // 503은 기대된 백프레셔(드레이닝·동시한도)라 서버 에러가 아님 → warn으로(알림도 안 감).
      if (res.statusCode >= 500 && res.statusCode !== 503) logger.error(event, fields);
      else if (res.statusCode >= 400 && !expected) logger.warn(event, fields);
      else logger.info(event, fields);
    });

    res.on('close', () => {
      if (res.writableEnded || loggedClose) return;
      loggedClose = true;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      // 'close'는 소켓 쪽에서 발화해 AsyncLocalStorage 밖에서 실행된다 → requestId·경로가 자동으로 붙지 않는다.
      // 9/29 쿠폰 사고 때 "무응답으로 끊긴 요청"이 어느 경로였는지 로그만으로 알 수 없었다. 명시적으로 싣는다.
      logger.warn('http.request_aborted', {
        ...context,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
        // headersSent=false: 서버가 아무 응답도 못 만든 채 클라이언트가 포기함(핸들러가 멈춘 요청).
        // headersSent=true : 응답 도중 클라이언트가 떠남(탭 닫기 등) — 대개 조치 불필요.
        headersSent: res.headersSent === true
      });
    });

    next();
  });
}

module.exports = requestContext;
