'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyDetailedHealthRequest } = require('../lib/healthAuth');

function req(headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { get(name) { return normalized[String(name).toLowerCase()] || ''; } };
}

test('detailed health accepts only its header or bearer secret', () => {
  assert.equal(verifyDetailedHealthRequest(req(), '').reason, 'secret_missing');
  assert.equal(verifyDetailedHealthRequest(req(), 'health-secret').reason, 'absent');
  assert.equal(verifyDetailedHealthRequest(req({ 'x-health-secret': 'wrong' }), 'health-secret').ok, false);
  assert.equal(verifyDetailedHealthRequest(req({ 'x-health-secret': 'health-secret' }), 'health-secret').ok, true);
  assert.equal(verifyDetailedHealthRequest(req({ authorization: 'Bearer health-secret' }), 'health-secret').ok, true);
});

test('public health response is minimal and detailed runtime fields stay behind /internal/health', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const publicStart = source.indexOf("app.get(['/healthz', '/api/health']");
  const internalStart = source.indexOf("app.get('/internal/health'");
  assert.ok(publicStart > 0 && internalStart > publicStart);
  const publicHandler = source.slice(publicStart, internalStart);
  assert.match(publicHandler, /status\(200\)\.json\(\{\s*ok:\s*true,\s*status:\s*'up'\s*\}\)/u);
  assert.doesNotMatch(publicHandler, /detailedHealth\(/u);
  assert.doesNotMatch(publicHandler, /activeJobs|activeProvider|openai|firebase|uptimeSec/u);
  assert.match(source.slice(internalStart), /verifyDetailedHealthRequest/u);
});
