'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const requestContext = require('../middleware/requestContext');
const { clientHashForLog, originHostnameForLog } = require('../lib/requestLogPrivacy');

test('request log client hashes are deterministic, domain-separated, and omit unknown clients', () => {
  const secret = 'unit-test-server-secret';
  const first = clientHashForLog('203.0.113.10', secret);
  assert.equal(first, clientHashForLog('203.0.113.10', secret));
  assert.notEqual(first, clientHashForLog('203.0.113.11', secret));
  assert.notEqual(first, clientHashForLog('203.0.113.10', 'other-secret'));
  assert.match(first, /^client_v1_[a-f0-9]{24}$/u);
  assert.equal(first.includes('203.0.113.10'), false);
  assert.equal(clientHashForLog('unknown', secret), undefined);
});

test('request log origin keeps only the hostname', () => {
  assert.equal(
    originHostnameForLog('https://user:pass@App.Example.COM:8443/path?token=secret#fragment'),
    'app.example.com'
  );
  assert.equal(originHostnameForLog('null'), undefined);
  assert.equal(originHostnameForLog('not a url'), undefined);
});

test('request context logs only client hash, origin host, and bounded UA family', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => { output += String(chunk); return true; };

  const headers = {
    'cf-connecting-ip': '203.0.113.77',
    origin: 'https://app.example.com:8443/private?token=secret',
    'user-agent': 'Mozilla/5.0 Extremely-Detailed-Browser/123.456 private-marker'
  };
  const req = {
    method: 'GET',
    path: '/unit-test',
    ip: '127.0.0.1',
    get(name) { return headers[String(name).toLowerCase()]; }
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  res.setHeader = () => {};
  res.getHeader = () => undefined;

  try {
    requestContext(req, res, () => res.emit('finish'));
  } finally {
    process.stdout.write = originalWrite;
  }

  const record = JSON.parse(output.trim());
  const serialized = JSON.stringify(record);
  assert.match(record.clientHash, /^client_v1_[a-f0-9]{24}$/u);
  assert.equal(record.originHost, 'app.example.com');
  assert.equal(record.userAgentFamily, 'browser');
  assert.equal(serialized.includes('203.0.113.77'), false);
  assert.equal(serialized.includes('private?token=secret'), false);
  assert.equal(serialized.includes('private-marker'), false);
  assert.equal(Object.hasOwn(record, 'ip'), false);
  assert.equal(Object.hasOwn(record, 'origin'), false);
  assert.equal(Object.hasOwn(record, 'userAgent'), false);
});

test('client error relay logs UA family while Meta forwarding keeps its required request fields', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'events.js'), 'utf8');
  const clientErrorBlock = source.slice(source.indexOf("if (type === 'client_error')"), source.indexOf("if (!uid) return"));
  assert.match(clientErrorBlock, /userAgentFamily:\s*userAgentFamily\(req\)/u);
  assert.doesNotMatch(clientErrorBlock, /userAgent:\s*text\(req\.get\('user-agent'\)/u);
  assert.match(source, /clientIp:\s*realClientIp\(req\)/u);
  assert.match(source, /userAgent:\s*req\.get\('user-agent'\)/u);
});
