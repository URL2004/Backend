'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {repairInlineHeadingBoundaries} = require('../engine-gpt-prod/sourcePreflight');

test('an ambiguous inline citation marker does not become a numbered section', () => {
  for (const marker of ['1)', '7)', '12)']) {
    const source = `조사 참여자의 72.5%가 변화를 경험했다고 답했다. ${marker} 이는 기술이 일상에 널리 보급되었음을 보여 준다.`;
    assert.equal(repairInlineHeadingBoundaries(source).text, source);
  }
});
test('explicit section names and a sequence of numbered items still separate', () => {
  const section = repairInlineHeadingBoundaries('첫 절의 설명을 마쳤다. 2) 연구 방법 연구에는 설문지를 사용했다.').text;
  assert.match(section, /마쳤다\.\n\n2\) 연구 방법/u);
  const items = repairInlineHeadingBoundaries('두 가지를 정리했다. 1) 이는 첫 번째 근거다. 2) 이것은 두 번째 근거다.').text;
  assert.match(items, /정리했다\.\n\n1\)/u);
});
