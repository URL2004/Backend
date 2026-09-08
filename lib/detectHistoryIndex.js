'use strict';

const integrity = require('./historyLinkIntegrity');
const sourceScores = require('./detectSourceScore');
const { lookupHash } = require('./detectCalibration');

// A lookup index is only a locator. Runtime source/HMAC verification remains
// authoritative; this helper never upgrades unsigned or client-saved history.
function buildHistoryLookupFields(uid, record = {}) {
  if (typeof uid !== 'string' || !uid || !record || typeof record !== 'object'
    || record.savedBy !== 'server') return {};
  if (record.type === 'detect' && ['llm', 'cached_llm'].includes(record.probSource)
    && typeof record.inputText === 'string' && record.inputText.trim()
    && sourceScores.optionalScore(record.probability) !== null) {
    return { detectInputHash: sourceScores.inputHash(record.inputText) };
  }
  if (record.type === 'humanize' && typeof record.outputText === 'string'
    && integrity.verify(uid, record.outputText, record, record.historyLinkIntegrity)) {
    return { calibrationTextHash: lookupHash(record.outputText) };
  }
  return {};
}

module.exports = { buildHistoryLookupFields };
