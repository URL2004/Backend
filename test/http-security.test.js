'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const securityHeaders = require('../middleware/securityHeaders');
const contentLengthLimit = require('../middleware/contentLengthLimit');
const { installJsonBodyParsers } = require('../middleware/jsonBodyParsers');
const { canReadDetailedHealth } = require('../lib/healthAccess');

test('API security middleware sets non-cacheable JSON security headers', () => {
  const headers = new Map();
  let nextCalled = false;
  securityHeaders({}, { setHeader: (name, value) => headers.set(name.toLowerCase(), value) }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.match(headers.get('content-security-policy'), /default-src 'none'/u);
});

test('detailed health fails closed and accepts only exact header secret', () => {
  const req = value => ({ get: name => name === 'x-health-secret' ? value : '' });
  assert.equal(canReadDetailedHealth(req(''), ''), false);
  assert.equal(canReadDetailedHealth(req('wrong'), 'correct-secret'), false);
  assert.equal(canReadDetailedHealth(req('correct-secret'), 'correct-secret'), true);
  assert.equal(canReadDetailedHealth(req(' correct-secret '), 'correct-secret'), true);
});

test('content-length guard rejects oversized requests before JSON parsing', () => {
  const guard = contentLengthLimit(1024);
  let nextCalled = false;
  const response = {
    code: 0,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
  guard({ get: () => '1025' }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.code, 413);
  assert.equal(response.body.error, 'payload_too_large');
  guard({ get: () => '1024' }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

async function withParserServer(run) {
  const app = express();
  installJsonBodyParsers(app, express);
  app.post('*', (req, res) => res.json({ ok: true, bytes: JSON.stringify(req.body || {}).length }));
  app.use((err, _req, res, _next) => res.status(err?.status || 500).json({ error: err?.type || 'parse_error' }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try { await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function chunkedJson(port, path, textSize) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{"text":"');
    const chunk = '가'.repeat(8192);
    let remaining = textSize;
    while (remaining > 0) {
      const part = chunk.slice(0, Math.min(chunk.length, remaining));
      req.write(part);
      remaining -= part.length;
    }
    req.end('"}');
  });
}

test('streaming JSON limits reject chunked oversize while preserving larger transform input', async () => {
  await withParserServer(async port => {
    assert.equal(await chunkedJson(port, '/confirm-payment', 150000), 413);
    assert.equal(await chunkedJson(port, '/transform', 150000), 200);
    assert.equal(await chunkedJson(port, '/unclassified', 800000), 413);
  });
});
