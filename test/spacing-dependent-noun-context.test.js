'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixSpacing } = require('../engine/spacing');

test('dependent-noun repair does not split intact countless/unlucky lexical words', () => {
  for (const input of [
    '가능한 조합은 수없이 많다.',
    '비슷한 경우도 수없이 존재한다.',
    '수없는 시도 끝에 마쳤다.',
    '그는 재수없다고 생각했다.',
    '수없이 반복되는 작업이다.'
  ]) {
    assert.equal(fixSpacing(input).text, input);
    assert.equal(fixSpacing(input).fixes, 0);
  }
});

test('dependent-noun auxiliary requires an attested adnominal stem, preserving valid repairs', () => {
  for (const [input, expected] of [
    ['진행할수있다.', '진행할 수 있다.'],
    ['확인할 수없다.', '확인할 수 없다.'],
    ['읽을 수있었다.', '읽을 수 있었다.'],
    ['셀 수없이 많았다.', '셀 수 없이 많았다.'],
    ['볼 수없는 경우이다.', '볼 수 없는 경우이다.'],
    ['할 수 있다.\n수없이 많다.', '할 수 있다.\n수없이 많다.']
  ]) {
    const fixed = fixSpacing(input);
    assert.equal(fixed.text, expected);
    assert.equal(fixSpacing(fixed.text).fixes, 0);
  }
});
