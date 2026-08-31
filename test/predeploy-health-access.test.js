'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveHealthRequest } = require('../scripts/predeploy-v2');

test('predeploy uses protected detailed health when a secret is supplied', () => {
  const request = resolveHealthRequest('https://api.example.test/healthz', 'detail-secret');
  assert.equal(request.url, 'https://api.example.test/api/health');
  assert.deepEqual(request.headers, { 'x-health-secret': 'detail-secret' });
});

test('predeploy preserves public health URL without leaking an empty secret header', () => {
  const request = resolveHealthRequest('https://api.example.test/healthz', '');
  assert.equal(request.url, 'https://api.example.test/healthz');
  assert.deepEqual(request.headers, {});
});
