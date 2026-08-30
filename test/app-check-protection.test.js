'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appCheckMode,
  createAppCheckProtection
} = require('../middleware/appCheckProtection');

function request({ method = 'POST', headers = {}, path = '/transform' } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    path,
    originalUrl: path,
    body: {},
    query: {},
    get(name) { return normalized[String(name).toLowerCase()] || ''; }
  };
}

async function invoke(middleware, req) {
  let nextCalled = false;
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await middleware(req, response, () => { nextCalled = true; });
  return { nextCalled, response };
}

const quietLogger = { warn() {} };

test('App Check mode supports explicit off/shadow/enforce and legacy enforcement', () => {
  assert.equal(appCheckMode({}), 'shadow');
  assert.equal(appCheckMode({ APPCHECK_MODE: 'off' }), 'off');
  assert.equal(appCheckMode({ APPCHECK_MODE: 'enforce' }), 'enforce');
  assert.equal(appCheckMode({ APPCHECK_ENFORCE: '1' }), 'enforce');
});

test('shadow mode records missing App Check without breaking an old frontend', async () => {
  const req = request();
  const result = await invoke(createAppCheckProtection({
    mode: 'shadow',
    verifyAppCheck: async () => false,
    logger: quietLogger
  }), req);
  assert.equal(result.nextCalled, true);
  assert.equal(req.appCheck.status, 'shadow_missing');
});

test('enforce mode accepts a valid App Check token and rejects a missing token', async () => {
  const middleware = createAppCheckProtection({
    mode: 'enforce',
    verifyAppCheck: async token => token === 'valid-app-token',
    logger: quietLogger
  });
  const valid = request({ headers: { 'x-firebase-appcheck': 'valid-app-token' } });
  assert.equal((await invoke(middleware, valid)).nextCalled, true);
  assert.equal(valid.appCheck.status, 'valid');

  const missing = await invoke(middleware, request());
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.response.statusCode, 401);
  assert.equal(missing.response.body.code, 'APP_CHECK_REQUIRED');
});

test('verified administrators bypass App Check but ordinary Firebase users do not', async () => {
  const middleware = createAppCheckProtection({
    mode: 'enforce',
    verifyAppCheck: async () => false,
    verifyFirebaseIdToken: async token => ({ uid: token === 'admin-token' ? 'admin-uid' : 'user-uid' }),
    adminUids: ['admin-uid'],
    logger: quietLogger
  });
  const adminReq = request({ headers: { authorization: 'Bearer admin-token' } });
  assert.equal((await invoke(middleware, adminReq)).nextCalled, true);
  assert.equal(adminReq.appCheck.status, 'exempt_admin');

  const userReq = request({ headers: { authorization: 'Bearer user-token' } });
  assert.equal((await invoke(middleware, userReq)).response.statusCode, 401);

  const legacyAdminReq = request();
  legacyAdminReq.body.idToken = 'admin-token';
  assert.equal((await invoke(middleware, legacyAdminReq)).nextCalled, true);
  assert.equal(legacyAdminReq.appCheck.status, 'exempt_admin');
});

test('safe methods never require App Check', async () => {
  const middleware = createAppCheckProtection({ mode: 'enforce', verifyAppCheck: async () => false, logger: quietLogger });
  assert.equal((await invoke(middleware, request({ method: 'GET' }))).nextCalled, true);
  assert.equal((await invoke(middleware, request({ method: 'OPTIONS' }))).nextCalled, true);
});

test('cron exemption is opt-in and accepts only header or bearer cron auth', async () => {
  const middleware = createAppCheckProtection({
    mode: 'enforce',
    verifyAppCheck: async () => false,
    allowAdmin: false,
    allowCron: true,
    cronSecret: 'cron-secret',
    logger: quietLogger
  });
  const cronReq = request({ headers: { 'x-cron-secret': 'cron-secret' } });
  assert.equal((await invoke(middleware, cronReq)).nextCalled, true);
  assert.equal(cronReq.appCheck.status, 'exempt_cron');

  const bodyOnly = request();
  bodyOnly.body.internalKey = 'cron-secret';
  assert.equal((await invoke(middleware, bodyOnly)).response.statusCode, 401);
});
