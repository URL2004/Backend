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
