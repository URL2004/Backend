// Shared authentication for scheduled jobs.
//
// Keep credential parsing and comparison identical across subscription,
// revenue, watchdog, and digest routes.  Never return or log a rejected
// credential; callers only receive safe diagnostic metadata.

const crypto = require('crypto');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function bearer(req) {
  const raw = clean(req && req.get && req.get('authorization'));
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? clean(match[1]) : '';
}

function userAgentFamily(req) {
  const raw = clean(req && req.get && req.get('user-agent')).toLowerCase();
  if (!raw) return 'unknown';
  if (raw.includes('curl/')) return 'curl';
  if (raw.includes('undici') || raw.includes('node-fetch') || raw.includes('node/')) return 'node';
  if (raw.includes('cron') || raw.includes('scheduler')) return 'scheduler';
  if (raw.includes('mozilla/')) return 'browser';
  return 'other';
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(clean(left), 'utf8');
  const b = Buffer.from(clean(right), 'utf8');
  if (a.length !== b.length) return false;
  return a.length > 0 && crypto.timingSafeEqual(a, b);
}

function credentialEntries(req, options) {
  const opts = options || {};
  const entries = [
    { source: 'header', value: clean(req && req.get && req.get('x-cron-secret')) }
  ];
  if (opts.allowBearer !== false) entries.push({ source: 'bearer', value: bearer(req) });
  if (opts.allowBody !== false) entries.push({ source: 'body', value: clean(req && req.body && req.body.internalKey) });
  if (opts.allowQuery) entries.push({ source: 'query', value: clean(req && req.query && req.query.key) });
  return entries.filter((entry) => entry.value);
}

// 무파손 전환: 배포 직후에는 과거 query credential을 받되 경고한다. 모든 스케줄러를
// x-cron-secret으로 옮긴 뒤 CRON_ALLOW_QUERY_SECRET=0으로 닫는다.
function legacyQueryCredentialEnabled(env = process.env) {
  return String(env.CRON_ALLOW_QUERY_SECRET ?? '1').trim() !== '0';
}

function verifyCronRequest(req, options = {}) {
  const expected = clean(options.secret === undefined ? process.env.CRON_SECRET : options.secret);
  const uaFamily = userAgentFamily(req);
  if (!expected) {
    return {
      ok: false,
      reason: 'secret_missing',
      authSource: 'none',
      hasCredential: false,
      sourceCount: 0,
      credentialConflict: false,
      userAgentFamily: uaFamily
    };
  }

  const entries = credentialEntries(req, options);
  if (!entries.length) {
    return {
      ok: false,
      reason: 'credential_absent',
      authSource: 'none',
      hasCredential: false,
      suppliedLength: 0,
      sourceCount: 0,
      credentialConflict: false,
      userAgentFamily: uaFamily
    };
  }

  const distinct = new Set(entries.map((entry) => entry.value));
  const authSource = entries.map((entry) => entry.source).join('+');
  if (distinct.size > 1) {
    return {
      ok: false,
      reason: 'credential_conflict',
      authSource,
      hasCredential: true,
      suppliedLength: undefined,
      sourceCount: entries.length,
      credentialConflict: true,
      userAgentFamily: uaFamily
    };
  }

  const supplied = entries[0].value;
  const ok = timingSafeEqualText(supplied, expected);
  return {
    ok,
    reason: ok ? 'accepted' : 'credential_mismatch',
    authSource,
    hasCredential: true,
    suppliedLength: supplied.length,
    sourceCount: entries.length,
    credentialConflict: false,
    userAgentFamily: uaFamily,
    // Only an accepted request may receive the canonical secret.  This keeps
    // the existing internal subscription call compatible without exposing a
    // rejected value to logs or responses.
    secret: ok ? expected : undefined
  };
}

function authLogFields(result) {
  return {
    authSource: result.authSource,
    authReason: result.reason,
    hasCredential: !!result.hasCredential,
    suppliedLength: result.suppliedLength,
    sourceCount: result.sourceCount,
    credentialConflict: !!result.credentialConflict,
    userAgentFamily: result.userAgentFamily
  };
}

module.exports = {
  authLogFields,
  legacyQueryCredentialEnabled,
  timingSafeEqualText,
  userAgentFamily,
  verifyCronRequest
};
