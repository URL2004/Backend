'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_MAX_AGE_SECONDS,
  hasRecentAuthentication,
} = require('../lib/recentAuth');

test('recent authentication accepts the boundary and rejects stale or malformed claims', () => {
  const nowSeconds = 2_000_000_000;
  assert.equal(hasRecentAuthentication({ auth_time: nowSeconds }, { nowSeconds }), true);
  assert.equal(hasRecentAuthentication(
    { auth_time: nowSeconds - DEFAULT_MAX_AGE_SECONDS },
    { nowSeconds },
  ), true);
  assert.equal(hasRecentAuthentication(
    { auth_time: nowSeconds - DEFAULT_MAX_AGE_SECONDS - 1 },
    { nowSeconds },
  ), false);
  assert.equal(hasRecentAuthentication({}, { nowSeconds }), false);
  assert.equal(hasRecentAuthentication({ auth_time: 'not-a-number' }, { nowSeconds }), false);
  assert.equal(hasRecentAuthentication({ auth_time: nowSeconds + 61 }, { nowSeconds }), false);
});

test('account deletion requires a revoked-token check, recent auth, and header-only credentials', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'account.js'), 'utf8');
  assert.match(source, /verifyIdToken\(idToken,\s*true\)/);
  assert.match(source, /hasRecentAuthentication\(decoded\)/);
  assert.match(source, /ACCOUNT_RECENT_LOGIN_REQUIRED/);
  assert.doesNotMatch(source, /bearerToken\(req\)/);
  assert.doesNotMatch(source, /req\.body\.idToken/);
});
