'use strict';

const crypto = require('crypto');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canReadDetailedHealth(req, secret = process.env.HEALTH_DETAIL_SECRET) {
  const expected = clean(secret);
  const supplied = clean(req && req.get && req.get('x-health-secret'));
  return timingSafeEqualText(supplied, expected);
}

module.exports = { canReadDetailedHealth, timingSafeEqualText };
