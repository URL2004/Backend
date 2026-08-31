'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server disables framework signature and exposes minimal public health endpoints', () => {
  assert.match(server, /app\.disable\('x-powered-by'\)/u);
  assert.match(server, /app\.get\('\/livez'/u);
  assert.match(server, /app\.get\('\/healthz'/u);
  assert.match(server, /canReadDetailedHealth\(req\)/u);
  const publicHealth = server.slice(server.indexOf("app.get('/healthz'"), server.indexOf("app.get('/api/health'"));
  assert.doesNotMatch(publicHealth, /result\.body/u, 'public health must not expose internal runtime details');
});

test('server limits body size before JSON parser on sensitive routes', () => {
  assert.match(server, /installJsonBodyParsers\(app, express\)/u);
  assert.match(server, /express\.raw\(\{ type: '\*\/\*', limit: '256kb' \}\)/u);
  assert.doesNotMatch(server, /limit: '10mb'/u);
});

test('high-cost and state-changing routes are rate-limited without throttling Toss webhook', () => {
  assert.match(server, /app\.use\('\/writing-lab'/u);
  assert.match(server, /'\/confirm-payment'/u);
  assert.match(server, /'\/subscription\/charge'/u);
  const limiterSection = server.slice(server.indexOf('// Rate Limiter'), server.indexOf('// 공개 생존'));
  assert.doesNotMatch(limiterSection, /toss\/webhook/u);
  assert.match(limiterSection, /app\.use\('\/admin', adminLimiter\)/u,
    '관리자 병렬 조회는 일반 사용자 30회 한도와 분리해야 함');
  assert.doesNotMatch(limiterSection, /app\.use\('\/admin', limiter\)/u);
});
