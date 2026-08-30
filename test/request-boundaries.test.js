'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const errorHandler = require('../middleware/errorHandler');

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('oversized JSON receives a stable 413 contract without parser details', async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/payload', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  await withServer(app, async base => {
    const response = await fetch(`${base}/payload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(2048) })
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(JSON.stringify(body).includes('entity.too.large'), false);
  });
});

test('production server uses bounded JSON and Discord raw parsers plus dedicated limiters', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /JSON_BODY_LIMIT\s*\|\|\s*'2mb'/u);
  assert.match(source, /DISCORD_BODY_LIMIT\s*\|\|\s*'256kb'/u);
  assert.match(source, /discordInteractionLimiter/u);
  assert.match(source, /kakaoAuthLimiter/u);
  assert.doesNotMatch(source, /express\.json\(\{\s*limit:\s*'10mb'/u);
});
