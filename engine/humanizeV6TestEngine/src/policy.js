const DEFAULT_POLICY = Object.freeze({
  version: 'v6-longdoc-policy-locked',
  operation: 'humanize_only',
  ignoreUserInstructions: true,
  profileMode: 'auto',
  strength: 'balanced',
  allowFallbackToOriginal: true,
  hardFailOnProtectedTermLoss: true,
  hardFailOnStructureLoss: true,
  targetRiskDrop: 0.035,
  highRiskThreshold: 0.62,
  lowRiskThreshold: 0.28,
  maxLengthRatio: 1.18,
  minLengthRatio: 0.84,
  minContentOverlap: 0.58,
  maxParagraphShrinkRatio: 0.72,
  maxFormulaicIncrease: 0.025,
  maxRepetitionIncrease: 0.018,
  patchModeTargetRiskDrop: 0.012,
  weights: {
    abstractness: 1.00,
    formulaic: 1.18,
    repetition: 1.10,
    uniformity: 1.08,
    impersonal: 0.78,
    transitionOveruse: 0.60,
    compression: 0.72,
    anchorDeficit: 0.90,
    overFormal: 0.48,
    overColloquial: 0.32
  },
  prompt: {
    language: 'ko',
    returnJson: true,
    maxProtectedTermsInPrompt: 80,
    maxDiagnosticsChars: 1800
  },
  longDocument: {
    enabled: true,
    fullMaxChars: 4200,
    blockLockedMaxChars: 10000,
    blockLockedMaxBlocks: 90,
    patchMaxTargets: 28,
    patchTargetRatio: 0.34,
    patchMinBlockChars: 70,
    patchMinBlockRisk: 0.43,
    patchPromptMaxTargets: 28,
    contextChars: 160
  }
});

function mergePolicy(overrides = {}) {
  const merged = {
    ...DEFAULT_POLICY,
    ...overrides,
    weights: {
      ...DEFAULT_POLICY.weights,
      ...(overrides.weights || {})
    },
    prompt: {
      ...DEFAULT_POLICY.prompt,
      ...(overrides.prompt || {})
    },
    longDocument: {
      ...DEFAULT_POLICY.longDocument,
      ...(overrides.longDocument || {})
    }
  };
  merged.operation = 'humanize_only';
  merged.ignoreUserInstructions = true;
  return merged;
}

module.exports = { DEFAULT_POLICY, mergePolicy };
