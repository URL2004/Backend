'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { logger } = require('../lib/logger');
const {
  accountInitializeQuotaLogFields,
  createRouter
} = require('../routes/clientData');

async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`
    }));
  });
}

test('가입 quota 오류는 원 principal 없이 독립 구조화 이벤트로 기록한다', async t => {
  const quotaError = Object.assign(new Error('잠시 후 다시 시도해 주세요.'), {
    status: 429,
    code: 'WRITE_QUOTA_EXCEEDED',
    quotaAction: 'account_initialize_ip',
    quotaScope: 'hourly',
    quotaCount: 10,
    quotaLimit: 10,
    grantCredits: 25,
    retryAfterSec: 1800
  });
  assert.deepEqual(accountInitializeQuotaLogFields(quotaError), {
    code: 'WRITE_QUOTA_EXCEEDED',
    action: 'account_initialize_ip',
    scope: 'hourly',
    count: 10,
    limit: 10,
    grantCredits: 25,
    retryAfterSec: 1800,
    noAlert: true
  });

  const calls = [];
  const realWarn = logger.warn;
  logger.warn = (event, fields) => calls.push({ event, fields });
  t.after(() => { logger.warn = realWarn; });

  const router = createRouter({
    service: { initializeAccount: async () => { throw quotaError; } },
    verifyFirebaseIdToken: async () => ({ uid: 'quota-user' }),
    clientPrincipal: () => 'principal_must_not_be_logged'
  });
  const { server, baseUrl } = await listen(router);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/account/initialize`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '1800');
  assert.equal((await response.json()).quotaScope, 'hourly');
  assert.deepEqual(calls, [{
    event: 'account.initialize_quota_exceeded',
    fields: {
      uid: undefined,
      code: 'WRITE_QUOTA_EXCEEDED',
      action: 'account_initialize_ip',
      scope: 'hourly',
      count: 10,
      limit: 10,
      grantCredits: 25,
      retryAfterSec: 1800,
      noAlert: true
    }
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /quota-user/u);
  assert.doesNotMatch(JSON.stringify(calls), /principal_must_not_be_logged/u);
});
