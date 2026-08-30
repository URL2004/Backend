'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('Kakao and Discord routes do not log or return raw provider identity and error payloads', () => {
  const kakaoSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'kakaoLogin.js'), 'utf8');
  const discordSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'discordBot.js'), 'utf8');

  assert.doesNotMatch(kakaoSource, /kakao\s*:\s*userData/u);
  assert.doesNotMatch(kakaoSource, /\{\s*kakaoId\s*,\s*email\s*\}/u);
  assert.match(kakaoSource, /hasEmail:\s*Boolean/u);
  assert.doesNotMatch(discordSource, /content:[^\n]+e\.message/u);
  assert.match(discordSource, /잠시 후 다시 시도해 주세요/u);
});

test('logger scrubs embedded credentials and email addresses from strings and Errors', () => {
  const previousStacks = process.env.LOG_STACKS;
  process.env.LOG_STACKS = '1';
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => { output += String(chunk); return true; };

  try {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.X7sZQ8mP2vN4cR6tY1uI9oL3kJ5hG7fD';
    const err = new Error(`request failed for admin@example.com with Bearer bearer-secret-value and ${jwt}`);
    err.stack = `Error: callback https://example.test/cb?id_token=id-secret&apiKey=api-secret&safe=1\n at test.js:1:1`;
    logger.info('test.embedded_redaction', {
      message: 'contact jane.doe@example.com; url=https://example.test/?paymentKey=pay-secret&signature=sig-secret',
      err
    });
  } finally {
    process.stdout.write = originalWrite;
    if (previousStacks === undefined) delete process.env.LOG_STACKS;
    else process.env.LOG_STACKS = previousStacks;
  }

  const record = JSON.parse(output.trim());
  const serialized = JSON.stringify(record);
  for (const secret of [
    'admin@example.com',
    'jane.doe@example.com',
    'bearer-secret-value',
    'eyJhbGciOiJIUzI1NiJ9',
    'id-secret',
    'api-secret',
    'pay-secret',
    'sig-secret'
  ]) {
    assert.equal(serialized.includes(secret), false, `must scrub embedded value: ${secret}`);
  }
  assert.match(record.message, /safe|signature=\[REDACTED\]/u);
  assert.match(record.err.message, /Bearer \[REDACTED\]/u);
  assert.match(record.err.stack, /id_token=\[REDACTED\]/u);
});
