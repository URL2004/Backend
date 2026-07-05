'use strict';

const { DEFAULT_THRESHOLDS } = require('./patterns');
const { analyzeText } = require('./detector');
const { buildPromptHints, compactForLog } = require('./promptBlock');
const { evaluateKoreanQuality } = require('./gate');
const niklTest = require('./niklTest');
const officialResources = require('./officialResources');
const officialApi = require('./officialApi');
const qualityPatternLab = require('./qualityPatternLab');

module.exports = {
  DEFAULT_THRESHOLDS,
  analyzeText,
  buildPromptHints,
  compactForLog,
  evaluateKoreanQuality,
  niklTest,
  officialResources,
  officialApi,
  qualityPatternLab
};
