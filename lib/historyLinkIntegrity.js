'use strict';

const crypto = require('node:crypto');

const VERSION = 'history-link-hmac-v3';
const DOMAIN = 'gpkorea:history-link:detect-calibration:v3';
const LEGACY_V2_VERSION = 'history-link-hmac-v2';
const LEGACY_V2_DOMAIN = 'gpkorea:history-link:detect-calibration:v2';
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

function provenanceClaims(record = {}) {
  return {
    type: String(record.type || '').toLowerCase(),
    savedBy: String(record.savedBy || ''),
    ...eligibilityClaims(record)
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

// Exact matches may include a delivered review warning when every other
// billing, effect, model, edit-depth, and structure safeguard passed. Near
// matches remain restricted by isEligible() because the user may have edited a
// warned result after delivery.
function isExactCalibrationEligible(record = {}) {
  const claims = provenanceClaims(record);
  return claims.type === 'humanize'
    && claims.savedBy === 'server'
    && ['blog', 'formal'].includes(claims.mode)
    && ['clean', 'needs_review'].includes(claims.qualityStatus)
    && ['charged', 'plan_unlimited', 'admin_no_charge'].includes(claims.billingDisposition)
    && ['deliver_clean', 'deliver_review'].includes(claims.deliveryDecision)
    && claims.effectStatus === 'normal'
    && claims.approvedModelChunkCount > 0
    && claims.modelFailureChunkCount === 0
    && claims.substantiveEditRatio >= 0.03
    && claims.structureSignaturePass
    && !claims.fallbackFromMode;
}

function message(uid, outputText, record = {}, version = VERSION) {
  if (version === LEGACY_V2_VERSION) {
    return [
      LEGACY_V2_DOMAIN,
      String(uid || ''),
      normalizedText(outputText),
      JSON.stringify(eligibilityClaims(record))
    ].join('\0');
  }
  return [
    DOMAIN,
    String(uid || ''),
    normalizedText(outputText),
    JSON.stringify(provenanceClaims(record))
  ].join('\0');
}

function signature(uid, outputText, record, key, version) {
  return crypto.createHmac('sha256', key)
    .update(message(uid, outputText, record, version))
    .digest('base64url');
}

function sign(uid, outputText, record = {}, key = secret()) {
  const resolved = String(key || '');
  if (resolved.length < MIN_SECRET_LENGTH
    || !uid
    || !normalizedText(outputText)
    || !isExactCalibrationEligible(record)) return null;
  return {
    version: VERSION,
    signature: signature(uid, outputText, record, resolved, VERSION)
  };
}

function verify(uid, outputText, record, integrity, key = secret()) {
  const version = String(integrity?.version || '');
  if (typeof integrity?.signature !== 'string') return false;
  if (![VERSION, LEGACY_V2_VERSION].includes(version)) return false;
  const resolved = String(key || '');
  if (resolved.length < MIN_SECRET_LENGTH || !uid || !normalizedText(outputText)) return false;
  if (version === VERSION && !isExactCalibrationEligible(record)) return false;
  // v2 signatures were issued before provenance and review state were
  // separated. Continue accepting only their original strict clean-result set.
  if (version !== VERSION && !isEligible(record)) return false;
  const expected = signature(uid, outputText, record, resolved, version);
  const left = Buffer.from(integrity.signature, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  DOMAIN,
  LEGACY_V2_DOMAIN,
  LEGACY_V2_VERSION,
  MIN_SECRET_LENGTH,
  VERSION,
  eligibilityClaims,
  isExactCalibrationEligible,
  isEligible,
  message,
  normalizedText,
  provenanceClaims,
  secret,
  sign,
  verify
};
