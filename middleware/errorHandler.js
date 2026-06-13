const { logger } = require('../lib/logger');

function statusForError(err) {
  if (err && (err.status || err.statusCode)) return err.status || err.statusCode;
  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') return 400;
  if (err && err.message === '허용되지 않은 접근입니다.') return 403;
  return 500;
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = statusForError(err);
  const event = status >= 500 ? 'http.unhandled_error' : 'http.request_error';
  const fields = {
    statusCode: status,
    err,
    bodyBytes: req.get('content-length') ? Number(req.get('content-length')) : undefined
  };
  if (status >= 500) logger.error(event, fields);
  else logger.warn(event, fields);

  const message = status >= 500
    ? '서버 에러 발생'
    : (err && err.message) || '요청을 처리할 수 없습니다.';
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
