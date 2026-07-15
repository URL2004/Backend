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

test('깊이 재시도 대상은 이미 바뀐 문장을 피하고 위험 문장을 우선한다', () => {
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
