'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createReplayGuard,
  handleInteractions,
  hasAdministratorPermission,
  isFreshTimestamp,
  isRevenueAuthorized,
  verifySignature
} = require('../routes/discordBot');

function signingFixture(bodyValue, timestamp = String(Math.floor(Date.now() / 1000))) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawBody = Buffer.from(JSON.stringify(bodyValue));
  const signed = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  const signature = crypto.sign(null, signed, privateKey).toString('hex');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKey: publicDer.subarray(publicDer.length - 32).toString('hex'),
    rawBody,
    signature,
    timestamp
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test('Discord Ed25519 verification binds the timestamp and exact raw body', () => {
  const fixture = signingFixture({ type: 1 });
  assert.equal(
    verifySignature(fixture.rawBody, fixture.signature, fixture.timestamp, fixture.publicKey),
    true
  );
  assert.equal(
    verifySignature(Buffer.from('{"type":2}'), fixture.signature, fixture.timestamp, fixture.publicKey),
    false
  );
});

test('Discord interaction timestamps accept the five-minute window only', () => {
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  assert.equal(isFreshTimestamp(String(now / 1000), now), true);
  assert.equal(isFreshTimestamp(String((now - 300000) / 1000), now), true);
  assert.equal(isFreshTimestamp(String((now - 301000) / 1000), now), false);
  assert.equal(isFreshTimestamp(String((now + 301000) / 1000), now), false);
  assert.equal(isFreshTimestamp('not-a-timestamp', now), false);
});

test('replay guard rejects duplicates, expires entries, and remains bounded', () => {
  let now = 1000;
  const guard = createReplayGuard({ maxEntries: 2, ttlMs: 100, now: () => now });

  assert.equal(guard.claim('first'), true);
  assert.equal(guard.claim('first'), false);
  assert.equal(guard.claim('second'), true);
  assert.equal(guard.claim('third'), true);
  assert.equal(guard.size(), 2);

  now += 101;
  assert.equal(guard.claim('first'), true);
  assert.equal(guard.size(), 1);
});

test('매출 명령은 guild 관리자 또는 명시 allowlist만 허용하고 설정 부재는 fail-closed다', () => {
  const oldUsers = process.env.DISCORD_REVENUE_ALLOWED_USER_IDS;
  const oldRoles = process.env.DISCORD_REVENUE_ALLOWED_ROLE_IDS;
  const oldGuild = process.env.DISCORD_GUILD_ID;
  const oldRevenueGuilds = process.env.DISCORD_REVENUE_ALLOWED_GUILD_IDS;
  delete process.env.DISCORD_REVENUE_ALLOWED_USER_IDS;
  delete process.env.DISCORD_REVENUE_ALLOWED_ROLE_IDS;
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_REVENUE_ALLOWED_GUILD_IDS;
  try {
    assert.equal(hasAdministratorPermission('8'), true);
    assert.equal(hasAdministratorPermission('0'), false);
    assert.equal(isRevenueAuthorized({ guild_id: '300001', member: { permissions: '8', user: { id: '100001' } } }), false);
    assert.equal(isRevenueAuthorized({ member: { permissions: '0', user: { id: '100001' } } }), false);

    process.env.DISCORD_REVENUE_ALLOWED_USER_IDS = '100001, 100002';
    process.env.DISCORD_REVENUE_ALLOWED_ROLE_IDS = '200001';
    process.env.DISCORD_GUILD_ID = '300001';
    assert.equal(isRevenueAuthorized({ member: { permissions: '0', user: { id: '100001' } } }), true);
    assert.equal(isRevenueAuthorized({ guild_id: '300001', member: { permissions: '8', user: { id: '999999' } } }), true);
    assert.equal(isRevenueAuthorized({ guild_id: '399999', member: { permissions: '8', user: { id: '999999' } } }), false);
    assert.equal(isRevenueAuthorized({ guild_id: '300001', member: { permissions: '0', user: { id: '999999' }, roles: ['200001'] } }), true);
    assert.equal(isRevenueAuthorized({ guild_id: '399999', member: { permissions: '0', user: { id: '999999' }, roles: ['200001'] } }), false);
    assert.equal(isRevenueAuthorized({ guild_id: '300001', member: { permissions: '0', user: { id: '999999' }, roles: ['299999'] } }), false);
  } finally {
    if (oldUsers === undefined) delete process.env.DISCORD_REVENUE_ALLOWED_USER_IDS;
    else process.env.DISCORD_REVENUE_ALLOWED_USER_IDS = oldUsers;
    if (oldRoles === undefined) delete process.env.DISCORD_REVENUE_ALLOWED_ROLE_IDS;
    else process.env.DISCORD_REVENUE_ALLOWED_ROLE_IDS = oldRoles;
    if (oldGuild === undefined) delete process.env.DISCORD_GUILD_ID;
    else process.env.DISCORD_GUILD_ID = oldGuild;
    if (oldRevenueGuilds === undefined) delete process.env.DISCORD_REVENUE_ALLOWED_GUILD_IDS;
    else process.env.DISCORD_REVENUE_ALLOWED_GUILD_IDS = oldRevenueGuilds;
  }
});

test('valid Discord PING contract remains unchanged', async () => {
  const fixture = signingFixture({ type: 1 });
  const previousKey = process.env.DISCORD_PUBLIC_KEY;
  process.env.DISCORD_PUBLIC_KEY = fixture.publicKey;
  const req = {
    body: fixture.rawBody,
    get(name) {
      const headers = {
        'x-signature-ed25519': fixture.signature,
        'x-signature-timestamp': fixture.timestamp
      };
      return headers[String(name).toLowerCase()];
    }
  };

  try {
    const first = responseRecorder();
    const second = responseRecorder();
    await handleInteractions(req, first);
    await handleInteractions(req, second);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.payload, { type: 1 });
    assert.equal(second.statusCode, 200, 'side-effect-free endpoint validation PING may repeat');
    assert.deepEqual(second.payload, { type: 1 });
  } finally {
    if (previousKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previousKey;
  }
});

test('a valid non-PING interaction is accepted once and then rejected as replay', async () => {
  const body = { id: `test-${crypto.randomUUID()}`, type: 2, data: { name: 'unknown' } };
  const fixture = signingFixture(body);
  const previousKey = process.env.DISCORD_PUBLIC_KEY;
  process.env.DISCORD_PUBLIC_KEY = fixture.publicKey;
  const req = {
    body: fixture.rawBody,
    get(name) {
      const headers = {
        'x-signature-ed25519': fixture.signature,
        'x-signature-timestamp': fixture.timestamp
      };
      return headers[String(name).toLowerCase()];
    }
  };

  try {
    const first = responseRecorder();
    const second = responseRecorder();
    await handleInteractions(req, first);
    await handleInteractions(req, second);
    assert.equal(first.statusCode, 200);
    assert.equal(first.payload?.data?.content, '알 수 없는 명령입니다.');
    assert.equal(second.statusCode, 401);
    assert.equal(second.payload, 'invalid request signature');
  } finally {
    if (previousKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previousKey;
  }
});
