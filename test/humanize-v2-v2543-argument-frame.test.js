'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const korean = require('../engine-gpt-prod/koreanRefinement');

test('v2.5.43: 주격+인용 보어를 목적격+부사격으로 바꾸며 생긴 목적격 연쇄를 탐지하고 원문 문장으로 복원한다', () => {
  const source = [
    '그러던 중 그는 관련 기록을 읽었다.',
    '신석구는 이 말씀을 통해 기독교가 유교를 단순히 폐기하는 종교가 아니라 자신이 유교를 통해 추구해 온 도덕적 이상을 완성할 수 있는 신앙이라고 이해했다.',
    '이 판단은 이후의 결단으로 이어졌다.'
  ].join(' ');
  const output = [
    '그러던 중 그는 관련 기록을 살펴보았다.',
    '이 말씀을 바탕으로 신석구는 기독교를 유교를 단순히 폐기하는 종교가 아니라, 자신이 유교를 통해 추구해 온 도덕적 이상을 완성할 수 있는 신앙으로 이해했다.',
    '이 판단은 이후의 결단으로 이어졌다.'
  ].join(' ');

  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'academic_paper' },
    mode: 'formal'
  });
  assert.ok(audit.issueCodes.includes('introduced_argument_frame_collision'));
  const issue = audit.issues.find(item => item.code === 'introduced_argument_frame_collision');
  assert.deepEqual(issue.sentenceOrdinals, [2]);

  const restored = korean.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(restored.applied, true);
  assert.ok(restored.restoredCodes.includes('introduced_argument_frame_collision'));
  assert.match(restored.text, /기독교가 유교를[^.]+신앙이라고 이해했다/u);
  assert.doesNotMatch(restored.text, /기독교를\s+유교를/u);
  assert.match(restored.text, /^그러던 중 그는 관련 기록을 살펴보았다/u);
});

test('v2.5.43: 원문부터 유지된 정상 내포문과 직접 인용 내부는 목적격 연쇄로 오탐하지 않는다', () => {
  const legitimate = '연구자는 이 제도를 이용자가 서비스를 선택하는 기준으로 이해했다.';
  const unchanged = korean.analyzeKoreanRefinement({
    source: legitimate,
    outputText: legitimate,
    documentProfile: { profile: 'academic_paper' },
    mode: 'formal'
  });
  assert.equal(unchanged.issueCodes.includes('introduced_argument_frame_collision'), false);

  const source = '그는 “기독교를 유교를 폐기하는 신앙으로 이해했다”는 기록을 인용했다.';
  const output = '그는 “기독교를 유교를 폐기하는 신앙으로 이해했다”는 기록을 그대로 인용했다.';
  const quoted = korean.analyzeKoreanRefinement({ source, outputText: output });
  assert.equal(quoted.issueCodes.includes('introduced_argument_frame_collision'), false);
});

test('v2.5.43: 같은 논항 충돌을 특정 종교 용어가 없는 일반 문장에서도 탐지한다', () => {
  const source = '학생은 이 경험을 통해 협업이 갈등을 피하는 방법이 아니라 서로의 기준을 확인하는 과정이라고 이해했다.';
  const output = '이 경험을 바탕으로 학생은 협업을 갈등을 피하는 방법이 아니라 서로의 기준을 확인하는 과정으로 이해했다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'personal_essay' },
    mode: 'assignment'
  });
  assert.ok(audit.issueCodes.includes('introduced_argument_frame_collision'));
});

test('v2.5.43: 목록 라벨의 정렬용 콜론 공백은 문장부호 오류로 세거나 임의 삭제하지 않는다', () => {
  const source = '1. 재무·세무 : 월·연간 결산, 재무제표 작성';
  const output = '1. 재무·세무 : 월·연간 결산, 재무제표 작성';
  const audit = korean.analyzeKoreanRefinement({ source, outputText: output });
  assert.equal(audit.issueCodes.includes('sentence_punctuation_spacing'), false);
  assert.equal(korean.applySafeFormattingRepairs({ source, outputText: output }).text, output);

  const actualError = '결과를 확인했다 . 다음 단계로 넘어갔다.';
  assert.equal(
    korean.applySafeFormattingRepairs({ source: actualError, outputText: actualError }).text,
    '결과를 확인했다. 다음 단계로 넘어갔다.'
  );
});
