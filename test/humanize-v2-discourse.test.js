'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const discourse = require('../engine-gpt-prod/discourseAudit');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');
const { assessRepairCandidate } = require('../engine-gpt-prod/judge');

test('같은 주장 안의 어순·호흡 변화는 담화 위반으로 오탐하지 않는다', () => {
  const source = '나는 도서관 이용 자료를 직접 조사했다. 설문 결과도 표로 정리했다.\n\n정리한 자료에서는 오후 이용 시간이 늘어난 사실을 확인했다.';
  const output = '도서관 이용 자료는 내가 직접 조사했고, 설문 결과는 표로 묶어 정리했다.\n\n자료를 정리해 보니 오후 이용 시간이 늘어난 사실이 확인됐다.';
  const audit = discourse.compareDiscourse(source, output);
  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.deepEqual(audit.codes, []);
});

test('조사했다를 찾아본으로 의역해도 실제 활동 비중 축소로 오인하지 않는다', () => {
  const source = '고대 유물의 연대 측정을 주제로 선정함. 관련 자료를 자발적으로 조사해 계산식을 직접 유도함. 실제 수치에 적용해 제작 시기를 계산으로 검증함. 수학적 원리의 활용 가능성을 깨달음.';
  const output = '고대 유물의 연대 측정을 주제로 선정함. 관련 자료를 스스로 찾아본 뒤 계산식을 직접 유도함. 실제 수치에 적용해 제작 시기를 계산으로 검증함. 수학적 원리의 활용 가능성을 깨달음.';
  const audit = discourse.compareDiscourse(source, output);
  assert.equal(audit.codes.includes('personal_balance_shift'), false, JSON.stringify(audit));
});

test('같은 성찰 문단의 판단을 알게 되었다로 의역해도 새 평가로 오인하지 않는다', () => {
  const source = [
    '수업을 들으며 과거의 문제들이 조금씩 보이기 시작했습니다. 결국 문제의 시작은 상대방이 아니라 제 자신에게 있었습니다.',
    '스스로를 먼저 사랑하지 못하면서 타인을 사랑할 수 있다고 생각했던 점이 큰 오류였다는 것을 깨달았습니다.'
  ].join('\n\n');
  const output = [
    '수업을 들으며 과거의 문제들이 조금씩 보이기 시작했습니다. 끝내 문제의 출발점은 상대방이 아니라 제 자신이라는 걸 알게 되었습니다.',
    '스스로를 먼저 사랑하지 못한 채 타인을 사랑할 수 있다고 여겼던 점이 큰 오류였음을 깨달았습니다.'
  ].join('\n\n');
  const audit = discourse.compareDiscourse(source, output);
  for (const code of ['new_evaluation', 'repeated_reflection_conclusion', 'rhetorical_role_shift']) {
    assert.equal(audit.codes.includes(code), false, `${code}: ${JSON.stringify(audit)}`);
  }
});

test('알았다를 알게 되었다로 풀어 써도 같은 인지 기능으로 본다', () => {
  const source = '이후 자세히 알아보니 일본어에는 탁음과 반탁음, 촉음이 있다는걸 알았다.';
  const output = '이후 자세히 알아보니 일본어에는 탁음과 반탁음, 촉음이 있다는 것을 알게 되었다.';
  const audit = discourse.compareDiscourse(source, output);
  assert.equal(audit.codes.includes('new_evaluation'), false, JSON.stringify(audit));
  assert.equal(audit.codes.includes('rhetorical_role_shift'), false, JSON.stringify(audit));
});

test('원문에 명시된 통찰과 배움을 자연스럽게 고쳐도 새 평가로 오인하지 않는다', () => {
  const source = '오감을 자극하며 공간적 제약을 넘어선 경험의 확장으로 나아가야 한다는 통찰을 그 조의 아이디어가 저희 조에게 배움을 주었습니다.';
  const output = '오감을 자극하고 공간적 제약을 넘어선 경험의 확장으로 나아가야 한다는 통찰을 그 조의 아이디어를 통해 저희 조도 배울 수 있었습니다.';
  const audit = discourse.compareDiscourse(source, output);
  assert.equal(audit.codes.includes('new_evaluation'), false, JSON.stringify(audit));
  assert.equal(audit.codes.includes('rhetorical_role_shift'), false, JSON.stringify(audit));
});

test('즉을 결국로 의역한 요약 기능을 새 중복 결론으로 오인하지 않는다', () => {
  const source = [
    "즉 북중 관계의 의제 자체가 '한반도 문제 해결'에서 '양자 협력의 제도화'로 이동한 것이다.",
    'III. 결론',
    '앞선 분석은 향후 연구에서도 중요하다고 볼 수 있다.'
  ].join('\n\n');
  const output = [
    "결국 북중 관계의 의제는 '한반도 문제 해결'에서 '양자 협력의 제도화'로 옮겨갔다.",
    'III. 결론',
    '앞선 분석은 향후 연구에서도 중요하다고 볼 수 있다.'
  ].join('\n\n');
  const audit = discourse.compareDiscourse(source, output);
  assert.equal(audit.codes.includes('duplicate_conclusion'), false, JSON.stringify(audit));
});

test('새 성찰·강한 수식·반복 인과 결론을 원문 대비로 잡는다', () => {
  const source = [
    '기온 자료를 조사하고 연도별 수치를 표로 정리했다.',
    '강수량 자료를 비교하고 지역별 차이를 기록했다.',
    '조사 과정과 확인한 수치를 발표 자료에 적었다.'
  ].join('\n\n');
  const output = [
    '기온 자료를 조사하고 연도별 수치를 표로 정리했다. 그 결과 파멸적인 변화를 깊이 이해하게 되었습니다.',
    '강수량 자료를 비교하고 지역별 차이를 기록했다. 이로 인해 막강한 영향을 깊이 이해하게 되었습니다.',
    '조사 과정과 확인한 수치를 발표 자료에 적었다.'
  ].join('\n\n');
  const codes = new Set(discourse.compareDiscourse(source, output).codes);
  for (const code of ['new_evaluation', 'intensity_amplification', 'repeated_reflection_conclusion', 'overstructured_causality', 'rhetorical_role_shift']) {
    assert.equal(codes.has(code), true, `${code} missing: ${[...codes].join(',')}`);
  }
});

test('확장 담화 표지와 새 내용어 묶음이 함께 생길 때만 범위 확장 신호를 낸다', () => {
  const source = '기후 자료에서 연도별 평균 기온 변화를 비교했다.';
  const output = '기후 자료에서 연도별 평균 기온 변화를 비교했다. 나아가 세계 시민의 인권과 식량 안보, 국제 연대 문제까지 함께 살펴봤다.';
  assert.equal(discourse.compareDiscourse(source, output).codes.includes('scope_expansion'), true);

  const safeLonger = '연도별 평균 기온이 어떻게 달라졌는지 확인하려고 기후 자료를 직접 비교했다.';
  assert.equal(discourse.compareDiscourse(source, safeLonger).codes.includes('scope_expansion'), false);
});

test('같은 문장을 문단으로 나누기만 해도 범위 확장·중복 결론으로 오탐하지 않는다', () => {
  const first = '결국 자료를 비교하는 일은 중요한 의미가 있다. 나아가 여러 관점을 함께 검토했다.';
  const second = '이처럼 기록한 수치를 다시 확인하는 과정도 의미가 있다.';
  const source = `${first} ${second}`;
  const output = `${first}\n\n${second}`;
  const codes = discourse.compareDiscourse(source, output).codes;
  assert.equal(codes.includes('scope_expansion'), false, codes.join(','));
  assert.equal(codes.includes('duplicate_conclusion'), false, codes.join(','));
});

test('결론 뒤 새 탐구 시작과 실제 활동 비중 축소를 감지한다', () => {
  const source = '자료를 조사했다. 수치를 비교했다. 차이가 나타난 구간을 기록했다.\n\n발표 자료를 만들고 표를 검토했다.';
  const output = '자료를 조사했다. 수치를 비교했다. 이 과정은 중요한 의미가 있다. 일반적으로 이 현상은 사회 전체에 영향을 준다. 결국 지속적인 관심이 필요하다.\n\n추가로 엘니뇨를 탐구했습니다. 발표 자료를 만들고 표를 검토했다.';
  const codes = new Set(discourse.compareDiscourse(source, output).codes);
  assert.equal(codes.has('topic_restart'), true, [...codes].join(','));
  assert.equal(codes.has('personal_balance_shift'), true, [...codes].join(','));
});

test('휴머나이징 프롬프트는 수치 할당량을 숨기고 원문 담화 계약을 제공한다', () => {
  const source = '또한 자료를 조사했습니다. 따라서 결과를 체계적으로 정리했습니다. 결론적으로 지속적인 관심이 중요합니다.';
  const plan = humanizationDepth.buildHumanizationPlan(source, { requestStrength: 'advanced' });
  const depthBlock = humanizationDepth.buildHumanizationPromptBlock(plan);
  const discourseBlock = discourse.discoursePromptBlock(discourse.buildDiscourseProfile(source));
  assert.match(depthBlock, /서버가 결과에서 별도로 계산/u);
  assert.doesNotMatch(depthBlock, /\d+(?:\.\d+)?\s*%|목표 범위|실질 변화 최소선은/u);
  assert.match(discourseBlock, /원문 담화 계약/u);
  assert.match(discourseBlock, /설명 문단을 성찰·교훈·결론 문단으로 바꾸지 않는다/u);
});

test('원문에 이미 있는 AI식 성찰·수식·반복 결론을 삭제가 아닌 재표현 대상으로 만든다', () => {
  const source = [
    '자료를 조사한 결과 파멸적인 영향을 깊이 이해하게 되었습니다.',
    '다른 자료를 비교한 결과 막강한 영향을 절감했습니다.',
    '결국 이 활동은 중요한 의미가 있다.'
  ].join(' ');
  const plan = discourse.buildRemediationPlan(source);
  const codes = new Set(plan.categories.map(item => item.code));
  assert.ok(codes.has('reflection_formula'));
  assert.ok(codes.has('stacked_strong_modifiers'));
  const prompt = discourse.discoursePromptBlock(discourse.buildDiscourseProfile(source));
  assert.match(prompt, /원문에 이미 있는 AI식 담화 흔적 개선/u);
  assert.match(prompt, /주장·평가 강도·사실은 남기면서/u);
  assert.match(prompt, /원문에 있던 주제 확장은 보존/u);

  const improved = '자료를 조사하면서 영향의 크기를 직접 확인했다. 다른 자료와 비교해도 같은 경향이 뚜렷했다. 이 활동에서 확인한 내용은 조사 기록에 남겼다.';
  const remediation = discourse.compareRemediationTargets(source, improved, plan);
  assert.equal(remediation.coverage, 1, JSON.stringify(remediation));
  assert.equal(remediation.residualTargetCount, 0);
});

test('깊이 재시도 대상은 충분히 구조가 바뀐 비대상 문장을 피하고 위험 문장을 우선한다', () => {
  const source = '첫 문장을 조사했습니다. 또한 둘째 문장을 정리했습니다. 셋째 문장을 비교했습니다. 넷째 문장을 기록했습니다. 다섯째 문장을 검토했습니다.';
  const current = source.replace('첫 문장을 조사했습니다', '조사한 것은 첫 문장이었습니다');
  const plan = humanizationDepth.buildHumanizationPlan(source, { requestStrength: 'advanced' });
  plan.targetIndices = [1, 3];
  plan.requiredChangedSentenceCount = 3;
  plan.requiredTargetChangedCount = 2;
  const report = humanizationDepth.evaluateHumanizationDepth(source, current, plan);
  const ordinals = qualityV2.buildGeneralRetryTargetOrdinals(source, current, plan, report);
  assert.equal(ordinals.includes(1), false, ordinals.join(','));
  assert.deepEqual(ordinals.slice(0, 2), [2, 4]);
  assert.ok(ordinals.length >= 2);
});

test('깊이 재시도는 단어만 조금 바뀐 위험 문장도 구조 개선 대상으로 다시 고른다', () => {
  const source = '첫 문장을 기록했습니다. 또한 둘째 문장을 체계적으로 정리했습니다. 셋째 문장을 비교했습니다. 넷째 문장을 검토했습니다.';
  const current = source.replace('체계적으로 정리했습니다', '차분하게 정리했습니다');
  const plan = humanizationDepth.buildHumanizationPlan(source, { requestStrength: 'advanced' });
  plan.targetIndices = [1];
  plan.requiredChangedSentenceCount = 2;
  plan.requiredTargetChangedCount = 1;
  plan.requiredStructuralChangedSentenceCount = 2;
  const report = humanizationDepth.evaluateHumanizationDepth(source, current, plan);
  const ordinals = qualityV2.buildGeneralRetryTargetOrdinals(source, current, plan, report);
  assert.ok(ordinals.includes(2), ordinals.join(','));
});

test('고급 문단 회복 대상은 앞 문단 문장을 몰아서 고르지 않고 문단별 한 곳을 먼저 고른다', () => {
  const source = [
    '또한 첫 문장을 정리했습니다. 따라서 둘째 문장을 분석했습니다.',
    '또한 셋째 문장을 정리했습니다. 따라서 넷째 문장을 분석했습니다.',
    '또한 다섯째 문장을 정리했습니다. 따라서 여섯째 문장을 분석했습니다.'
  ].join('\n\n');
  const plan = humanizationDepth.buildHumanizationPlan(source, { requestStrength: 'advanced' });
  plan.targetIndices = [0, 1, 2, 3, 4, 5];
  plan.targetSentenceCount = 6;
  plan.requiredChangedSentenceCount = 3;
  plan.requiredTargetChangedCount = 3;
  plan.paragraphCoverageApplicable = true;
  plan.targetParagraphIndices = [0, 1, 2];
  plan.targetParagraphCount = 3;
  plan.requiredTargetChangedParagraphCount = 3;
  const report = humanizationDepth.evaluateHumanizationDepth(source, source, plan);
  const ordinals = qualityV2.buildGeneralRetryTargetOrdinals(source, source, plan, report);
  assert.deepEqual(ordinals.slice(0, 3), [1, 3, 5]);
});

test('의미 수리 후보가 새 담화 위반을 만들면 안전 수리로 채택하지 않는다', () => {
  const source = '학생은 기온 자료를 조사했다. 연도별 수치를 표로 정리했다.';
  const before = '학생은 기온 자료를 살펴봤다. 연도별 수치는 표로 묶어 정리했다.';
  const candidate = `${before} 이를 통해 파멸적인 영향을 깊이 이해하게 되었습니다.`;
  const audit = assessRepairCandidate(source, before, candidate);
  assert.equal(audit.pass, false);
  assert.ok(audit.reasons.includes('discourse_new_violation'));
});

test('잔여 담화 위반은 안전한 qualityWarning 코드로 변환한다', () => {
  const warnings = qualityV2.warningsFromSemantic({
    ran: true,
    pass: false,
    violations: [{ type: 'scope_expansion', span: '새 범위', detail: '원문 밖 주제' }]
  });
  assert.deepEqual(warnings.map(item => item.code), ['scope_expansion']);
  assert.match(warnings[0].message, /주제 범위/u);
});
