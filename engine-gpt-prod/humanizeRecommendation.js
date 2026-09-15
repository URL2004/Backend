'use strict';

const { splitChunksForGpt } = require('./structureChunk');
const { shouldCallModel } = require('./chunkPolicy');
const { buildHumanizationPlan, classifyEffectExpectation } = require('./humanizationDepth');
const { shortHumanizeCredit, restructureBaseCredit } = require('../lib/humanizePricing');

const RECOMMENDATION_VERSION = 'humanize-recommendation-v2';
const BROAD_REWRITE_PROFILES = new Set([
  'academic_paper', 'report_assignment', 'long_explainer', 'general', 'review_blog', 'marketing'
]);

function buildRecommendationSignals(source, documentProfile, inputRisk) {
  // Use the engine's editable chunks: quoted/reference/table volume must not
  // turn a short editable passage into a long-document upsell.
  const chunks = splitChunksForGpt(source, { formatProfile: documentProfile.formatProfile }).chunks;
  const editable = chunks.map(chunk => (shouldCallModel(chunk, 'blog') ? chunk.text : '') + (chunk.sep || ''))
    .join('').split('\n')
    // Delimited rows without outer pipes are not always locked by the chunker.
    // Conservatively exclude them from recommendation volume as well.
    .map(line => (line.match(/\|/gu) || []).length >= 2 || /\t/u.test(line) ? '' : line)
    .join('\n').trim();
  const plan = buildHumanizationPlan(editable, { requestStrength: 'basic', documentProfile, inputRisk });
  const sourceSentenceCount = Number(plan.sourceSentenceCount || 0);
  return {
    sourceLength: source.length,
    editableLength: editable.length,
    sourceSentenceCount,
    targetSentenceCount: Number(plan.targetSentenceCount || 0),
    targetSentenceRatio: sourceSentenceCount
      ? Number((Number(plan.targetSentenceCount || 0) / sourceSentenceCount).toFixed(4)) : 0,
    targetParagraphCount: Number(plan.targetParagraphCount || 0),
    riskLevel: plan.riskLevel,
    effectExpectation: classifyEffectExpectation(plan).effectExpectation,
    additionalCredits: restructureBaseCredit(source.length) - shortHumanizeCredit(source.length)
  };
}

function selectRecommendation({ advancedEligible, profile, confidence, personalSafety, academicStructure, signals }) {
  const choice = (recommendedMode, recommendationCode, recommendationReason) => ({
    recommendedMode, recommendationCode, recommendationReason,
    recommendationVersion: RECOMMENDATION_VERSION,
    recommendationSignals: signals
  });
  if (!advancedEligible) return choice(null, 'advanced_unavailable', '이 입력은 고급 휴머나이징 지원 대상이 아니에요.');
  if (signals.editableLength < 120 || signals.sourceSentenceCount < 2) {
    return choice('blog', 'little_editable_content', '바꿀 수 있는 본문이 적어 기본을 권해요. 표·인용 등 보호 대상은 그대로 유지해요.');
  }
  if (signals.effectExpectation === 'limited') {
    return choice('blog', 'limited_rewrite_benefit', '다시 쓸 필요가 있는 문장이 적어 기본을 권해요. 맞춤법·연결만 고치려면 원문 보존 다듬기도 살펴보세요.');
  }
  if (profile === 'unknown' || confidence < 0.55) {
    return choice(null, 'uncertain_document_profile', '글의 성격을 확실히 판단하기 어려워요. 기본으로 시작하거나, 더 넓게 다시 쓰고 싶다면 고급을 선택해 주세요.');
  }
  if (personalSafety) {
    return choice('blog', 'personal_voice_preservation', '경험·화자·말투 보존이 중요한 글이라 기본을 권해요. 여러 문단을 더 넓게 다시 쓰고 싶다면 고급도 선택할 수 있어요.');
  }
  if (academicStructure) {
    return choice('formal', 'complex_academic_document', '논문·보고서의 구조가 확인됐어요. 더 넓은 문장 범위를 재구성하고 전체 문서를 검증하는 고급을 권해요.');
  }
  const enoughBody = signals.sourceLength >= 2000 && signals.editableLength >= 1200
    && signals.sourceSentenceCount >= 6;
  // General prose does not need a high-confidence academic genre to show a
  // strong, distributed rewrite need. Use the classifier's accepted-profile
  // floor for these non-sensitive genres; retain 0.75 for academic/explainer.
  const trusted = BROAD_REWRITE_PROFILES.has(profile)
    && confidence >= (['general', 'review_blog', 'marketing'].includes(profile) ? 0.55 : 0.75);
  if (trusted && enoughBody && profile === 'long_explainer'
      && signals.riskLevel !== 'low' && signals.targetSentenceCount >= 3 && signals.targetSentenceRatio >= 0.25) {
    return choice('formal', 'long_explainer_rewrite', '설명이 길고 다시 쓸 대상 문장이 여러 곳에 있어요. 더 넓은 범위를 재구성하는 고급을 권해요.');
  }
  const distributed = signals.targetParagraphCount >= 2;
  const widespread = signals.riskLevel === 'high'
    && signals.targetSentenceCount >= 6 && signals.targetSentenceRatio >= 0.5;
  const smallPriceGap = signals.sourceLength >= 5000 && signals.additionalCredits <= 30
    && signals.riskLevel !== 'low' && signals.targetSentenceCount >= 4 && signals.targetSentenceRatio >= 0.25;
  if (trusted && enoughBody && distributed && (widespread || smallPriceGap)) {
    return choice('formal', smallPriceGap ? 'long_document_value' : 'widespread_rewrite', smallPriceGap
      ? '여러 문단에 다시 쓸 부분이 있고 기본과의 비용 차이도 작아요. 처리 시간을 확인한 뒤 고급을 선택해 보세요.'
      : '반복·상투적인 흐름이 여러 문단에 걸쳐 있어요. 문장 전반을 더 넓게 재구성하는 고급을 권해요.');
  }
  return choice('blog', 'focused_rewrite', '문제 표현을 중심으로 다시 쓰는 기본을 권해요. 더 넓은 재구성을 원하면 고급도 선택할 수 있어요.');
}

module.exports = { RECOMMENDATION_VERSION, buildRecommendationSignals, selectRecommendation };
