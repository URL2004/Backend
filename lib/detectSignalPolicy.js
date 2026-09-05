'use strict';

const SIGNAL_POLICY_VERSION = 'detect-signal-policy-v2';

function causeScoreAlignmentEnabled(value = process.env.DETECT_CAUSE_SCORE_ALIGNMENT_ENABLED) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

// The detector score is produced by the model, while the five radar axes are
// deterministic surface measurements.  These are related but not identical
// views.  Keep the model's causal evidence in a small, explicit vocabulary so
// a high score can never be presented as if five low radar axes explained it.
const MODEL_SIGNAL_CATEGORIES = Object.freeze([
  'sentence_uniformity',
  'ending_repetition',
  'formulaic_transition',
  'generic_abstraction',
  'insufficient_grounding',
  'overstructured_progression',
  'voice_instability',
  'unsupported_assertion',
  'lexical_template',
  'other_observed_style'
]);

const CATEGORY_SET = new Set(MODEL_SIGNAL_CATEGORIES);
const STRENGTHS = new Set(['weak', 'moderate', 'strong']);
const SCOPES = new Set(['isolated', 'recurring', 'pervasive']);
const CATEGORY_LABELS = Object.freeze({
  sentence_uniformity: '문장 호흡의 균일성',
  ending_repetition: '종결 표현 반복',
  formulaic_transition: '정형적인 연결·결론',
  generic_abstraction: '추상적 일반론',
  insufficient_grounding: '구체 근거 부족',
  overstructured_progression: '지나치게 정돈된 전개',
  voice_instability: '화자·시점 흔들림',
  unsupported_assertion: '근거 없이 강한 단정',
  lexical_template: '상투적인 어휘 조합',
  other_observed_style: '그 밖의 문체 신호',
  legacy_unspecified: '기존 형식의 문체 신호'
});

function compact(value, max = 180) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function safeSignalDescription(category, strength, scope) {
  const strengthLabel = { weak: '약하게', moderate: '뚜렷하게', strong: '강하게' }[strength] || '';
  const scopeLabel = { isolated: '일부 문장에서', recurring: '여러 문장에서', pervasive: '글 전반에서' }[scope] || '';
  return `${CATEGORY_LABELS[category] || CATEGORY_LABELS.other_observed_style} 신호가 ${scopeLabel} ${strengthLabel} 관찰됨`;
}

function normalizeSignalEvidence(value, { allowLegacy = true } = {}) {
  if (!Array.isArray(value)) return [];
  const byCategory = new Map();
  const legacy = [];
  const strengthRank = { weak: 1, moderate: 2, strong: 3 };
  const scopeRank = { isolated: 1, recurring: 2, pervasive: 3 };
  // Prefer recurring/pervasive evidence before raw wording strength.  The old
  // sum produced ties such as strong+isolated vs moderate+recurring, so the
  // selected cause (and therefore the score ceiling) depended on model array
  // order.  A detector contract must be deterministic for identical evidence.
  const evidenceRank = item => {
    const qualifying = ['moderate', 'strong'].includes(item.strength)
      && ['recurring', 'pervasive'].includes(item.scope);
    return (qualifying ? 100 : 0)
      + (scopeRank[item.scope] || 0) * 10
      + (strengthRank[item.strength] || 0);
  };

  for (const item of value) {
    if (typeof item === 'string') {
      const description = compact(item);
      if (!allowLegacy || !description || legacy.some(row => row.description === description)) continue;
      legacy.push({
        category: 'legacy_unspecified',
        categoryLabel: CATEGORY_LABELS.legacy_unspecified,
        strength: 'unknown',
        scope: 'unknown',
        description,
        format: 'legacy'
      });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const category = CATEGORY_SET.has(item.category) ? item.category : '';
    const strength = STRENGTHS.has(item.strength) ? item.strength : '';
    const scope = SCOPES.has(item.scope) ? item.scope : '';
    if (!category || !strength || !scope) continue;
    const normalized = {
      category,
      categoryLabel: CATEGORY_LABELS[category],
      strength,
      scope,
      // Never echo model prose or a source excerpt. User-facing text is derived
      // only from the closed category/strength/scope vocabulary.
      description: safeSignalDescription(category, strength, scope),
      format: 'structured'
    };
    if (Array.isArray(item.locations)) {
      normalized.locations = item.locations;
      normalized.locationStatus = item.locationStatus;
    }
    const previous = byCategory.get(category);
    if (!previous || evidenceRank(normalized) > evidenceRank(previous)) {
      byCategory.set(category, normalized);
    }
  }
  return [...byCategory.values(), ...legacy].slice(0, 8);
}

function publicSignalDescriptions(evidence) {
  // Re-normalize even objects that already look normalized. In particular,
  // never trust a caller/model supplied `description` on a structured item:
  // public copy must always be rebuilt from the closed vocabulary. Legacy
  // strings remain readable for old cache/history rows only.
  const input = Array.isArray(evidence)
    ? evidence.map(item => item?.format === 'legacy' ? item.description : item)
    : evidence;
  const normalized = normalizeSignalEvidence(input).sort(compareCauseEvidence);
  return normalized
    .map(item => item.description)
    .filter(Boolean)
    .slice(0, 5);
}

function isQualifying(item) {
  return item?.format === 'structured'
    && item.category !== 'other_observed_style'
    && ['moderate', 'strong'].includes(item.strength)
    && ['recurring', 'pervasive'].includes(item.scope);
}

function compareCauseEvidence(a, b) {
  const qualifyingDelta = Number(isQualifying(b)) - Number(isQualifying(a));
  if (qualifyingDelta) return qualifyingDelta;
  const scopeRank = { unknown: 0, isolated: 1, recurring: 2, pervasive: 3 };
  const scopeDelta = (scopeRank[b?.scope] || 0) - (scopeRank[a?.scope] || 0);
  if (scopeDelta) return scopeDelta;
  const strengthRank = { unknown: 0, weak: 1, moderate: 2, strong: 3 };
  const strengthDelta = (strengthRank[b?.strength] || 0) - (strengthRank[a?.strength] || 0);
  if (strengthDelta) return strengthDelta;
  const categoryA = String(a?.category || '');
  const categoryB = String(b?.category || '');
  return categoryA < categoryB ? -1 : categoryA > categoryB ? 1 : 0;
}

function coverageRequirement(score) {
  if (score >= 75) return { independent: 3, strongOrPervasive: 2 };
  // Two independent recurring moderate signals are sufficient for the middle
  // band.  Requiring an additional strong/pervasive signal here would disagree
  // with the model prompt and push otherwise valid 50-74 results to exactly 49.
  if (score >= 50) return { independent: 2, strongOrPervasive: 0 };
  if (score >= 21) return { independent: 1, strongOrPervasive: 0 };
  return { independent: 0, strongOrPervasive: 0 };
}

function supportedScoreCeiling(evidenceValue) {
  const evidence = normalizeSignalEvidence(evidenceValue);
  const qualifying = evidence.filter(isQualifying);
  const strongOrPervasive = qualifying.filter(item => item.strength === 'strong' || item.scope === 'pervasive');
  if (qualifying.length >= 3 && strongOrPervasive.length >= 2) return 100;
  if (qualifying.length >= 2) return 74;
  if (qualifying.length >= 1) return 49;
  return 20;
}

// Conservative score/evidence contract: explicit causes may lower an
// unsupported model score, but they never raise it.  This prevents a model
// from returning 80 while only naming one weak or isolated feature.
function alignScoreToCauseEvidence(result = {}) {
  const probability = Number(result.probability);
  const evidence = normalizeSignalEvidence(result.signalEvidence);
  const structuredContract = ['model-signals-v1', 'model-signals-v2-grounded'].includes(result.signalContractVersion)
    || evidence.some(item => item.format === 'structured');
  if (!Number.isFinite(probability) || !structuredContract || !causeScoreAlignmentEnabled()) return result;
  const ceiling = supportedScoreCeiling(evidence);
  const aligned = Math.max(0, Math.min(100, Math.round(Math.min(probability, ceiling))));
  return {
    ...result,
    probability: aligned,
    modelProbability: Math.max(0, Math.min(100, Math.round(probability))),
    causeScoreAdjusted: aligned < probability,
    causeScoreCeiling: ceiling,
    causeScoreAdjustmentCode: aligned < probability ? 'score_capped_by_cause_evidence' : null
  };
}

function assessCauseCoverage(scoreValue, evidenceValue, { source = 'llm', calibrated = false } = {}) {
  const score = Number(scoreValue);
  const evidence = normalizeSignalEvidence(evidenceValue);
  const requirement = coverageRequirement(Number.isFinite(score) ? score : -1);
  const qualifying = evidence.filter(isQualifying);
  const strongOrPervasive = qualifying.filter(item => item.strength === 'strong' || item.scope === 'pervasive');
  const structured = evidence.filter(item => item.format === 'structured');
  const legacyOnly = evidence.length > 0 && structured.length === 0;
  const codes = [];

  if (!Number.isFinite(score) || source !== 'llm') {
    codes.push(source !== 'llm' ? 'authoritative_score_unavailable' : 'score_unavailable');
  } else if (score <= 20 && qualifying.length > 0 && calibrated !== true) {
    // The reverse mismatch is confusing as well: a low uncalibrated score
    // must not sit beside a strong recurring cause as if both used one scale.
    codes.push('cause_strength_above_score_band');
  } else if (requirement.independent > 0) {
    if (legacyOnly) codes.push('legacy_cause_format');
    if (qualifying.length < requirement.independent) codes.push('cause_count_below_score_band');
    if (strongOrPervasive.length < requirement.strongOrPervasive) codes.push('cause_strength_below_score_band');
  }

  const status = !Number.isFinite(score) || source !== 'llm'
    ? 'limited'
    : codes.length
      ? 'partial'
      : 'aligned';
  const required = requirement.independent;
  const covered = Math.min(required, qualifying.length);
  return {
    version: 'cause-coverage-v1',
    status,
    label: status === 'aligned'
      ? '점수와 원인 설명이 맞게 연결됐어요.'
      : status === 'partial'
        ? '점수에 비해 확인된 원인 설명이 충분하지 않아요.'
        : '점수 원인을 충분히 연결하지 못했어요.',
    coverage: required === 0 ? 1 : Number((covered / required).toFixed(3)),
    requiredIndependentSignals: required,
    qualifyingIndependentSignals: qualifying.length,
    codes,
    items: [...evidence].sort(compareCauseEvidence)
  };
}

module.exports = {
  SIGNAL_POLICY_VERSION,
  CATEGORY_LABELS,
  MODEL_SIGNAL_CATEGORIES,
  alignScoreToCauseEvidence,
  causeScoreAlignmentEnabled,
  assessCauseCoverage,
  compareCauseEvidence,
  coverageRequirement,
  normalizeSignalEvidence,
  publicSignalDescriptions,
  safeSignalDescription,
  supportedScoreCeiling
};
