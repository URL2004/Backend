'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { corsMiddleware } = require('../config');
const {
  apiSecurityHeaders,
  protectPublicHealthPayload
} = require('../middleware/httpSecurity');

async function listen(app) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
    server.on('error', reject);
  });
}

test('API defaults prevent caching, MIME sniffing, framing, referrer leakage, and framework disclosure', async t => {
  const app = express();
  app.disable('x-powered-by');
  app.use(apiSecurityHeaders);
  app.get('/fixture', (_req, res) => res.json({ ok: true }));
  app.get('/explicit-public-cache', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`${baseUrl}/fixture`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('cross-origin-opener-policy'), null);
  assert.equal(response.headers.get('cross-origin-resource-policy'), null);
  assert.equal(response.headers.get('x-powered-by'), null);

  const explicitlyCacheable = await fetch(`${baseUrl}/explicit-public-cache`);
  assert.equal(explicitlyCacheable.headers.get('cache-control'), 'public, max-age=60');
});

test('public health disclosure guard preserves the existing response object and rejects configured secrets', () => {
  const existingContract = {
    ok: true,
    activeProvider: 'gpt',
    providerCompatible: true,
    runtimeConfigSource: 'environment',
    humanizeEngineV2: true,
    humanizeEngineVersion: 'gpt-prod-v2.5.41',
    activeJobs: 0,
    firebase: true,
    openai: true,
    maintenance: false,
    uptimeSec: 10
  };
  const env = {
    OPENAI_API_KEY: ['sk', 'test-not-a-real-secret-1234'].join('-'),
    CRON_SECRET: 'cron-test-not-a-real-secret-5678'
  };

  assert.strictEqual(protectPublicHealthPayload(existingContract, env), existingContract);
  assert.deepEqual(protectPublicHealthPayload(existingContract, env), existingContract);
  assert.throws(
    () => protectPublicHealthPayload({ ok: true, debug: `token=${env.OPENAI_API_KEY}` }, env),
    error => error?.code === 'HEALTH_PAYLOAD_SENSITIVE_VALUE'
  );
});

test('CORS advertises only the HTTP methods used by production API routes', async t => {
  const app = express();
  app.use(corsMiddleware);
  app.get('/fixture', (_req, res) => res.json({ ok: true }));

  const { server, baseUrl } = await listen(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`${baseUrl}/fixture`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://gpkorea.ai.kr',
      'Access-Control-Request-Method': 'PUT'
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://gpkorea.ai.kr');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET,POST,HEAD,OPTIONS');
  assert.doesNotMatch(response.headers.get('access-control-allow-methods') || '', /PUT|PATCH|DELETE/u);
});

test('production server wires security defaults before routes and separates public and detailed health', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const disableAt = source.indexOf("app.disable('x-powered-by')");
  const headersAt = source.indexOf('app.use(apiSecurityHeaders)');
  const discordAt = source.indexOf("'/discord/interactions'");
  const routeAt = source.indexOf("app.use('/', require('./routes/analyze'))");

  assert.ok(disableAt >= 0, 'Express framework disclosure must be disabled');
  assert.ok(headersAt > disableAt, 'security header middleware must be installed after app creation');
  assert.ok(discordAt > headersAt, 'security headers must cover the raw Discord route');
  assert.ok(routeAt > headersAt, 'security headers must cover API routes');
  assert.match(source, /app\.get\(\['\/healthz', '\/api\/health'\]/u);
  assert.match(source, /app\.get\('\/internal\/health'/u);
  assert.match(source, /protectPublicHealthPayload\(/u);
});
