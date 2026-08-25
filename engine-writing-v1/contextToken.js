'use strict';

const crypto = require('crypto');
const { logger } = require('../lib/logger');

const DEV_SECRET = crypto.randomBytes(32);
let warned = false;

function secret() {
  const configured = process.env.WRITING_LAB_CONTEXT_SECRET;
  if (configured) {
    if (Buffer.byteLength(configured, 'utf8') < 32) {
      const error = new Error('WRITING_LAB_CONTEXT_SECRET_WEAK');
      error.code = 'WRITING_LAB_CONTEXT_SECRET_WEAK';
      throw error;
    }
    return Buffer.from(configured, 'utf8');
  }
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('WRITING_LAB_CONTEXT_SECRET_REQUIRED');
    error.code = 'WRITING_LAB_CONTEXT_SECRET_REQUIRED';
    throw error;
  }
  if (!warned) {
    warned = true;
    logger.warn('writinglab.context_secret_ephemeral', {
      message: 'WRITING_LAB_CONTEXT_SECRET 미설정 - 개발 프로세스 수명 동안만 검수 토큰이 유효합니다.'
    });
  }
  return DEV_SECRET;
}

function signContext(context, { ttlMs = 2 * 60 * 60 * 1000 } = {}) {
  const envelope = {
    version: 'writing-verification-context-v1',
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    context
  };
  const payload = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyContext(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
  if (!parts.every(part => /^[A-Za-z0-9_-]+$/u.test(part))) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
  const expected = crypto.createHmac('sha256', secret()).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return { ok: false, code: 'INVALID_CONTEXT_TOKEN' }; }
  // Node의 base64url 디코더는 마지막 문자의 사용되지 않는 비트가 달라도 같은
  // 바이트를 만들 수 있다. 정규 인코딩을 강제해 문자열 단위 변조도 거부한다.
  if (actual.toString('base64url') !== parts[1]) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
  let envelope;
  try {
    const payload = Buffer.from(parts[0], 'base64url');
    if (payload.toString('base64url') !== parts[0]) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
    envelope = JSON.parse(payload.toString('utf8'));
  } catch { return { ok: false, code: 'INVALID_CONTEXT_TOKEN' }; }
  if (envelope?.version !== 'writing-verification-context-v1' || !envelope.context) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
  if (!Number.isFinite(envelope.issuedAt) || envelope.issuedAt > Date.now() + 60_000) return { ok: false, code: 'INVALID_CONTEXT_TOKEN' };
  if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt < Date.now()) return { ok: false, code: 'CONTEXT_TOKEN_EXPIRED' };
  return { ok: true, context: envelope.context, issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt };
}

module.exports = { signContext, verifyContext };
