'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createReplayGuard,
  handleInteractions,
  isFreshTimestamp,
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

test('매출 명령은 별도 Discord 권한 없이 실행된다', async () => {
  const body = {
    id: `test-${crypto.randomUUID()}`,
    type: 2,
    guild_id: '300001',
    member: { permissions: '0', roles: [], user: { id: '100001' } },
    data: { name: '매출', options: [{ name: '기간', value: 'today' }] }
  };
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
  const revenue = {
    label: '오늘',
    totalPaid: 10000,
    totalCount: 1,
    refundAmount: 0,
    refundCount: 0,
    charge: { paidAmount: 10000, paidCount: 1 },
    sub: { paidAmount: 0, paidCount: 0 }
  };

  try {
    const response = responseRecorder();
    await handleInteractions(req, response, { getRevenueFn: async () => revenue });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload?.type, 4);
    assert.equal(response.payload?.data?.flags, 64);
    assert.equal(response.payload?.data?.embeds?.[0]?.title, '📊 매출 · 오늘');
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
