'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAuthDiagnostic, createDiagnosticLimiter } = require('../lib/authDiagnostics');
const valid = { attempt_id: 'a'.repeat(32), method: 'kakao', flow: 'redirect', stage: 'token_exchange', outcome: 'error',
  error_code: 'KAKAO_TOKEN_EXCHANGE_FAILED', duration_ms: 1234, release: 'v1', device: 'mobile', traffic_source: 'naver', traffic_medium: 'cpc' };
test('anonymous auth diagnostics enforce schema and strip credentials, raw text and arbitrary codes', () => {
  const x = normalizeAuthDiagnostic({ ...valid, email: 'person@example.test', token: 'private', state: 'secret', message: 'source text', error_code: 'unrecognized-private' }, 'Instagram');
  assert.equal(x.error_code, 'unknown'); assert.equal(x.browser, 'instagram');
  assert.equal(x.traffic_source, 'naver');
  for (const k of ['email', 'token', 'state', 'message']) assert.equal(k in x, false);
  assert.equal(normalizeAuthDiagnostic({ ...valid, attempt_id: '' }), null);
  assert.equal(normalizeAuthDiagnostic({ ...valid, method: 'malicious' }), null);
  assert.equal(normalizeAuthDiagnostic({ ...valid, outcome: 'success' }), null);
});
test('rate limiter expires buckets, limits memory, and keeps callers independent', () => {
  const limited = createDiagnosticLimiter({ max: 2, capacity: 2, windowMs: 10 });
  assert.equal(limited('one', 0), false); assert.equal(limited('one', 1), false); assert.equal(limited('one', 2), true);
  assert.equal(limited('two', 2), false); assert.equal(limited('three', 2), true);
  assert.equal(limited('three', 12), false);
});

test('the events handler accepts anonymous safe diagnostics, rejects malformed and throttles without alerts', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const records = []; let handler;
  const unexpected = () => { throw new Error('Auth diagnostics must not invoke authentication or notifications'); };
  const stubs = {
    express: { Router: () => ({ post: (path, fn) => { assert.equal(path, '/events'); handler = fn; } }) },
    '../config': { verifyFirebaseIdToken: unexpected },
    '../lib/logger': { logger: { info: (...args) => records.push(args) }, setLogContext: unexpected },
    '../lib/discord': { enabled: unexpected },
    '../lib/clientip': { realClientIp: req => req.ip },
    '../lib/cronAuth': {}, '../lib/metaConversions': {},
    '../lib/reqtoken': { bearerToken: unexpected },
    '../lib/paymentFailureTaxonomy': {},
    '../lib/authDiagnostics': { normalizeAuthDiagnostic, createDiagnosticLimiter }
  };
  const file = require.resolve('../routes/events');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: id => {
    assert.ok(Object.hasOwn(stubs, id), id); return stubs[id];
  }, module: { exports: {} }, Date, Map, Set });
  const send = async body => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(data) { this.body = data; return this; } };
    await handler({ body, ip: 'one', get: () => 'Safari' }, res); return res;
  };
  assert.equal((await send({ ...valid, type: 'auth_diagnostic', token: 'secret', message: 'raw' })).statusCode, 200);
  assert.equal(records[0][0], 'client.auth_diagnostic'); assert.equal(records[0][1].token, undefined);
  assert.equal((await send({ type: 'auth_diagnostic' })).statusCode, 400);
  for (let i = 0; i < 58; i++) await send({ ...valid, type: 'auth_diagnostic' });
  assert.equal((await send({ ...valid, type: 'auth_diagnostic' })).statusCode, 429);
  assert.equal(records.length, 59);
});
