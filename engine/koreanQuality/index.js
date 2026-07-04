'use strict';

const { DEFAULT_THRESHOLDS } = require('./patterns');
const { analyzeText } = require('./detector');
const { buildPromptHints, compactForLog } = require('./promptBlock');
const { evaluateKoreanQuality } = require('./gate');
const niklTest = require('./niklTest');

module.exports = {
  DEFAULT_THRESHOLDS,
  analyzeText,
  buildPromptHints,
  compactForLog,
  evaluateKoreanQuality,
  niklTest
};
