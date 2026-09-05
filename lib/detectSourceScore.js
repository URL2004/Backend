'use strict';

const crypto = require('node:crypto');
const { secret: historySecret } = require('./historyLinkIntegrity');
const VERSION = 'detect-source-score-v1';
const LOOKUP_LIMIT = 50;

// Optional scores must distinguish an absent value from a real measured zero.
function optionalScore(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? Math.round(score) : null;
}

function exactText(text) {
  return String(text || '').replace(/\r\n?/gu, '\n').trim();
}

// A browser-provided score is a lookup hint, never an authoritative ceiling.
// Bound the lookup and use only a server-saved LLM detection of the same input.
async function resolveSourceScore({ db, uid, text, claimedScore }) {
  const score = optionalScore(claimedScore);
  if (score === null || !db || !uid || !exactText(text)) return null;
  const query = db.collection('users').doc(uid).collection('history')
    .orderBy('createdAt', 'desc').limit(LOOKUP_LIMIT)
    .select('type', 'savedBy', 'probSource', 'inputText', 'probability', 'probabilityCalibration.applied');
  const snapshot = await query.get();
  for (const doc of snapshot.docs) {
    const record = doc.data() || {};
    if (record.type !== 'detect' || record.savedBy !== 'server' || record.probSource !== 'llm') continue;
    if (exactText(record.inputText) !== exactText(text)) continue;
    if (record.probabilityCalibration?.applied === true) return null;
    // Only the latest matching detection may be used; a stale lower claim
    // cannot select an earlier result from the same user's history.
    const measured = optionalScore(record.probability);
    return measured === score ? measured : null;
  }
  return null;
}

function signature(uid, outputText, score, key) {
  return crypto.createHmac('sha256', key)
    .update([VERSION, String(uid), exactText(outputText), String(score)].join('\0'), 'utf8')
    .digest('base64url');
}

// Call only after resolveSourceScore verifies the value against server history.
function signSourceScore(uid, outputText, verifiedScore, key = historySecret()) {
  const score = optionalScore(verifiedScore);
  if (score === null || !uid || !exactText(outputText) || String(key).length < 32) return null;
  return { version: VERSION, signature: signature(uid, outputText, score, key) };
}

function verifiedSourceScore(uid, record = {}, key = historySecret()) {
  const score = optionalScore(record.sourceProbability);
  const proof = record.historySourceScoreIntegrity;
  if (score === null || !uid || !exactText(record.outputText) || String(key).length < 32
      || proof?.version !== VERSION || typeof proof.signature !== 'string') return null;
  const expected = Buffer.from(signature(uid, record.outputText, score, key));
  const received = Buffer.from(proof.signature);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected) ? score : null;
}

module.exports = { VERSION, LOOKUP_LIMIT, optionalScore, resolveSourceScore, signSourceScore, verifiedSourceScore };
