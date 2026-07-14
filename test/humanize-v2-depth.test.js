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
  assert.equal(report.minimumEffectPass, false);
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

test('기본 피하기는 저위험 8%·고위험 13% 최소선과 별도 목표 범위를 적용한다', () => {
  const low = '수업이 끝났습니다. 친구와 도서관으로 걸어가 빌린 책을 펼쳐 보니 지난주에 연필로 적어 둔 긴 메모와 접어 둔 페이지가 한눈에 들어왔습니다. 빠진 내용은 둘이 소리 내어 확인했습니다. 다음 발표 역할도 나눴습니다.';
  const high = `${SOURCE} ${SOURCE}`;
  const lowPlan = depth.buildHumanizationPlan(low, { requestStrength: 'basic', documentProfile: { profile: 'general' }, inputRisk: { abstractRiskRatio: 0 } });
  const highPlan = depth.buildHumanizationPlan(high, { requestStrength: 'basic', documentProfile: { profile: 'general' }, inputRisk: { abstractRiskRatio: 1 } });
  assert.equal(lowPlan.policyVersion, 'perceived-v2.1');
  assert.ok(lowPlan.minSubstantiveEditRatio >= 0.08);
  assert.equal(highPlan.riskLevel, 'high');
  assert.equal(highPlan.minSubstantiveEditRatio, 0.13);
  assert.equal(highPlan.targetSubstantiveEditMin, 0.15);
  assert.equal(highPlan.targetSubstantiveEditMax, 0.19);
  assert.ok(highPlan.requiredChangedSentenceCount >= lowPlan.requiredChangedSentenceCount);
});

test('고급 피하기는 같은 글에서도 기본보다 편집·문장·위험대상 최소선이 높다', () => {
  const source = `${SOURCE} ${SOURCE}`;
  const basic = depth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: 'long_explainer',
    inputRisk: { abstractRiskRatio: 1 }
  });
  const advanced = depth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: 'long_explainer',
    inputRisk: { abstractRiskRatio: 1 }
  });
  assert.equal(basic.minSubstantiveEditRatio, 0.13);
  assert.equal(advanced.minSubstantiveEditRatio, 0.17);
  assert.equal(advanced.targetSubstantiveEditMin, 0.20);
  assert.equal(advanced.targetSubstantiveEditMax, 0.23);
  assert.ok(advanced.requiredChangedSentenceCount > basic.requiredChangedSentenceCount);
  assert.ok(advanced.requiredTargetChangedCount >= basic.requiredTargetChangedCount);
});

test('사실·형식 민감 장르는 2%p 완화하되 기본 6%·고급 9% 바닥을 지킨다', () => {
  const source = `${SOURCE} ${SOURCE}`;
  const basic = depth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: 'academic_paper',
    inputRisk: { abstractRiskRatio: 1 }
  });
  const advanced = depth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: 'academic_paper',
    inputRisk: { abstractRiskRatio: 1 }
  });
  assert.equal(basic.minSubstantiveEditRatio, 0.11);
  assert.equal(advanced.minSubstantiveEditRatio, 0.15);
  assert.ok(basic.minSubstantiveEditRatio >= 0.06);
  assert.ok(advanced.minSubstantiveEditRatio >= 0.09);
});

test('120자 이하 일반 글도 기본 9%·고급 12% 품질 최소선을 목표로 한다', () => {
  const source = '오늘 수업에서 친구와 발표 자료를 함께 확인했습니다. 빠진 부분은 둘이 다시 읽었습니다.';
  const basic = depth.buildHumanizationPlan(source, { requestStrength: 'basic', documentProfile: 'general_essay' });
  const advanced = depth.buildHumanizationPlan(source, { requestStrength: 'advanced', documentProfile: 'general_essay' });
  assert.equal(basic.minSubstantiveEditRatio, 0.09);
  assert.equal(basic.targetSubstantiveEditMin, 0.11);
  assert.equal(advanced.minSubstantiveEditRatio, 0.12);
  assert.equal(advanced.targetSubstantiveEditMin, 0.14);
  assert.equal(basic.requiredChangedSentenceCount, 1);
  assert.equal(advanced.requiredChangedSentenceCount, 1);
});

test('창작문은 기본·고급 모두 행 구조를 보호하는 독립 강도 정책을 쓴다', () => {
  const source = `${SOURCE}\n${SOURCE}`;
  const basic = depth.buildHumanizationPlan(source, { requestStrength: 'basic', documentProfile: 'creative', inputRisk: { abstractRiskRatio: 1 } });
  const advanced = depth.buildHumanizationPlan(source, { requestStrength: 'advanced', documentProfile: 'creative', inputRisk: { abstractRiskRatio: 1 } });
  assert.equal(basic.creative, true);
  assert.equal(basic.minSubstantiveEditRatio, 0.075);
  assert.equal(basic.targetSubstantiveEditMin, 0.09);
  assert.equal(basic.targetSubstantiveEditMax, 0.13);
  assert.equal(advanced.minSubstantiveEditRatio, basic.minSubstantiveEditRatio);
  assert.equal(advanced.minChangedSentenceRatio, basic.minChangedSentenceRatio);
});

test('최소선 통과와 목표 범위 도달을 별도 관측값으로 구분한다', () => {
  const source = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허.';
  const minimumOutput = '가나다라마바사아자차카타파하고노도로머버서어저처커터퍼허.';
  const plan = {
    version: 3,
    policyVersion: 'perceived-v2.1',
    applicable: true,
    requestStrength: 'basic',
    targetIndices: [],
    targetSentenceCount: 0,
    requiredTargetChangedCount: 0,
    requiredChangedSentenceCount: 1,
    minSubstantiveEditRatio: 0.05,
    targetSubstantiveEditMin: 0.15,
    targetSubstantiveEditMax: 0.25
  };
  const report = depth.evaluateHumanizationDepth(source, minimumOutput, plan);
  assert.equal(report.pass, true, JSON.stringify(report));
  assert.equal(report.metrics.targetDepthMet, false);
  assert.equal(report.metrics.deliveryDepthBand, 'minimum');
});

test('품질 최소선 미달과 사용자 전달 불가 수준을 분리한다', () => {
  const source = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허.';
  const output = '가나다라마바사아자차카타파하고노도로머버서어저처커터퍼허.';
  const plan = {
    version: 3,
    policyVersion: 'perceived-v2.1',
    applicable: true,
    requestStrength: 'basic',
    targetIndices: [],
    targetSentenceCount: 0,
    requiredTargetChangedCount: 0,
    requiredChangedSentenceCount: 1,
    hardRequiredChangedSentenceCount: 1,
    minSubstantiveEditRatio: 0.15,
    hardMinimumSubstantiveEditRatio: 0.04,
    targetSubstantiveEditMin: 0.18,
    targetSubstantiveEditMax: 0.22
  };
  const report = depth.evaluateHumanizationDepth(source, output, plan);
  assert.equal(report.pass, false);
  assert.equal(report.minimumEffectPass, true, JSON.stringify(report));
  assert.ok(report.reasons.includes('substantive_edit_ratio_low'));
  assert.deepEqual(report.blockingReasons, []);
  assert.equal(report.metrics.deliveryDepthBand, 'below_minimum');
});

test('안전 재시도 후보가 품질 최소선에 조금 못 미쳐도 기존 후보보다 좋아지면 채택 대상으로 본다', () => {
  const source = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허.';
  const weak = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼혀.';
  const better = '가나다라마바사아자차카타파하고노도로머버서어저처커터퍼허.';
  const plan = {
    version: 3,
    policyVersion: 'perceived-v2.1',
    applicable: true,
    requestStrength: 'basic',
    targetIndices: [],
    targetSentenceCount: 0,
    requiredTargetChangedCount: 0,
    requiredChangedSentenceCount: 1,
    hardRequiredChangedSentenceCount: 1,
    minSubstantiveEditRatio: 0.15,
    hardMinimumSubstantiveEditRatio: 0.04,
    targetSubstantiveEditMin: 0.18,
    targetSubstantiveEditMax: 0.22
  };
  const weakReport = depth.evaluateHumanizationDepth(source, weak, plan);
  const betterReport = depth.evaluateHumanizationDepth(source, better, plan);
  assert.equal(betterReport.pass, false);
  assert.equal(depth.isBetterHumanizationCandidate(weakReport, betterReport), true);
});

test('polish는 실질 휴머나이징 깊이 게이트 적용 대상이 아니다', () => {
  const report = depth.evaluateHumanizationDepth(SOURCE, SOURCE, {
    requestStrength: 'polish',
    documentProfile: { profile: 'general' }
  });
  assert.equal(report.applicable, false);
  assert.equal(report.pass, true);
});
