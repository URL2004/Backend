'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../engine-gpt-prod/fingerprintAudit');
const detect = f.detectContrastRelationShift;

const cases = [
  ['action_comparison', '목적은 표지를 디자인하는 것이 아니라 방문자의 동선을 조사하는 것이다.', '표지를 디자인하기보다 방문자의 동선을 조사하는 것이다.'],
  ['action_comparison', '음악은 청중을 압도하는 방식이 아니라 선율을 차분히 쌓는 방식이다.', '음악은 청중을 압도하기보다 선율을 차분히 쌓는 방식이다.'],
  ['nominal_comparison', '평가의 기준은 작업의 속도가 아니라 기록의 정확성이다.', '평가의 기준은 작업의 속도보다 기록의 정확성이다.'],
  ['nominal_comparison', '평가의 기준은 작업의 속도가 아니라 기록의 정확성이다.', '평가의 기준은 작업의 속도보다는 기록의 정확성이다.'],
  ['recharacterizing_comparison', '학습은 고정된 상태가 아니라 질문을 바꾸는 과정이다.', '학습은 고정된 상태라기보다 질문을 바꾸는 과정이다.'],
  ['recharacterizing_comparison', '학습은 고정된 개념이 아니라 질문을 바꾸는 과정이다.', '학습은 고정된 개념이라기보다 질문을 바꾸는 과정이다.']
];
for (const [pattern, source, output] of cases) {
  test(`배제 대상과 긍정 내용이 대응하는 ${output.match(/\S*보다\S*/u)[0]}`, () => {
    const result = detect(source, output);
    assert.equal(result.count, 1);
    assert.equal(result.patternCounts[pattern], 1);
    assert.equal(detect(output, output).count, 0, '원문부터 비교인 경우');
    assert.equal(detect(source, source).count, 0);
  });
}

test('한정·가산과 관용 표현은 비교 반전으로 세지 않는다', () => {
  for (const source of [
    '평가는 단순히 작업의 속도가 아니라 기록의 정확성도 살핀다.',
    '평가는 작업의 속도뿐 아니라 기록의 정확성도 살핀다.',
    '평가는 작업의 속도만이 아니라 기록의 정확성도 살핀다.',
    '평가는 다름이 아니라 기록의 정확성을 살피는 일이다.'
  ]) assert.equal(detect(source, '평가는 작업의 속도보다 기록의 정확성을 살핀다.').count, 0);
});

test('각 비교형의 이웃 문장을 배제 문장의 대응으로 쓰지 않는다', () => {
  for (const [, source, output] of cases) {
    const neighbour = output.replace(/이다\.$/u, '일 수 있다.');
    assert.equal(detect(`${source} ${neighbour}`, `${source} ${neighbour}`).count, 0);
  }
  assert.equal(detect('기준은 속도가 아니라 정확성이다. 비용은 작년보다 낮다.',
    '기준은 정확성이다. 비용은 작년보다 낮다.').count, 0);
});

test('어휘 대응이 없거나 긍정 내용이 다른 비교는 보류한다', () => {
  assert.equal(detect('평가 기준은 구매 속도가 아니라 기록의 정확성이다.',
    '평가 기준은 판매 속도보다 기록의 정확성이다.').count, 0);
  assert.equal(detect('목적은 장식을 제거하는 것이 아니라 통로를 확보하는 것이다.',
    '장식을 없애기보다 통로를 확보하는 것이다.').count, 0);
  assert.equal(detect('목적은 장식을 제거하는 것이 아니라 통로를 확보하는 것이다.',
    '장식을 제거하기보다 통로를 폐쇄한다.').count, 0);
  assert.equal(detect('평가는 어제보다 정확한 작업이 아니라 속도를 측정한다.',
    '평가는 작업보다 속도를 측정한다.').count, 0);
  assert.equal(detect('평가의 기준은 작업의 속도가 아니라 기록의 정확성이다.',
    '평가의 기준은 작업의 속도보다 기록의 정확성이며 속도를 기준으로 삼지는 않는다.').count, 0);
});

test('비교형도 기존 원문 문장 복원을 사용하며 안전 거절을 존중한다', () => {
  const [, source, output] = cases[2];
  const audit = f.auditFingerprint(source, output, 'general');
  const restored = f.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.text, source);
  assert.equal(restored.restoredSentenceCount, 1);
  const rejected = f.restoreValidatedRelationSentences(source, output, 'general', () => false);
  assert.equal(rejected.text, output);
  assert.equal(rejected.restoredSentenceCount, 0);
});

test('여러 배제 반전 중 안전한 한 문장을 복원한 것도 개선이다', () => {
  const source = `${cases[0][1]} ${cases[2][1]}`;
  const output = `${cases[0][2]} ${cases[2][2]}`;
  const before = f.auditFingerprint(source, output, 'general');
  const partly = f.auditFingerprint(source, `${cases[0][1]} ${cases[2][2]}`, 'general');
  assert.equal(before.relationShift.count, 2);
  assert.equal(partly.relationShift.count, 1);
  assert.equal(f.isImproved(before, partly), true);
  const restored = f.restoreValidatedRelationSentences(source, output, 'general', () => true);
  assert.equal(restored.text, source);
  assert.equal(restored.restoredSentenceCount, 2);
});

test('상투구가 든 문장 대신 이웃 원문을 고른 복원은 거절하고 별도 안전 복원은 남긴다', () => {
  const source = '이는 단순히 외적인 수치를 머릿속에 집어넣는 과정이 아니라, 관찰이라는 기술적 경험을 통해 자신의 판단을 정교하게 다듬는 과정이다. 측정을 통해 기술자는 숙련된 관찰자로 거듭나게 된다. 보고서를 제출한다. 장비를 반납한다.';
  const output = '실험 1은 금요일에 끝난다. 측정은 외부 수치를 받아들이는 데서 끝나지 않고, 관찰이라는 기술적 경험을 바탕으로 판단을 정교하게 다듬는 과정이기도 하다. 이를 통해 기술자는 숙련된 관찰자로 거듭난다. 보고서를 제출한다. 장비를 반납한다.';
  const audit = {violations:[{code:'engine_phrase_fingerprint',family:'limitative_additive',sentenceOrdinals:[2]}]};
  const restored = f.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.text, output);
  assert.equal(restored.restoredSentenceCount, 0);
  assert.deepEqual(restored.rejectedOutputSentenceOrdinals, [2]);
  assert.equal(restored.reason, 'ambiguous_fingerprint_source_owner');
  const extraSource = ' 조명은 무대를 비추는 기능뿐 아니라 배우의 동선을 알린다.';
  const extraOutput = ' 조명은 무대를 비추는 기능에 그치지 않고 배우의 동선을 알린다.';
  const partial = f.restoreUnsafeRelationSentences(source + extraSource, output + extraOutput,
    {violations:[{...audit.violations[0],sentenceOrdinals:[2,6]}]});
  assert.equal(partial.text, output + extraSource);
  assert.equal(partial.restoredSentenceCount, 1);
});

test('숫자 관측값은 재감사에서 사라지지 않고 승인된 수리 종류를 구분한다', () => {
  const [, source, output] = cases[2];
  const before = f.auditFingerprint(source, output, 'general');
  const after = f.auditFingerprint(source, source, 'general');
  const metrics = f.createContrastShiftMetrics();
  metrics.observe(source, before); metrics.observe(source, before);
  metrics.resolved(source, before, after, 'retry');
  metrics.resolved(source, before, after, 'retry');
  assert.deepEqual(metrics.snapshot(), {
    contrastRelationDetectedSentenceCount: 1,
    contrastRelationPatternCounts: {limitative_additive: 0, action_comparison: 0, nominal_comparison: 1, recharacterizing_comparison: 0},
    contrastRelationRetryResolvedSentenceCount: 1,
    contrastRelationSourceRestoreSentenceCount: 0
  });
  const restoredMetrics = f.createContrastShiftMetrics();
  restoredMetrics.resolved(source, before, after, 'restore');
  assert.equal(restoredMetrics.snapshot().contrastRelationSourceRestoreSentenceCount, 1);
  assert.equal(restoredMetrics.snapshot().contrastRelationRetryResolvedSentenceCount, 0);
  assert.equal(JSON.stringify(metrics.snapshot()).includes('평가'), false);
});
