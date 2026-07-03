'use strict';

const DEFAULT_POLICY = Object.freeze({
  operation: 'humanize_only',
  ignoreUserInstructions: true,
  temperature: 0.25,
  maxOutputTokensMultiplier: 1.45,

  minimalPreserveThreshold: 0.08,
  lowRiskThreshold: 0.12,

  targetRiskDrop: 0.045,
  highRiskThreshold: 0.58,

  length: {
    fullMaxChars: 4200,
    blockLockedMaxChars: 10000,
    blockLockedMaxBlocks: 90,
    patchMaxTargets: 70,
    patchTargetRatio: 0.58,
    patchMinBlockChars: 55,
    patchMinBlockRisk: 0.36,
    patchContextChars: 160
  },

  effectiveChange: {
    minChangedSentenceRatio: 0.46,
    minChangedParagraphRatio: 0.50,
    minCharShingleChange: 0.20,
    maxExactSentenceCarryoverRatio: 0.62,
    maxLengthRatio: 1.18,
    minLengthRatio: 0.88
  },

  regression: {
    maxRiskIncrease: 0.005,
    maxRhetoricalIncrease: 0.012,
    maxClaimStrengthIncrease: 0.010,
    maxFormulaicIncrease: 0.018,
    maxAbstractIncrease: 0.020,
    maxUniformityIncrease: 0.030,
    maxNewNounPhraseRatio: 0.22
  },

  grammar: {
    orphanConnectiveHardFail: true,
    maxConsecutiveSameEnding: 3
  },

  prompt: {
    forbidExpansion: true,
    forbidSummary: true,
    forbidRhetoricalPolish: true,
    forbidNewFacts: true,
    preserveSpeaker: true
  }
});

function mergePolicy(overrides = {}) {
  return deepMerge(DEFAULT_POLICY, overrides || {});
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { DEFAULT_POLICY, mergePolicy };
