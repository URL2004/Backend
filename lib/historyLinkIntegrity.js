'use strict';

const crypto = require('node:crypto');

const VERSION = 'history-link-hmac-v1';
const DOMAIN = 'gpkorea:history-link:detect-calibration:v1';
const MIN_SECRET_LENGTH = 32;

function secret() {
  const value = String(process.env.OPENAI_SAFETY_SALT || '').trim();
  return value.length >= MIN_SECRET_LENGTH ? value : '';
}

function normalizedText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, '')
    .trim();
}

function message(uid, outputText) {
  return [DOMAIN, String(uid || ''), normalizedText(outputText)].join('\0');
}

function sign(uid, outputText, key = secret()) {
  const resolved = String(key || '');
  if (resolved.length < MIN_SECRET_LENGTH || !uid || !normalizedText(outputText)) return null;
  return {
    version: VERSION,
    signature: crypto.createHmac('sha256', resolved).update(message(uid, outputText)).digest('base64url')
  };
}

function verify(uid, outputText, integrity, key = secret()) {
  if (integrity?.version !== VERSION || typeof integrity?.signature !== 'string') return false;
  const expected = sign(uid, outputText, key);
  if (!expected) return false;
  const left = Buffer.from(integrity.signature, 'utf8');
  const right = Buffer.from(expected.signature, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { DOMAIN, MIN_SECRET_LENGTH, VERSION, message, normalizedText, secret, sign, verify };
