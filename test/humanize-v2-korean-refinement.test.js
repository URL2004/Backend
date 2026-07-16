'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const refinement = require('../engine-gpt-prod/koreanRefinement');

test('문장부호·수량 괄호 붙임과 새로 생긴 깊게 이해 결합만 안전하게 고친다', () => {
  const source = '가정을 세웠다. 아버지는 두 사례를 깊이 이해했습니다. 목록(3개)에서 항목을 골랐습니다.';
  const output = '가정을 세웠다.아버지는 2가지)어머니의 사례를 깊게 이해했습니다. 목록(3개)에서 항목을 골랐습니다.';
  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: output });
  assert.equal(repaired.applied, true);
  assert.match(repaired.text, /세웠다\. 아버지는/u);
  assert.match(repaired.text, /2가지\) 어머니/u);
  assert.match(repaired.text, /깊이 이해했습니다/u);
  assert.match(repaired.text, /목록\(3개\)에서/u, '괄호 뒤 조사는 띄우지 않아야 한다');
  assert.deepEqual(new Set(repaired.changeCodes), new Set([
    'missing_sentence_space',
    'numeric_parenthesis_join',
    'deep_understanding_collocation'
  ]));
});

test('원문에 있던 깊게 이해는 자동 변경하지 않고 원문 검토 알림으로 분리한다', () => {
  const source = '원리를 깊게 이해하려고 했습니다.';
  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: source });
  assert.equal(repaired.applied, false);
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: source });
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'deep_understanding_collocation'));
  assert.equal(audit.sourceReviewWarnings[0].severity, 'notice');
});

test('빈도 충돌과 어색한 초점 연결을 문맥 수리 대상으로 검출한다', () => {
  const text = '그때마다 고객에게서 같은 말을 자주 들었습니다. 시장 접근 방식이 어떻게 달라지는지도 중심에 두고 분석했습니다.';
  const audit = refinement.analyzeKoreanRefinement({ source: text, outputText: text, documentProfile: 'resume_application' });
  assert.ok(audit.repairableCodes.includes('frequency_quantifier_conflict'));
  assert.ok(audit.repairableCodes.includes('awkward_focus_attachment'));
  assert.equal(audit.introducedIssueCount, 0);
});

test('지원서의 전문 개념어가 구어체로 모두 내려간 경우 격식 하락을 기록한다', () => {
  const source = '발표 흐름을 설계하고 자료를 분석해 전달 역량을 키웠습니다. 피드백을 반영했고 학생들과 교류했으며 편의점에서 근무했습니다.';
  const output = '발표 흐름부터 짰고 자료를 함께 봐서 전달하는 힘을 키웠습니다. AI가 준 내용을 반영했고 학생들과 어울렸으며 다시 일한 편의점 아르바이트에서도 배웠습니다.';
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application' }
  });
  assert.ok(audit.issueCodes.includes('professional_register_downgrade'), JSON.stringify(audit));
  assert.ok(audit.introducedIssueCount >= 1);
  assert.ok(audit.residualWarnings.some(item => item.code === 'korean_professional_register_downgrade'));
});

test('원문 검토 경고는 결과 품질 경고와 별도 배열로 유지한다', () => {
  const source = '-항목을 적었습니다.\n그때마다 같은 말을 자주 들었습니다.';
  const output = '- 항목을 적었습니다.\n그 과정에서 같은 말을 여러 번 들었습니다.';
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: output });
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'list_marker_spacing'));
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'frequency_quantifier_conflict'));
  assert.equal(audit.residualWarnings.some(item => item.code === 'korean_frequency_quantifier_conflict'), false);
});
