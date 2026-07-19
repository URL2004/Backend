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
  assert.equal(lowPlan.policyVersion, 'perceived-v2.4.9');
  assert.equal(lowPlan.signalSource, 'deterministic_targets_input_risk');
  assert.equal(depth.PLAN_SIGNAL_SOURCE, 'deterministic_targets_input_risk');
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

test('단순 어휘 교체와 절·내용 순서 재구성을 별도 구조 지표로 구분한다', () => {
  const source = '자료를 먼저 모은 뒤 기준에 따라 분류하고 핵심 결과를 표로 정리했습니다.';
  const lexical = '자료를 먼저 수집한 뒤 기준에 따라 분류하고 핵심 결과를 표로 정리했습니다.';
  const structural = '기준에 따라 자료를 분류하려고 먼저 자료를 모았고, 핵심 결과는 표로 정리했습니다.';
  const lexicalMetrics = depth.measureSubstantiveEdit(source, lexical);
  const structuralMetrics = depth.measureSubstantiveEdit(source, structural);
  assert.equal(lexicalMetrics.structurallyChangedSentenceCount, 0, JSON.stringify(lexicalMetrics));
  assert.ok(structuralMetrics.structurallyChangedSentenceCount >= 1, JSON.stringify(structuralMetrics));
  assert.ok(structuralMetrics.contentOrderChangeCount >= 1 || structuralMetrics.clauseBoundaryChangeCount >= 1);
});

test('원문에 이미 있던 정형 성찰 결론을 남기면 깊이 보고서에 개선 미달을 기록한다', () => {
  const source = '자료를 조사했습니다. 그 결과 문제의 심각성을 깊이 이해하게 되었습니다. 다른 자료도 비교했습니다. 이를 통해 중요성을 절감했습니다.';
  const plan = depth.buildHumanizationPlan(source, { requestStrength: 'basic', documentProfile: 'report_assignment' });
  const output = '조사한 자료를 먼저 정리했습니다. 그 결과 문제의 심각성을 깊이 이해하게 되었습니다. 비교할 다른 자료도 살폈습니다. 이를 통해 중요성을 절감했습니다.';
  const report = depth.evaluateHumanizationDepth(source, output, plan);
  assert.ok(plan.rhetoricalRemediationPlan.targetCount >= 2, JSON.stringify(plan.rhetoricalRemediationPlan));
  assert.equal(report.metrics.remediation.coverage, 0);
  assert.ok(report.reasons.includes('rhetorical_remediation_low'), JSON.stringify(report));
  assert.equal(report.blockingReasons.includes('rhetorical_remediation_low'), false);
});

test('polish는 실질 휴머나이징 깊이 게이트 적용 대상이 아니다', () => {
  const report = depth.evaluateHumanizationDepth(SOURCE, SOURCE, {
    requestStrength: 'polish',
    documentProfile: { profile: 'general' }
  });
  assert.equal(report.applicable, false);
  assert.equal(report.pass, true);
});

test('2,000자 이상 일반 산문은 기본 30%·고급 25% 동일 문장 잔존 상한을 적용한다', () => {
  const sentences = Array.from({ length: 20 }, (_, index) => (
    `${index + 1}번째 일반 문장은 운영 과정에서 확인한 자료와 판단 근거를 구체적으로 설명하고, 서로 다른 조건을 비교해 결론에 이르는 과정을 충분한 길이로 기록합니다. 검증 일지와 담당자 메모를 함께 대조한 뒤 기록 순서를 기준으로 확인한 차이도 빠짐없이 표시합니다.`
  ));
  const source = sentences.join(' ');
  assert.ok(source.length >= 2000);
  const output = sentences.map((sentence, index) => index < 7
    ? sentence
    : `${index + 1}번째 기록에서는 운영 자료와 판단 근거를 먼저 살폈습니다. 조건별 차이를 비교한 뒤 그 결과를 문장으로 정리했습니다.`).join(' ');
  const basic = depth.evaluateHumanizationDepth(source, output, {
    requestStrength: 'basic',
    documentProfile: 'long_explainer'
  });
  const advanced = depth.evaluateHumanizationDepth(source, output, {
    requestStrength: 'advanced',
    documentProfile: 'long_explainer'
  });
  assert.equal(basic.plan.carryoverApplicable, true);
  assert.equal(basic.plan.maxSubstantiveCarryoverRatio, 0.30);
  assert.equal(advanced.plan.maxSubstantiveCarryoverRatio, 0.25);
  assert.equal(basic.metrics.substantiveCarryoverCount, 14);
  assert.equal(basic.metrics.substantiveCarryoverEligibleSentenceCount, 40);
  assert.equal(basic.metrics.substantiveCarryoverRatio, 0.35);
  assert.ok(basic.reasons.includes('substantive_carryover_high'));
  assert.ok(advanced.reasons.includes('substantive_carryover_high'));
});

test('동일 문장 잔존 정책의 2,000자 기준은 공백 포함 입력 길이를 사용한다', () => {
  const source = Array.from({ length: 14 }, (_, index) => (
    `${index + 1}번째 기록은 실제 운영 과정에서 확인한 자료를 같은 기준으로 비교하고 판단 근거를 정리한 문장입니다.`
  )).join(' '.repeat(100));
  assert.ok(source.length >= 2000);
  assert.ok(depth.normalizeSubstantive(source).length < 2000);
  const plan = depth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: { profile: 'long_explainer' },
    inputRisk: { abstractRiskRatio: 0 }
  });
  assert.equal(plan.carryoverApplicable, true);
  assert.equal(plan.maxSubstantiveCarryoverRatio, 0.30);
});

test('보존 민감 프로필은 동일 문장 잔존 상한을 5%p 완화한다', () => {
  const sentence = index => `${index + 1}번째 문장은 연구 절차와 자료 해석의 근거를 분명히 밝히고 인용된 개념의 적용 범위를 세부적으로 설명하는 학술 서술입니다. 분석 자료의 선정 기준과 검토 순서를 함께 기록하여 후속 연구자가 판단 과정을 확인할 수 있도록 구성했습니다. 동일한 절차를 세 차례 반복해 기록했습니다.`;
  const source = Array.from({ length: 20 }, (_, index) => sentence(index)).join(' ');
  const basic = depth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: 'academic_paper'
  });
  const advanced = depth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: 'resume_application'
  });
  assert.equal(basic.maxSubstantiveCarryoverRatio, 0.35);
  assert.equal(advanced.maxSubstantiveCarryoverRatio, 0.30);
});

test('제목·목록·인용·표·참고문헌은 동일 문장 잔존율 모수에서 제외한다', () => {
  const prose = Array.from({ length: 12 }, (_, index) => `${index + 1}회차 검토에서는 일반 산문에 포함된 자료와 판단을 별도의 기준으로 확인했습니다.`);
  const protectedLines = [
    '# 1. 제목',
    '● 목록 문장은 그대로 둡니다.',
    '> 직접 인용 문장은 그대로 둡니다.',
    '| 항목 | 값 |',
    '참고문헌',
    '홍길동. (2026). 참고 자료.'
  ];
  const source = [...prose, ...protectedLines].join('\n');
  const report = depth.measureSubstantiveCarryover(source, source);
  assert.equal(report.eligibleSentenceCount, 12);
  assert.equal(report.count, 12);
  assert.equal(report.ratio, 1);
});

test('저위험·대상 문장 15% 이하·담화 개선 대상 없음일 때만 효과 제한으로 진단한다', () => {
  const natural = '비가 왔다. 우산은 가방 안에 넣어 두었다. 학교 앞 오래된 빵집에서는 주인이 아침마다 직접 구운 식빵과 작은 단팥빵을 창가의 나무 선반 위에 차례로 올려놓곤 했다. 버스는 제시간에 도착했다. 집에 돌아와 젖은 운동화를 현관 신문지 위에 놓고 창문을 조금 열어 두었다.';
  const limited = depth.classifyEffectExpectation(natural, {
    requestStrength: 'basic',
    documentProfile: 'personal_essay',
    inputRisk: { abstractRiskRatio: 0 }
  });
  const polish = depth.classifyEffectExpectation(natural, {
    requestStrength: 'polish',
    documentProfile: 'personal_essay',
    inputRisk: { abstractRiskRatio: 0 }
  });
  const risky = depth.classifyEffectExpectation(SOURCE, {
    requestStrength: 'advanced',
    documentProfile: 'report_assignment',
    inputRisk: { abstractRiskRatio: 1 }
  });
  assert.equal(limited.effectExpectation, 'limited');
  assert.equal(limited.requiresEffectConfirmation, true);
  assert.equal(polish.effectExpectation, 'normal');
  assert.equal(risky.effectExpectation, 'normal');
});
