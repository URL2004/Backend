'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const reqtoken = require('../lib/reqtoken');

function request({ authorization = '', bodyToken = '' } = {}) {
  return {
    path: '/transform',
    headers: authorization ? { authorization } : {},
    body: bodyToken ? { idToken: bodyToken } : {},
    get(name) { return this.headers[String(name).toLowerCase()] || ''; }
  };
}

test('Authorization bearer remains canonical and is not counted as deprecated', () => {
  reqtoken.resetDeprecationStatsForTests();
  const req = request({ authorization: 'Bearer header-token', bodyToken: 'body-token' });
  assert.equal(reqtoken.bearerToken(req), 'header-token');
  assert.equal(req.authTokenSource, 'authorization_header');
  assert.equal(reqtoken.deprecationSnapshot().bodyFallbackCount, 0);
});

test('body token compatibility defaults to warn and exposes only aggregate migration telemetry', () => {
  reqtoken.resetDeprecationStatsForTests();
  const before = process.env.ID_TOKEN_BODY_COMPAT_MODE;
  delete process.env.ID_TOKEN_BODY_COMPAT_MODE;
  try {
    const req = request({ bodyToken: 'legacy-token' });
    assert.equal(reqtoken.bearerToken(req), 'legacy-token');
    assert.equal(req.authTokenSource, 'body_deprecated');
    const snapshot = reqtoken.deprecationSnapshot();
    assert.equal(snapshot.mode, 'warn');
    assert.equal(snapshot.bodyFallbackCount, 1);
    assert.equal(snapshot.bodyRejectedCount, 0);
    assert.match(snapshot.lastBodyFallbackAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(JSON.stringify(snapshot).includes('legacy-token'), false);
  } finally {
    if (before == null) delete process.env.ID_TOKEN_BODY_COMPAT_MODE;
    else process.env.ID_TOKEN_BODY_COMPAT_MODE = before;
  }
});

test('body token removal can be enabled explicitly after telemetry reaches zero', () => {
  reqtoken.resetDeprecationStatsForTests();
  const before = process.env.ID_TOKEN_BODY_COMPAT_MODE;
  process.env.ID_TOKEN_BODY_COMPAT_MODE = 'reject';
  try {
    const req = request({ bodyToken: 'legacy-token' });
    assert.equal(reqtoken.bearerToken(req), '');
    assert.equal(req.authTokenSource, 'body_rejected');
    const snapshot = reqtoken.deprecationSnapshot();
    assert.equal(snapshot.bodyFallbackCount, 0);
    assert.equal(snapshot.bodyRejectedCount, 1);
  } finally {
    if (before == null) delete process.env.ID_TOKEN_BODY_COMPAT_MODE;
    else process.env.ID_TOKEN_BODY_COMPAT_MODE = before;
  }
});

test('oversized body tokens are ignored without being logged as a valid fallback', () => {
  reqtoken.resetDeprecationStatsForTests();
  const req = request({ bodyToken: 'x'.repeat(8193) });
  assert.equal(reqtoken.bearerToken(req), '');
  assert.equal(reqtoken.deprecationSnapshot().bodyFallbackCount, 0);
});
