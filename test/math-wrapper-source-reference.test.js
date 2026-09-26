'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const literals = require('../engine-gpt-prod/literalSpans');
const preflight = require('../engine-gpt-prod/sourcePreflight');

test('new inline variable wrapper is removed only with exact ordered original math and a plain source atom', () => {
  const source = '변수 q를 사용한다. 식 $y=4$를 확인하고 결과 $z=6$을 비교한다.';
  const frozen = literals.freezeMath(source);
  for (const wrapper of ['\\(q\\)', '$q$']) {
    const candidate = source.replace('q를', `${wrapper}를`);
    const restored = literals.restoreMathByOrder(candidate, frozen);
    assert.equal(restored.pass, true);
    assert.equal(restored.text, source);
    assert.equal(restored.addedWrapperCount, 1);
    assert.equal(literals.restoreMathByOrder(restored.text, frozen).applied, false);
  }
  for (const candidate of [
    source.replace('q를', '\\(r\\)를'),
    source.replace('q를', '\\(q+1\\)를'),
    source.replace('q를', '\\(q\\)를').replace('$y=4$', '$y=9$'),
    source.replace('q를', '\\(q\\)를').replace('$y=4$', '$z=6$').replace('결과 $z=6$', '결과 $y=4$')
  ]) {
    const result = literals.restoreMathByOrder(candidate, frozen);
    assert.equal(result.pass, false);
    assert.equal(result.text, candidate);
  }
});

test('original variable wrapper is retained and similar identifiers cannot authorize removal', () => {
  const source = '변수 $q$와 값 $y=4$를 쓴다. plain_q라는 식별자도 있다.';
  const frozen = literals.freezeMath(source);
  assert.equal(literals.restoreMathByOrder(source, frozen).text, source);
  const candidate = `${source} 추가로 \\(q\\)를 본다.`;
  assert.equal(literals.restoreMathByOrder(candidate, frozen).pass, false);
});

test('decimal section references with particles remain prose, real numbered headings still split', () => {
  for (const particle of ['에서', '에서는', '에서도', '과', '의']) {
    const source = `앞 내용을 확인했다. 2.4${particle} 배운 성질과 다음에 배울 성질을 연결해 살펴보았다.`;
    assert.equal(preflight.repairInlineHeadingBoundaries(source).text, source);
  }
  const source = '배경을 설명했다. 2.4 연구 방법 연구에는 기록 자료와 설문을 함께 활용했다.';
  assert.match(preflight.repairInlineHeadingBoundaries(source).text, /설명했다\.\n\n2\.4 연구 방법\n/u);
});
