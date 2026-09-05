'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignScoreToCauseEvidence,
  assessCauseCoverage,
  causeScoreAlignmentEnabled,
  normalizeSignalEvidence,
  supportedScoreCeiling
} = require('../lib/detectSignalPolicy');

test('원인-점수 정렬은 기본 활성이고 운영에서 즉시 끌 수 있다', () => {
  assert.equal(causeScoreAlignmentEnabled(undefined), true);
  assert.equal(causeScoreAlignmentEnabled('1'), true);
  assert.equal(causeScoreAlignmentEnabled('0'), false);
});

const recurring = (category, strength = 'moderate', scope = 'recurring') => ({
  category,
  strength,
  scope,
  description: `${category} 문체 특징이 여러 문장에서 반복됨`
});

test('grounded v2의 빈 근거도 현재 계약으로 해석하고 낮은 원점수를 메타데이터에 남긴다', () => {
  const result = alignScoreToCauseEvidence({ probability: 6, signalContractVersion: 'model-signals-v2-grounded', signalEvidence: [] });
  assert.equal(result.probability, 6);
  assert.equal(result.modelProbability, 6);
  assert.equal(result.causeScoreAdjusted, false);
  assert.equal(alignScoreToCauseEvidence({ probability: 82, signalContractVersion: 'model-signals-v2-grounded', signalEvidence: [] }).probability, 20);
});

test('고득점은 독립적인 구조화 원인 수·강도보다 높게 유지되지 않는다', () => {
  const none = alignScoreToCauseEvidence({ probability: 82, signalEvidence: [] });
  assert.equal(none.probability, 82, '구형 결과는 근거를 지어내거나 소급 변경하지 않는다');

  const currentNone = alignScoreToCauseEvidence({
    probability: 82,
    signalEvidence: [],
    signalContractVersion: 'model-signals-v1'
  });
  assert.equal(currentNone.probability, 20, '신형 모델이 원인 없이 낸 고득점은 낮은 구간 상한으로 제한한다');

  const one = alignScoreToCauseEvidence({
    probability: 82,
    signalEvidence: [recurring('sentence_uniformity')]
  });
  assert.equal(one.probability, 49);
  assert.equal(one.modelProbability, 82);
  assert.equal(one.causeScoreAdjusted, true);

  const two = alignScoreToCauseEvidence({
    probability: 82,
    signalEvidence: [
      recurring('sentence_uniformity', 'strong'),
      recurring('formulaic_transition')
    ]
  });
  assert.equal(two.probability, 74);

  const twoModerate = alignScoreToCauseEvidence({
    probability: 72,
    signalEvidence: [
      recurring('sentence_uniformity'),
      recurring('formulaic_transition')
    ]
  });
  assert.equal(twoModerate.probability, 72, '중간 강도 반복 원인 2개는 50~74점 계약을 충족한다');
  assert.equal(assessCauseCoverage(72, twoModerate.signalEvidence).status, 'aligned');

  const three = alignScoreToCauseEvidence({
    probability: 82,
    signalEvidence: [
      recurring('sentence_uniformity', 'strong'),
      recurring('formulaic_transition', 'strong'),
      recurring('generic_abstraction')
    ]
  });
  assert.equal(three.probability, 82);
  assert.equal(three.causeScoreAdjusted, false);
});

test('근거 계약은 점수를 올리지 않고 약함·고립 신호를 고득점 근거로 세지 않는다', () => {
  const evidence = normalizeSignalEvidence([
    recurring('generic_abstraction', 'weak', 'isolated'),
    recurring('sentence_uniformity', 'moderate', 'recurring')
  ]);
  assert.equal(supportedScoreCeiling(evidence), 49);
  assert.equal(alignScoreToCauseEvidence({ probability: 12, signalEvidence: evidence }).probability, 12);
  const coverage = assessCauseCoverage(72, evidence);
  assert.equal(coverage.status, 'partial');
  assert.deepEqual(coverage.codes, ['cause_count_below_score_band']);
});

test('혼합 점수 구간은 적격 중간 강도 반복 신호가 있어야만 유지된다', () => {
  for (const probability of [21, 49]) {
    const aligned = alignScoreToCauseEvidence({
      probability,
      signalEvidence: [recurring('sentence_uniformity', 'moderate', 'recurring')]
    });
    assert.equal(aligned.probability, probability);
    assert.equal(aligned.causeScoreAdjusted, false);
  }

  const weak = alignScoreToCauseEvidence({
    probability: 35,
    signalEvidence: [recurring('sentence_uniformity', 'weak', 'recurring')]
  });
  assert.equal(weak.probability, 20, '약한 반복 신호는 21~49점의 근거가 아니다');

  const other = alignScoreToCauseEvidence({
    probability: 35,
    signalEvidence: [recurring('other_observed_style', 'moderate', 'recurring')]
  });
  assert.equal(other.probability, 20, '기타 문체 신호는 강도·범위와 무관하게 20점을 넘길 수 없다');
});

test('공개 원인 항목은 원문 인용 없이 정해진 필드만 정규화한다', () => {
  const evidence = normalizeSignalEvidence([
    { ...recurring('ending_repetition'), unexpected: 'drop me' },
    recurring('ending_repetition', 'strong', 'pervasive'),
    { category: 'invented', strength: 'strong', scope: 'pervasive', description: '무효' }
  ]);
  assert.equal(evidence.length, 1);
  assert.deepEqual(Object.keys(evidence[0]).sort(), ['category', 'categoryLabel', 'description', 'format', 'scope', 'strength']);
  assert.equal(evidence[0].strength, 'strong', '같은 category는 더 강한 한 건만 남긴다');
});

test('같은 범주의 상충 근거는 배열 순서와 무관하게 반복 범위를 우선한다', () => {
  const isolatedStrong = recurring('sentence_uniformity', 'strong', 'isolated');
  const recurringModerate = recurring('sentence_uniformity', 'moderate', 'recurring');
  const forward = normalizeSignalEvidence([isolatedStrong, recurringModerate]);
  const reverse = normalizeSignalEvidence([recurringModerate, isolatedStrong]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].strength, 'moderate');
  assert.equal(forward[0].scope, 'recurring');
  assert.equal(supportedScoreCeiling(forward), 49);
});

test('낮은 원점수 옆에 강한 반복 원인이 있으면 역방향 불일치로 표시한다', () => {
  const evidence = [recurring('formulaic_transition', 'strong', 'pervasive')];
  assert.deepEqual(assessCauseCoverage(12, evidence).codes, ['cause_strength_above_score_band']);
  assert.equal(assessCauseCoverage(12, evidence).status, 'partial');
  assert.equal(assessCauseCoverage(12, evidence, { calibrated: true }).status, 'aligned');
});

test('모호한 기타 문체 신호는 고득점을 지지하는 독립 원인으로 세지 않는다', () => {
  const vague = [recurring('other_observed_style', 'strong', 'pervasive')];
  assert.equal(supportedScoreCeiling(vague), 20);
  assert.equal(alignScoreToCauseEvidence({ probability: 88, signalEvidence: vague }).probability, 20);
});

test('원인 항목은 점수 근거 적격 여부, 범위, 강도 순으로 정렬한다', () => {
  const coverage = assessCauseCoverage(72, [
    recurring('lexical_template', 'weak', 'pervasive'),
    recurring('generic_abstraction', 'moderate', 'recurring'),
    recurring('ending_repetition', 'strong', 'recurring'),
    recurring('formulaic_transition', 'strong', 'pervasive'),
    recurring('voice_instability', 'strong', 'isolated')
  ]);
  assert.deepEqual(coverage.items.map(item => item.category), [
    'formulaic_transition',
    'ending_repetition',
    'generic_abstraction',
    'lexical_template',
    'voice_instability'
  ]);
});
