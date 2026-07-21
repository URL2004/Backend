'use strict';

const { DEFAULT_THRESHOLDS } = require('./patterns');
const { analyzeText } = require('./detector');
const { buildPromptHints, compactForLog } = require('./promptBlock');
const { evaluateKoreanQuality } = require('./gate');
const niklTest = require('./niklTest');
const officialResources = require('./officialResources');
const qualityPatternLab = require('./qualityPatternLab');

const api = {
  DEFAULT_THRESHOLDS,
  analyzeText,
  buildPromptHints,
  compactForLog,
  evaluateKoreanQuality,
  niklTest,
  officialResources,
  qualityPatternLab
};

// External NIKL clients stay out of the startup and normal transform graph.
// The production engine reads this getter only behind GPT_NIKL_EXTERNAL_API_ENABLED=1.
Object.defineProperty(api, 'officialApi', {
  enumerable: true,
  configurable: false,
  get() {
    return require('./officialApi');
  }
});

module.exports = api;
