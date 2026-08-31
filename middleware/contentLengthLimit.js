'use strict';

function contentLengthLimit(maxBytes) {
  const limit = Math.max(1, Number(maxBytes) || 1);
  return function guardContentLength(req, res, next) {
    const raw = req && req.get ? req.get('content-length') : undefined;
    if (raw != null && raw !== '') {
      const length = Number(raw);
      if (Number.isFinite(length) && length > limit) {
        return res.status(413).json({ ok: false, error: 'payload_too_large' });
      }
    }
    return next();
  };
}

module.exports = contentLengthLimit;
