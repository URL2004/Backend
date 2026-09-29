'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { restoreConfirmedRelations: restore } = require('../engine-gpt-prod/confirmedRelationRestore');
const { confirmedMicroRepair: micro } = require('../engine-gpt-prod/confirmedMicroRepair');
const { sentenceSimilarity } = require('../engine-gpt-prod/sentenceAlignment');

// Synthetic examples only. A restoration proposal is never a semantic pass.
const tail = Array.from({ length: 16 }, (_, i) =>
  `보관함 ${i + 1}번의 관측 기록은 다음 정기 점검에서 별도로 확인할 예정이다.`).join(' ');
function fixture(a, b, type = 'distortion', relation = 'modality_negation_causality', span = type === 'omission' ? a : b) {
  const source = `${a} ${tail}`, output = `${b} ${tail}`;
  const finding = groundViolation({ type, relation, origin: 'introduced', sourceSpan: a, candidateSpan: b, span }, source, output);
  return { source, output, finding, report: { pass: false, verificationCompleted: true, violations: [finding] } };
}

for (const [name, a, b, type, relation] of [
  ['temporal ordering', '현장 관측을 배우면서 기록 작업도 맡고 싶어졌다.', '현장 관측을 배운 뒤 기록 작업도 맡고 싶어졌다.'],
  ['importance is not necessity', '안내판을 제작할 때 가장 중요하게 알릴 규칙부터 골랐다.', '안내판을 제작할 때 반드시 알릴 규칙부터 골랐다.'],
  ['necessary experience evaluation', '실패한 측정도 장비를 이해하는 데 필요한 경험이었다.', '실패한 측정도 장비를 이해하는 경험이었다.', 'omission'],
  ['split lead duplication', '도구가 익숙해 쉬울 줄 알았지만 작업을 해보니 걱정이 들었다.',
    '도구가 익숙해서 쉬울 줄 알았다. 도구가 익숙해 쉬울 줄 알았지만 작업을 해보니 걱정이 들었다.', 'duplicate_conclusion', 'genre_naturalness']
]) test(`confirmed residual ${name} can propose an exact local restoration`, () => {
  const f = fixture(a, b, type, relation);
  const originalReport = JSON.stringify(f.report);
  assert.equal(f.finding.repairable, true);
  if (type === 'omission') {
    assert.equal(f.finding.spanVerified, false, 'omission evidence belongs to the source');
    assert.equal(f.finding.sourceSpanVerified, true);
  }
  const result = restore(f.source, f.output, f.report);
  assert.equal(result.text, f.source);
  assert.equal(result.restoredCount, 1);
  assert.equal(Object.hasOwn(result, 'pass'), false);
  assert.equal(JSON.stringify(f.report), originalReport);
});

test('low-overlap unnatural wording stays pending for a model patch, not a lowered matching threshold', () => {
  const a = '실험 준비에는 연구진의 흥미 외에도 충분한 장비와 시간이 필요했다.';
  const b = '연구원들끼리 재미있다고 준비가 다 된 게 아니었다.';
  const f = fixture(a, b, 'distortion', 'genre_naturalness');
  assert.equal(f.finding.repairable, true);
  assert.ok(sentenceSimilarity(a, b) < .35);
  assert.equal(restore(f.source, f.output, f.report).applied, false);
  assert.equal(f.report.pass, false);
});

for (const [name, a, b, relation] of [
  ['effect inside a hope', '누구나 편히 쉴 수 있는 정원이면 좋겠다.', '누구나 편히 쉬게 하는 정원이면 좋겠다.', 'modality_negation_causality'],
  ['attempt versus ongoing explanation', '설계를 설명하려고 하면 빠진 부분이 보였다.', '설계를 설명하다 보면 빠진 부분이 보였다.', 'condition_result']
]) test(`uncertain ${name} is not automatically suppressed or repaired`, () => {
  const f = fixture(a, b, 'distortion', relation);
  const uncertain = { ...f.report, uncertain: true };
  assert.equal(restore(f.source, f.output, uncertain).applied, false);
  assert.equal(uncertain.pass, false);
  assert.equal(uncertain.uncertain, true);
  assert.deepEqual(uncertain.violations, [f.finding]);
  assert.equal(restore(f.source, f.output, { ...f.report, violations: [{ ...f.finding, origin: 'unconfirmed' }] }).applied, false);
  assert.equal(restore(f.source, f.output, null).applied, false);
});

test('an unchanged quoted alternative cannot be borrowed for an unrelated narrator conjunction', () => {
  const a = '안내문에는 ‘감사나 검토를 수행한다’라고 적혀 있다. 현장에서는 감사와 검토를 순서대로 수행한다.';
  const b = '안내문에는 ‘감사나 검토를 수행한다’라고 적혀 있다. 현장에서는 감사와 검토를 동시에 수행한다.';
  const f = fixture(a, b, 'distortion', 'modality_negation_causality', '감사와 검토를 동시에 수행한다');
  const result = restore(f.source, f.output, f.report);
  assert.equal(result.text, f.source, 'restore the actual confirmed error, retaining the conjunction');
  assert.equal(result.text.includes('현장에서는 감사나 검토'), false);
  assert.equal(Object.hasOwn(result, 'pass'), false);
});

test('intensity predicate repair never crosses negation or reported-speech scope', () => {
  const a = '처음 다루는 관측 장비라 작업하면서 고장에 대한 걱정이 들었다.';
  for (const b of [
    '처음 다루는 관측 장비라 작업하면서 고장에 대한 걱정이 커지지 않았다.',
    '처음 다루는 관측 장비라 작업하면서 고장에 대한 걱정이 커졌다는 말은 사실이 아니었다.',
    '처음 다루는 관측 장비라 작업하면서 “고장에 대한 걱정이 커졌다.”라고 말했다.'
  ]) {
    const f = fixture(a, b, 'intensity_amplification');
    assert.equal(micro(a, b, f.finding), '');
  }
  const negative = '처음 다루는 관측 장비였지만 작업하면서 고장에 대한 걱정이 들지 않았다.';
  const positive = '처음 다루는 관측 장비였지만 작업하면서 고장에 대한 걱정이 커졌다.';
  assert.equal(micro(negative, positive, fixture(negative, positive, 'intensity_amplification').finding), '');
});
