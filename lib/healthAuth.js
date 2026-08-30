'use strict';

const { timingSafeEqualText } = require('./cronAuth');

function verifyDetailedHealthRequest(req, secret = process.env.HEALTH_CHECK_SECRET) {
  const expected = String(secret || '').trim();
  if (!expected) return { ok: false, reason: 'secret_missing' };
  const direct = String(req?.get?.('x-health-secret') || '').trim();
  const authorization = String(req?.get?.('authorization') || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || '';
  const supplied = direct || bearer;
  return {
    ok: timingSafeEqualText(supplied, expected),
    reason: supplied ? 'mismatch' : 'absent'
  };
}

module.exports = { verifyDetailedHealthRequest };
