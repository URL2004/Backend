'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const floor = require('../engine/floor');

test('a formula number cannot acquire a unit from the next paragraph', () => {
  for (const separator of ['\n\n', '\r\n\r\n', '\n  \n']) {
    const source = `변환 결과는 3${separator}여기서 주파수를 비교한다.`;
    const candidate = `변환 결과는 3${separator}주파수를 이 결과와 비교한다.`;
    assert.equal(floor.measureNovelty(source, candidate).count, 0);
    assert.equal(floor.extractFacts(candidate, true).some(t => /3\s*주/u.test(t)), false);
  }
});

test('real quantities including a single PDF hard wrap remain protected', () => {
  const source = '12\n명에게 4주 동안 2회를 안내했다.';
  assert.equal(floor.measureNovelty(source, '12명에게 4주 동안 2회를 안내했다.').count, 0);
  assert.ok(floor.measureNovelty(source, '13명에게 5주 동안 3회를 안내했다.').count >= 3);
});
