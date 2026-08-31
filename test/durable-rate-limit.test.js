'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLECTION,
  consumeDurableLimit,
  createDurableRateLimit,
  durableRateLimitMode,
  principalDocumentId,
  scopeForRequest
} = require('../middleware/durableRateLimit');

function fakeDb() {
  const rows = new Map();
  const snapshot = ref => ({ exists: rows.has(ref.path), data: () => rows.get(ref.path) });
  return {
    rows,
    collection(name) {
      return { doc(id) { return { path: `${name}/${id}` }; } };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: async ref => snapshot(ref),
        set(ref, value, options) { writes.push({ ref, value, merge: options?.merge === true }); }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        rows.set(write.ref.path, write.merge
          ? { ...(rows.get(write.ref.path) || {}), ...write.value }
          : write.value);
      }
      return result;
    }
  };
}

function req(path, method = 'POST') {
  return { path, method, headers: {}, ip: '203.20.10.2' };
}

async function invoke(middleware, request) {
  let nextCalled = false;
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await middleware(request, response, () => { nextCalled = true; });
  return { nextCalled, response };
}

test('durable limiter is explicitly off by default and scopes only expensive POST routes', () => {
  assert.equal(durableRateLimitMode({}), 'off');
  assert.equal(durableRateLimitMode({ DURABLE_RATE_LIMIT_MODE: 'shadow' }), 'shadow');
  assert.equal(durableRateLimitMode({ DURABLE_RATE_LIMIT_MODE: 'enforce' }), 'enforce');
  assert.equal(scopeForRequest(req('/transform')), 'ai');
  assert.equal(scopeForRequest(req('/transform/job/refine-paragraph')), 'ai');
  assert.equal(scopeForRequest(req('/confirm-payment')), 'payment');
  assert.equal(scopeForRequest(req('/subscription/charge')), '', 'server renewal workers must not consume browser quotas');
  assert.equal(scopeForRequest(req('/public/metrics', 'GET')), '');
  assert.equal(scopeForRequest(req('/transform/job', 'GET')), '');
});

test('durable counter is transactional, rolls buckets, and stores no raw principal', async () => {
  const db = fakeDb();
  const secret = 's'.repeat(40);
  const base = Date.parse('2026-08-30T04:10:00.000Z');
  const policy = { hourly: 2, daily: 3 };
  assert.equal((await consumeDurableLimit({ db, secret, scope: 'ai', principal: '198.51.100.22', policy, nowMs: base })).allowed, true);
  assert.equal((await consumeDurableLimit({ db, secret, scope: 'ai', principal: '198.51.100.22', policy, nowMs: base + 1 })).allowed, true);
  const blocked = await consumeDurableLimit({ db, secret, scope: 'ai', principal: '198.51.100.22', policy, nowMs: base + 2 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'hourly');
  const nextHour = await consumeDurableLimit({ db, secret, scope: 'ai', principal: '198.51.100.22', policy, nowMs: base + 3_600_000 });
  assert.equal(nextHour.allowed, true);
  const rows = [...db.rows.entries()];
  assert.equal(rows.length, 1);
  assert.match(rows[0][0], new RegExp(`^${COLLECTION}/[a-f0-9]{64}$`, 'u'));
  assert.equal(JSON.stringify(rows[0]).includes('198.51.100.22'), false);
  assert.equal(principalDocumentId(secret, 'ai', '198.51.100.22').length, 64);
});

test('shadow observes an exceeded durable limit while enforce rejects with Retry-After', async () => {
  const db = fakeDb();
  const common = {
    db,
    secret: 'r'.repeat(40),
    policies: { ai: { hourly: 1, daily: 10 }, payment: { hourly: 1, daily: 10 } },
    now: () => Date.parse('2026-08-30T05:00:00.000Z'),
    clientPrincipal: () => '203.20.10.2',
    logger: { warn() {} }
  };
  const shadow = createDurableRateLimit({ ...common, mode: 'shadow' });
  assert.equal((await invoke(shadow, req('/analyze'))).nextCalled, true);
  const observed = await invoke(shadow, req('/analyze'));
  assert.equal(observed.nextCalled, true);
  assert.equal(observed.response.statusCode, 200);

  const enforce = createDurableRateLimit({ ...common, mode: 'enforce' });
  const blocked = await invoke(enforce, req('/analyze'));
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.response.body.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.response.headers['Retry-After']) > 0);
});

test('durable datastore failure is fail-open so this optional layer cannot cause an outage', async () => {
  const middleware = createDurableRateLimit({
    db: { collection() { return { doc() { return {}; } }; }, runTransaction: async () => { throw new Error('firestore down'); } },
    mode: 'enforce',
    secret: 'x'.repeat(40),
    policies: { ai: { hourly: 1, daily: 1 }, payment: { hourly: 1, daily: 1 } },
    clientPrincipal: () => '203.20.10.2',
    logger: { warn() {} }
  });
  assert.equal((await invoke(middleware, req('/transform'))).nextCalled, true);
});
