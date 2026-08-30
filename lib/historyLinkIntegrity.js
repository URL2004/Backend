'use strict';

const crypto = require('node:crypto');

const VERSION = 'history-link-hmac-v2';
const DOMAIN = 'gpkorea:history-link:detect-calibration:v2';
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

function eligibilityClaims(record = {}) {
  const meta = record.engineMeta && typeof record.engineMeta === 'object' ? record.engineMeta : {};
  return {
    mode: String(record.mode || '').toLowerCase(),
    qualityStatus: String(record.qualityStatus || ''),
    billingDisposition: String(record.billingDisposition || ''),
    deliveryDecision: String(meta.deliveryDecision || ''),
    effectStatus: String(meta.effectStatus || ''),
    approvedModelChunkCount: Math.max(0, Number(meta.approvedModelChunkCount) || 0),
    modelFailureChunkCount: Math.max(0, Number(meta.modelFailureChunkCount) || 0),
    substantiveEditRatio: Number(Math.max(0, Number(meta.substantiveEditRatio) || 0).toFixed(4)),
    structureSignaturePass: meta.structureSignaturePass === true,
    fallbackFromMode: String(meta.fallbackFromMode || '')
  };
}

function isEligible(record = {}) {
  const claims = eligibilityClaims(record);
  return ['blog', 'formal'].includes(claims.mode)
    && claims.qualityStatus === 'clean'
    && ['charged', 'plan_unlimited', 'admin_no_charge'].includes(claims.billingDisposition)
    && claims.deliveryDecision === 'deliver_clean'
    && claims.effectStatus === 'normal'
    && claims.approvedModelChunkCount > 0
    && claims.modelFailureChunkCount === 0
    && claims.substantiveEditRatio >= 0.03
    && claims.structureSignaturePass
    && !claims.fallbackFromMode;
}

function message(uid, outputText, record = {}) {
  return [
    DOMAIN,
    String(uid || ''),
    normalizedText(outputText),
    JSON.stringify(eligibilityClaims(record))
  ].join('\0');
}

function sign(uid, outputText, record = {}, key = secret()) {
  const resolved = String(key || '');
  if (resolved.length < MIN_SECRET_LENGTH || !uid || !normalizedText(outputText) || !isEligible(record)) return null;
  return {
    version: VERSION,
    signature: crypto.createHmac('sha256', resolved).update(message(uid, outputText, record)).digest('base64url')
  };
}

function verify(uid, outputText, record, integrity, key = secret()) {
  if (integrity?.version !== VERSION || typeof integrity?.signature !== 'string') return false;
  const expected = sign(uid, outputText, record, key);
  if (!expected) return false;
  const left = Buffer.from(integrity.signature, 'utf8');
  const right = Buffer.from(expected.signature, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  DOMAIN,
  MIN_SECRET_LENGTH,
  VERSION,
  eligibilityClaims,
  isEligible,
  message,
  normalizedText,
  secret,
  sign,
  verify
};
