'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {restoreSourceSentenceOrdinals: restore} = require('../engine-gpt-prod/sourceSentenceRestore');
const {restoreUnsafeRelationSentences} = require('../engine-gpt-prod/fingerprintAudit');
// Synthetic fixture, not production user text.
const source = '학생들이 좁은 계단에서 이동에 큰 부담을 느낄 수 있겠다는 생각을 하였고, 그렇기 때문에 교사는 학생들의 자율성을 존중하며 이동을 도와야 한다.';
const first = '좁은 계단에서 이동하는 일도 학생들에게 큰 부담이 될 수 있다고 생각했다.';
const second = '따라서 교사는 이동을 돕는 것에서 멈추지 않고 학생들의 자율성을 존중해야 한다.';
test('single restoration cannot leave a paraphrased arm next to its whole source sentence', () => {
  const output = first + ' ' + second;
  assert.equal(restore(source, output, [1], {maxOutputGroup:1}).applied, false);
  assert.equal(restore(source, output, [1]).text, source);
  assert.equal(restoreUnsafeRelationSentences(source, output, {violations:[{code:'semantic_relation_shift',sentenceOrdinals:[1]}]}).text, source);
});
test('equal sentence counts do not imply identical sentence ownership', () => {
  const next = '다음 시간에는 새로운 실험 장비를 사용한다.';
  const output = first + ' ' + second;
  const r = restore(source + ' ' + next, output, [1]);
  assert.equal(r.text, source);
});
test('short compound sentences receive the same split ownership protection', () => {
  const source = '시약을 혼합했고 용액을 냉각했다.';
  const output = '시약을 혼합했다. 용액을 냉각했다.';
  assert.equal(restore(source, output, [1], {maxOutputGroup:1}).applied, false);
  assert.equal(restore(source, output, [1]).text, source);
});
test('split ownership does not merge paragraphs or overwrite a separate source sentence', () => {
  const output = first + '\n\n' + second;
  assert.equal(restore(source, output, [1]).text, output);
  const separate = '학생들의 자율성을 존중하며 이동을 도와야 한다.';
  const full = source + ' ' + separate;
  const changed = '학생들이 좁은 계단에서 이동에 큰 부담을 느낀다고 생각했으며 교사는 이를 이해해야 한다.';
  const r = restore(full, changed + ' ' + separate, [1]);
  assert.equal(r.text, source + ' ' + separate);
});

test('restoration does not transplant a similar claim whose real counterpart drifted past the local window', () => {
  const one = '냉각 조건에서는 측정 계수의 값이 증가하므로 첫 번째 계수를 사용한다.';
  const two = '가열 조건에서는 측정 계수의 값이 감소하므로 두 번째 계수를 사용한다.';
  const middle = Array.from({length: 12}, (_, i) => `관측 ${i + 1}의 장비 상태를 기록했다.`);
  const source = [one, ...middle, two].join(' ');
  const output = [one, ...middle, '가열 조건에서는 측정 계수 값이 감소하여 두 번째 계수를 사용한다.'].join(' ');
  // Equal counts and high shared vocabulary cannot justify restoring one
  // condition over another, even if the caller points at the wrong ordinal.
  const swapped = output.replace(one, two).replace('가열 조건에서는 측정 계수 값이 감소하여 두 번째 계수를 사용한다.', one);
  assert.equal(restore(source, swapped, [1], {maxOutputGroup:1}).applied, false);
  assert.equal(restore(source, swapped, [1], {ordinalSpace:'output',maxOutputGroup:1}).applied, false);
});

test('ambiguous repeated source clauses cannot authorize a sentence transplant', () => {
  const repeated = '온도를 낮추면 계수 값이 감소할 수 있다.';
  const source = repeated + ' 첫 번째 실험 결과를 기록했다. ' + repeated;
  const output = '온도를 낮추면 계수 값이 감소한다. 첫 번째 실험 결과를 기록했다. ' + repeated;
  assert.equal(restore(source, output, [1]).applied, false);
});

test('long compounds split into five arms cannot be partially restored under a one or three sentence cap', () => {
  const intro = '보고서는 운영 규칙과 현장의 자유를 통제하는 조직을 비판한다.';
  const compound = '과거의 담당자는 조직의 지시가 현장 상황과 맞지 않으므로 새로운 장비를 시험해야 한다고 주장했고, 현장의 자유를 통제하는 조직에 반대했지만, 장비 사용을 걱정하던 동료가 조사자가 되어 자료를 모으고 공개한 뒤에는 그 동료의 자료 공개 경위를 추궁하면서 과거와 현재의 입장이 바뀌게 된다는 점이 이 사례의 특징인 것 같다.';
  const arms = [
    '과거의 담당자는 현장 상황과 맞지 않는 조직의 지시에도 새로운 장비를 시험해야 한다고 주장했다.',
    '현장의 자유를 통제하는 조직에 반대하는 입장이었다.',
    '장비 사용을 걱정하던 동료는 조사자가 되어 자료를 모으고 공개한다.',
    '담당자는 동료의 자료 공개 경위를 추궁하는 역할을 맡는다.',
    '과거와 현재의 입장이 바뀌는 점이 이 사례의 특징인 것 같다.'
  ];
  for (const joiner of [' ', '\n\n']) {
    const output = intro + ' ' + arms.join(joiner);
    for (const maxOutputGroup of [1, 3]) {
      const r = restore(intro + ' ' + compound, output, [2], { maxOutputGroup });
      assert.equal(r.text, output);
      assert.equal(r.applied, false);
    }
    assert.equal(restoreUnsafeRelationSentences(intro + ' ' + compound, output, {
      violations: [{ code: 'semantic_relation_shift', sentenceOrdinals: [2] }]
    }).text, output);
  }
});
