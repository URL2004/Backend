'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { logger } = require('../lib/logger');

test('logger masks nested credential, signature, and card-verification fields', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => { output += String(chunk); return true; };

  try {
    logger.info('test.nested_redaction', {
      request: {
        id_token: 'id-token-value-should-not-appear',
        apiKey: 'api-key-value-should-not-appear',
        token: 'generic-token-value-should-not-appear',
        authToken: 'auth-token-value-should-not-appear',
        signature: 'signature-value-should-not-appear',
        webhookSignature: 'webhook-signature-value-should-not-appear',
        payment: { cvv: '123', cvc: '456' },
        nested: [{
          refreshToken: 'refresh-token-value-should-not-appear',
          contactPhone: '010-1234-5678'
        }]
      },
      safe: {
        inputTokens: 1234,
        signatureLineCount: 2,
        message: 'visible diagnostic text'
      }
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const record = JSON.parse(output.trim());
  const serialized = JSON.stringify(record);
  for (const secret of [
    'id-token-value-should-not-appear',
    'api-key-value-should-not-appear',
    'generic-token-value-should-not-appear',
    'auth-token-value-should-not-appear',
    'signature-value-should-not-appear',
    'webhook-signature-value-should-not-appear',
    'refresh-token-value-should-not-appear',
    '010-1234-5678'
  ]) {
    assert.equal(serialized.includes(secret), false, `must redact ${secret}`);
  }
  assert.equal(record.request.id_token, '[REDACTED]');
  assert.equal(record.request.apiKey, '[REDACTED]');
  assert.equal(record.request.token, '[REDACTED]');
  assert.equal(record.request.payment.cvv, '[REDACTED]');
  assert.equal(record.request.payment.cvc, '[REDACTED]');
  assert.equal(record.safe.inputTokens, 1234);
  assert.equal(record.safe.signatureLineCount, 2);
  assert.equal(record.safe.message, 'visible diagnostic text');
});
