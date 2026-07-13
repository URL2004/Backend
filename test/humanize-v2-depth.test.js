'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const depth = require('../engine-gpt-prod/humanizationDepth');

const SOURCE = [
  '또한 디지털 기술은 현대 사회에서 중요한 역할을 할 수 있습니다.',
  '따라서 이러한 변화는 다양한 측면에서 긍정적인 영향을 줄 수 있습니다.',
  '이를 통해 관련 문제를 체계적으로 개선할 필요가 있습니다.',
  '결론적으로 지속적인 관심과 노력이 중요하다고 볼 수 있습니다.'
].join(' ');

test('구두점·인용부호·안전 축약은 실질 휴머나이징 변화로 계산하지 않는다', () => {
  const source = "또한 이 문제에 대하여 '충분히' 살펴볼 필요가 있으며 관련 내용을 차분하게 확인해야 합니다.";
  const output = '또한, 이 문제에 대해 ‘충분히’ 살펴볼 필요가 있으며 관련 내용을 차분하게 확인해야 합니다.';
  const metrics = depth.measureSubstantiveEdit(source, output);
  assert.equal(metrics.substantiveEditRatio, 0);
  assert.equal(metrics.trivialOnly, true);
  const report = depth.evaluateHumanizationDepth(source, output, {
    requestStrength: 'basic',
    documentProfile: { profile: 'general' }
  });
  assert.equal(report.pass, false);
  assert.ok(report.reasons.includes('punctuation_or_surface_only'));
});

test('장문에서 동의어 한두 개만 바꾼 결과는 기본 피하기 기준을 통과하지 못한다', () => {
  const source = SOURCE.repeat(4);
  const output = source.replace('중요한 역할', '핵심적인 역할').replace('관심과 노력', '관심과 실천');
  const report = depth.evaluateHumanizationDepth(source, output, {
    requestStrength: 'basic',
    documentProfile: { profile: 'general' },
    inputRisk: { abstractRiskRatio: 1 }
  });
  assert.equal(report.pass, false);
  assert.ok(report.metrics.substantiveEditRatio < report.plan.minSubstantiveEditRatio);
});

test('위험 문장의 절·어순·연결·호흡을 폭넓게 바꾼 결과는 통과한다', () => {
  const output = [
    '디지털 기술이 현대 사회에서 맡는 비중은 작지 않습니다.',
    '변화가 긍정적인 결과로 이어질지는 분야와 적용 방식에 따라 달라집니다.',
    '관련 문제를 개선하려면 한 번의 정리보다 실제 운영 과정을 차근차근 살펴야 합니다.',
    '결국 필요한 것은 막연한 관심이 아니라 상황을 계속 확인하며 조정하는 노력입니다.'
  ].join(' ');
  const plan = depth.buildHumanizationPlan(SOURCE, {
    requestStrength: 'basic',
    documentProfile: { profile: 'general' },
    inputRisk: { abstractRiskRatio: 1 }
  });
  const report = depth.evaluateHumanizationDepth(SOURCE, output, plan);
  assert.equal(plan.riskLevel, 'high');
  assert.equal(report.pass, true, JSON.stringify(report));
  assert.ok(report.metrics.substantiveEditRatio >= plan.minSubstantiveEditRatio);
  assert.ok(report.metrics.targetCoverage >= plan.minTargetCoverage);
});

test('저위험 글에는 고위험 글보다 낮은 적응형 기준을 적용하되 3% 다듬기 수준으로 내리지 않는다', () => {
  const low = '수업이 끝났습니다. 친구와 도서관으로 걸어가 빌린 책을 펼쳐 보니 지난주에 연필로 적어 둔 긴 메모와 접어 둔 페이지가 한눈에 들어왔습니다. 빠진 내용은 둘이 소리 내어 확인했습니다. 다음 발표 역할도 나눴습니다.';
  const high = `${SOURCE} ${SOURCE}`;
  const lowPlan = depth.buildHumanizationPlan(low, { requestStrength: 'basic', documentProfile: { profile: 'general' }, inputRisk: { abstractRiskRatio: 0 } });
  const highPlan = depth.buildHumanizationPlan(high, { requestStrength: 'basic', documentProfile: { profile: 'general' }, inputRisk: { abstractRiskRatio: 1 } });
  assert.ok(lowPlan.minSubstantiveEditRatio >= 0.06);
  assert.ok(highPlan.minSubstantiveEditRatio > lowPlan.minSubstantiveEditRatio);
  assert.ok(highPlan.requiredChangedSentenceCount >= lowPlan.requiredChangedSentenceCount);
});

test('사실·형식 민감 장르도 실질 편집률 하한을 6% 아래로 낮추지 않는다', () => {
  const source = '본 보고서는 연구 절차와 관찰 결과를 구분하여 설명합니다. 조사 대상과 분석 범위는 원문에 제시된 기준을 따릅니다. 결론에서는 확인된 내용만 정리합니다.';
  const plan = depth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: 'academic_paper'
  });
  assert.ok(plan.minSubstantiveEditRatio >= 0.06);
});

test('polish는 실질 휴머나이징 깊이 게이트 적용 대상이 아니다', () => {
  const report = depth.evaluateHumanizationDepth(SOURCE, SOURCE, {
    requestStrength: 'polish',
    documentProfile: { profile: 'general' }
  });
  assert.equal(report.applicable, false);
  assert.equal(report.pass, true);
});
