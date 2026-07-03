const DEFAULT_POLICY = Object.freeze({
  version: 'v7-effective-policy-locked',
  operation: 'humanize_only',
  ignoreUserInstructions: true,
  profileMode: 'auto',

  // V7 deliberately avoids over-preserving. Only very safe texts are left nearly untouched.
  strength: 'effective',
  allowFallbackToOriginal: true,
  hardFailOnProtectedTermLoss: true,
  hardFailOnStructureLoss: true,

  // Local surrogate-risk targets. These do not guarantee any external detector result,
  // but they prevent “same-looking” outputs from being treated as success.
  targetRiskDrop: 0.055,
  highRiskThreshold: 0.58,
  lowRiskThreshold: 0.18,
  minimalPreserveThreshold: 0.16,

  // Keep the same assignment/content scope: humanize, not expand or summarize.
  maxLengthRatio: 1.14,
  minLengthRatio: 0.88,
  minContentOverlap: 0.58,
  maxParagraphShrinkRatio: 0.78,
  maxFormulaicIncrease: 0.018,
  maxRepetitionIncrease: 0.014,
  patchModeTargetRiskDrop: 0.024,

  // New: minimum effective transformation floor.
  // Too little change is a soft failure: return the text, but mark limited_effect.
  effectiveChange: {
    enabled: true,
    minCharShingleChange: {
      low: 0.055,
      lowMedium: 0.085,
      medium: 0.125,
      high: 0.155
    },
    minChangedSentenceRatio: {
      low: 0.12,
      lowMedium: 0.22,
      medium: 0.32,
      high: 0.42
    },
    minChangedParagraphRatio: {
      low: 0.10,
      lowMedium: 0.22,
      medium: 0.34,
      high: 0.46
    },
    maxCharShingleChange: 0.52,
    maxChangedSentenceRatio: 0.82,
    sentenceSimilarityThreshold: 0.88,
    paragraphSimilarityThreshold: 0.86
  },

  weights: {
    abstractness: 1.02,
    formulaic: 1.32,
    repetition: 1.20,
    uniformity: 1.20,
    impersonal: 0.84,
    transitionOveruse: 0.68,
    compression: 0.82,
    anchorDeficit: 0.92,
    overFormal: 0.55,
    overColloquial: 0.38
  },

  prompt: {
    language: 'ko',
    returnJson: true,
    maxProtectedTermsInPrompt: 90,
    maxDiagnosticsChars: 2200
  },

  longDocument: {
    enabled: true,
    fullMaxChars: 4200,
    blockLockedMaxChars: 10000,
    blockLockedMaxBlocks: 90,
    patchMaxTargets: 60,
    patchTargetRatio: 0.55,
    patchMinBlockChars: 55,
    patchMinBlockRisk: 0.34,
    patchPromptMaxTargets: 60,
    contextChars: 180,
    minPatchCoverageForHighRisk: 0.42
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
    },
    effectiveChange: {
      ...DEFAULT_POLICY.effectiveChange,
      ...(overrides.effectiveChange || {}),
      minCharShingleChange: {
        ...DEFAULT_POLICY.effectiveChange.minCharShingleChange,
        ...((overrides.effectiveChange || {}).minCharShingleChange || {})
      },
      minChangedSentenceRatio: {
        ...DEFAULT_POLICY.effectiveChange.minChangedSentenceRatio,
        ...((overrides.effectiveChange || {}).minChangedSentenceRatio || {})
      },
      minChangedParagraphRatio: {
        ...DEFAULT_POLICY.effectiveChange.minChangedParagraphRatio,
        ...((overrides.effectiveChange || {}).minChangedParagraphRatio || {})
      }
    }
  };
  merged.operation = 'humanize_only';
  merged.ignoreUserInstructions = true;
  return merged;
}

module.exports = { DEFAULT_POLICY, mergePolicy };
