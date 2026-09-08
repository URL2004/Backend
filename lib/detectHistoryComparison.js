'use strict';

const crypto = require('node:crypto');
const { secret: historySecret } = require('./historyLinkIntegrity');

const VERSION = 'humanize-comparison-v1';
const PROOF_VERSION = 'detect-history-comparison-proof-v1';
const KEYS = ['version', 'basis', 'sourceProbability', 'rawProbability', 'probability',
  'rawDelta', 'adjustedDelta', 'adjustment', 'calibrationApplied', 'match', 'status'];
const score = value => Number.isInteger(value) && value >= 0 && value <= 100;

// Authenticate only the closed server comparison schema. The comparison is a
// service-score change, never evidence of human authorship or external AI rate.
function boundedHistoryComparison(value, publicScore) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))
      || value.version !== VERSION || value.basis !== 'history_adjusted_style'
      || !score(publicScore) || value.probability !== publicScore
      || !score(value.rawProbability)
      || !(value.sourceProbability === null || score(value.sourceProbability))
      || !['exact_normalized', 'near_normalized'].includes(value.match)
      || typeof value.calibrationApplied !== 'boolean') return null;
  const before = value.sourceProbability, raw = value.rawProbability, after = value.probability;
  const status = before === null ? 'unavailable' : after < before ? 'improved' : after === before ? 'unchanged' : 'increased';
  if (value.rawDelta !== (before === null ? null : raw - before)
      || value.adjustedDelta !== (before === null ? null : after - before)
      || value.adjustment !== after - raw || value.status !== status
      || after > raw || value.calibrationApplied !== (after < raw)) return null;
  return Object.fromEntries(KEYS.map(key => [key, value[key]]));
}

function signature(uid, text, publicScore, comparison, key) {
  const sourceHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const ordered = Object.fromEntries(Object.keys(comparison).sort().map(key => [key, comparison[key]]));
  return crypto.createHmac('sha256', key).update(JSON.stringify([
    PROOF_VERSION, String(uid), sourceHash, publicScore, ordered
  ]), 'utf8').digest('base64url');
}

function signHistoryComparison(uid, text, publicScore, comparison, key = historySecret()) {
  const info = boundedHistoryComparison(comparison, publicScore);
  if (!uid || typeof text !== 'string' || !text.length || !info || String(key || '').length < 32) return null;
  return `${PROOF_VERSION}.${signature(uid, text, publicScore, info, key)}`;
}

function verifiedBackupHistoryComparison(uid, entry = {}, key = historySecret()) {
  const info = boundedHistoryComparison(entry.historyComparison, entry.probability);
  const proof = entry.historyComparisonProof;
  const signed = typeof proof === 'string' && proof.startsWith(`${PROOF_VERSION}.`)
    ? proof.slice(PROOF_VERSION.length + 1) : '';
  if (!uid || typeof entry.inputText !== 'string' || !entry.inputText.length || !info
      || String(key || '').length < 32 || !/^[A-Za-z0-9_-]{43}$/u.test(signed)) return null;
  const expected = Buffer.from(signature(uid, entry.inputText, entry.probability, info, key));
  return crypto.timingSafeEqual(expected, Buffer.from(signed)) ? info : null;
}

module.exports = { VERSION, PROOF_VERSION, boundedHistoryComparison, signHistoryComparison, verifiedBackupHistoryComparison };
