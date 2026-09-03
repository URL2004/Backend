'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  riskBand,
  narrativeContradictsRisk,
  applyDetectNarrativePolicy
} = require('../lib/detectNarrativePolicy');

test('1% 결과에 AI 작성 가능성이 높다는 설명을 노출하지 않는다', () => {
  const result = applyDetectNarrativePolicy({
    probability: 1,
    summary: '계획서형 문장으로 매우 정돈되어 있고, 미래지향적 목표와 자금 배분이 반복적으로 제시되어 AI 생성/보조 작성 가능성이 높습니다.',
    detail: '구체적인 정보와 정돈된 구성이 관찰됩니다.',
    signals: ['계획서형 문장으로 매우 정돈됨', '미래지향적 목표와 자금 배분이 반복됨']
  });

  assert.equal(result.probability, 1);
  assert.equal(result.riskLevel, 'low');
  assert.equal(result.riskLabel, 'AI식 문체 신호 · 낮음');
  assert.match(result.summary, /낮게 관찰/);
  assert.match(result.detail, /문체 신호 1\/100/);
  assert.equal(narrativeContradictsRisk(`${result.summary}\n${result.detail}`, 'low'), false);
  assert.equal(result.narrativeConsistencyAdjusted, true);
});

test('최종 보정 점수를 기준으로 위험 문구를 다시 맞춘다', () => {
  const result = applyDetectNarrativePolicy({
    probability: 78,
    summary: 'AI 작성 가능성이 높습니다.',
    detail: 'AI 생성 가능성이 매우 높습니다.',
    signals: ['균일한 문장 길이', 'AI 작성 가능성이 높음']
  }, 12);

  assert.equal(result.probability, 12);
  assert.equal(result.riskLevel, 'low');
  assert.match(result.detail, /균일한 문장 길이/);
  assert.doesNotMatch(result.detail, /가능성이 (?:매우 )?높/);
});

test('중간 구간은 높음이나 낮음으로 단정하지 않는다', () => {
  const result = applyDetectNarrativePolicy({
    probability: 35,
    summary: '사람이 직접 쓴 글로 보입니다.',
    detail: 'AI 흔적이 거의 없습니다.',
    signals: []
  });

  assert.equal(result.riskLevel, 'moderate');
  assert.match(result.summary, /일부 관찰/);
  assert.equal(narrativeContradictsRisk(`${result.summary}\n${result.detail}`, 'moderate'), false);
});

test('위험 구간 경계는 모든 감지 화면에서 재사용할 수 있다', () => {
  assert.equal(riskBand(20).level, 'low');
  assert.equal(riskBand(21).level, 'moderate');
  assert.equal(riskBand(49).level, 'moderate');
  assert.equal(riskBand(50).level, 'high');
});

test('구조화 원인 설명도 작성 주체 단정 문구는 공개 응답에서 제거한다', () => {
  const result = applyDetectNarrativePolicy({
    probability: 70,
    signalEvidence: [
      { category: 'sentence_uniformity', strength: 'strong', scope: 'recurring', description: '비슷한 문장 호흡이 반복됨' },
      { category: 'lexical_template', strength: 'strong', scope: 'pervasive', description: 'AI가 작성한 글일 가능성이 매우 높음' }
    ]
  });
  assert.equal(result.signals.length, 2, '자유 서술 대신 닫힌 category로 안전한 설명을 다시 만든다');
  assert.equal(result.signalEvidence.length, 2);
  assert.equal(result.signalEvidence[0].category, 'sentence_uniformity');
  assert.doesNotMatch(result.signals.join(' '), /AI가 작성|가능성이 매우 높/u);
  assert.doesNotMatch(result.detail, /가능성이 매우 높/u);
});
