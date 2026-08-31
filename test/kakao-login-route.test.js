'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const configPath = require.resolve('../config');
const identityPath = require.resolve('../lib/kakaoIdentity');
const routePath = require.resolve('../routes/kakaoLogin');
const originalConfigModule = require.cache[configPath];
const originalIdentityModule = require.cache[identityPath];
const originalRouteModule = require.cache[routePath];
const realIdentity = require('../lib/kakaoIdentity');

let customTokenIssueCount = 0;
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { admin: { auth() {} }, db: { collection() {} } }
};
require.cache[identityPath] = {
  id: identityPath,
  filename: identityPath,
  loaded: true,
  exports: {
    ...realIdentity,
    async issueFirebaseCustomToken() {
      customTokenIssueCount += 1;
      return {
        customToken: 'firebase-custom-token-for-test',
        firebaseUid: 'firebase-user-123',
        isNewUser: false,
        migratedLegacyAccount: true,
        subjectHash: 'a'.repeat(64)
      };
    }
  }
};
delete require.cache[routePath];
const kakaoLoginRouter = require('../routes/kakaoLogin');

const originalFetch = global.fetch;
const previousEnv = {
  enabled: process.env.KAKAO_CUSTOM_TOKEN_AUTH_ENABLED,
  appId: process.env.KAKAO_APP_ID,
  requireAppId: process.env.KAKAO_REQUIRE_APP_ID,
  authSalt: process.env.KAKAO_AUTH_SALT
};

let server;
let baseUrl;

function restoreModule(cachePath, original) {
  if (original) require.cache[cachePath] = original;
  else delete require.cache[cachePath];
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeKakaoResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; }
  };
}

test.before(async () => {
  process.env.KAKAO_APP_ID = '42';
  process.env.KAKAO_REQUIRE_APP_ID = '1';
  process.env.KAKAO_AUTH_SALT = 'kakao-route-contract-test-secret';
  global.fetch = async url => {
    const target = String(url);
    if (target.includes('/v1/user/access_token_info')) {
      return fakeKakaoResponse({ id: 12345, app_id: 42 });
    }
    if (target.includes('/v2/user/me')) {
      return fakeKakaoResponse({
        id: 12345,
        kakao_account: {
          is_email_valid: true,
          is_email_verified: true,
          email: 'verified@example.com',
          profile: { nickname: '카카오 사용자', profile_image_url: 'https://example.com/profile.png' }
        }
      });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  };

  const app = express();
  app.use(express.json());
  app.use('/', kakaoLoginRouter);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  global.fetch = originalFetch;
  restoreEnv('KAKAO_CUSTOM_TOKEN_AUTH_ENABLED', previousEnv.enabled);
  restoreEnv('KAKAO_APP_ID', previousEnv.appId);
  restoreEnv('KAKAO_REQUIRE_APP_ID', previousEnv.requireAppId);
  restoreEnv('KAKAO_AUTH_SALT', previousEnv.authSalt);
  restoreModule(routePath, originalRouteModule);
  restoreModule(identityPath, originalIdentityModule);
  restoreModule(configPath, originalConfigModule);
});

async function postLogin() {
  const response = await originalFetch(`${baseUrl}/kakao-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: 'provider-access-token' })
  });
  return { status: response.status, body: await response.json() };
}

test('custom-token flag OFF는 명시적 v1 호환 응답이며 Firebase custom token을 만들지 않는다', async () => {
  process.env.KAKAO_CUSTOM_TOKEN_AUTH_ENABLED = '0';
  customTokenIssueCount = 0;

  const result = await postLogin();

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.authVersion, 1);
  assert.equal(result.body.kakaoId, '12345');
  assert.equal(result.body.email, 'verified@example.com');
  assert.equal(result.body.customToken, undefined);
  assert.equal(customTokenIssueCount, 0);
});

test('custom-token flag ON은 v2 customToken 계약으로 전환하고 발급을 정확히 한 번 호출한다', async () => {
  process.env.KAKAO_CUSTOM_TOKEN_AUTH_ENABLED = '1';
  customTokenIssueCount = 0;

  const result = await postLogin();

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.authVersion, 2);
  assert.equal(result.body.customToken, 'firebase-custom-token-for-test');
  assert.equal(result.body.uid, 'firebase-user-123');
  assert.equal(result.body.isNewUser, false);
  assert.equal(result.body.profile.email, 'verified@example.com');
  assert.equal(customTokenIssueCount, 1);
});
