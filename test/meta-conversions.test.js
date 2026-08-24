const test = require('node:test');
const assert = require('node:assert/strict');

const meta = require('../lib/metaConversions');

test('stable event id is deterministic and safe for Pixel/CAPI deduplication', () => {
  const a = meta.stableEventId('sign_up', 'uid-1|2026-08-24T10:00:00.000Z');
  const b = meta.stableEventId('sign_up', 'uid-1|2026-08-24T10:00:00.000Z');
  assert.equal(a, b);
  assert.match(a, /^gp_sign_up_[a-f0-9]+$/);
});

test('CAPI event hashes identifiers and drops foreign source URLs', () => {
  const event = meta._private.buildEvent({
    eventName: 'CompleteRegistration',
    eventId: 'gp_sign_up_123abc',
    email: 'Person@Example.com ',
    externalId: 'firebase-uid-1',
    clientIp: '203.0.113.10',
    userAgent: 'test-agent',
    context: {
      sourceUrl: 'https://evil.example/path?paymentKey=secret',
      fbp: 'fb.1.1787560000000.browser',
      fbc: 'fb.1.1787560000000.click'
    },
    customData: { status: true }
  });
  assert.equal(event.event_source_url, undefined);
  assert.equal(event.user_data.em[0], meta.sha256('person@example.com'));
  assert.equal(event.user_data.external_id[0], meta.sha256('firebase-uid-1'));
  assert.equal(event.user_data.client_ip_address, '203.0.113.10');
  assert.equal(event.user_data.fbp, 'fb.1.1787560000000.browser');
  assert.equal(JSON.stringify(event).includes('Person@Example.com'), false);
});

test('CAPI sends one strict event payload when configured', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.META_CAPI_ACCESS_TOKEN;
  process.env.META_CAPI_ACCESS_TOKEN = 'test-token';
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, async json() { return { events_received: 1 }; } };
  };
  try {
    const result = await meta.sendCompleteRegistration({
      eventId: 'gp_sign_up_123abc',
      email: 'person@example.com',
      externalId: 'uid-1',
      context: { sourceUrl: 'https://gpkorea.ai.kr/?utm_source=meta&paymentKey=secret' }
    });
    assert.equal(result.ok, true);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].event_name, 'CompleteRegistration');
    assert.equal(body.data[0].event_id, 'gp_sign_up_123abc');
    assert.equal(body.data[0].event_source_url, 'https://gpkorea.ai.kr/?utm_source=meta');
    assert.equal(body.data[0].event_source_url.includes('paymentKey'), false);
    assert.equal('input_text' in body.data[0], false);
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.META_CAPI_ACCESS_TOKEN;
    else process.env.META_CAPI_ACCESS_TOKEN = originalToken;
  }
});
