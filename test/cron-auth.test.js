const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authLogFields,
  timingSafeEqualText,
  verifyCronRequest
} = require('../lib/cronAuth');

function request({ headers = {}, body = {}, query = {} } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    body,
    query,
    get(name) { return normalized[String(name).toLowerCase()] || ''; }
  };
}

test('cron auth accepts a trimmed x-cron-secret with constant-time comparison', () => {
  const result = verifyCronRequest(request({
    headers: { 'x-cron-secret': '  shared-secret  ', 'user-agent': 'curl/8.21.0' }
  }), { secret: 'shared-secret' });

  assert.equal(result.ok, true);
  assert.equal(result.authSource, 'header');
  assert.equal(result.userAgentFamily, 'curl');
  assert.equal(result.secret, 'shared-secret');
  assert.equal(timingSafeEqualText('same', 'same'), true);
  assert.equal(timingSafeEqualText('same', 'different'), false);
});

test('cron auth accepts bearer and body compatibility sources', () => {
  const bearer = verifyCronRequest(request({ headers: { authorization: 'Bearer shared-secret' } }), { secret: 'shared-secret' });
  const body = verifyCronRequest(request({ body: { internalKey: ' shared-secret ' } }), { secret: 'shared-secret' });
  assert.equal(bearer.ok, true);
  assert.equal(bearer.authSource, 'bearer');
  assert.equal(body.ok, true);
  assert.equal(body.authSource, 'body');
});

test('cron auth rejects conflicting credentials even when one is valid', () => {
  const result = verifyCronRequest(request({
    headers: {
      'x-cron-secret': 'shared-secret',
      authorization: 'Bearer attacker-value'
    }
  }), { secret: 'shared-secret' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'credential_conflict');
  assert.equal(result.credentialConflict, true);
  assert.equal(result.authSource, 'header+bearer');
});

test('cron auth query compatibility must be explicitly enabled', () => {
  const req = request({ query: { key: 'shared-secret' } });
  assert.equal(verifyCronRequest(req, { secret: 'shared-secret' }).reason, 'credential_absent');
  const enabled = verifyCronRequest(req, { secret: 'shared-secret', allowQuery: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.authSource, 'query');
});

test('legacy body and query credentials can move from shadow observation to blocking', () => {
  const bodyReq = request({ body: { internalKey: 'shared-secret' } });
  const shadow = verifyCronRequest(bodyReq, { secret: 'shared-secret', legacyMode: 'shadow' });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.legacyCredentialUsed, true);
  assert.equal(shadow.legacyMode, 'shadow');

  const blocked = verifyCronRequest(bodyReq, { secret: 'shared-secret', legacyMode: 'block' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'legacy_credential_blocked');
  assert.equal(blocked.secret, undefined);

  const primary = verifyCronRequest(request({
    headers: { 'x-cron-secret': 'shared-secret' },
    body: { internalKey: 'stale-legacy-value' }
  }), { secret: 'shared-secret', legacyMode: 'block' });
  assert.equal(primary.ok, true);
  assert.equal(primary.authSource, 'header');
  assert.equal(primary.legacyCredentialPresent, true);
});

test('cron auth diagnostics never expose accepted or rejected secret values', () => {
  const rejected = verifyCronRequest(request({ headers: { 'x-cron-secret': 'do-not-log-me' } }), { secret: 'shared-secret' });
  const fields = authLogFields(rejected);
  const serialized = JSON.stringify(fields);
  assert.equal(rejected.ok, false);
  assert.equal(serialized.includes('do-not-log-me'), false);
  assert.equal(serialized.includes('shared-secret'), false);
  assert.equal(fields.authReason, 'credential_mismatch');
  assert.equal(fields.suppliedLength, 'do-not-log-me'.length);
});

test('cron auth distinguishes server configuration loss from absent caller credential', () => {
  const missingSecret = verifyCronRequest(request(), { secret: '   ' });
  const absentCredential = verifyCronRequest(request(), { secret: 'shared-secret' });
  assert.equal(missingSecret.reason, 'secret_missing');
  assert.equal(absentCredential.reason, 'credential_absent');
});
