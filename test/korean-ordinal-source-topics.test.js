'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ordinalMarkers } = require('../engine-gpt-prod/koreanOrdinal');
const { compareOriginalStructuralMarkers: compare } = require('../engine-gpt-prod/structureChunk');
const source = '첫째, 자료의 흐름을 명확하게 보여 주는 도표다. 둘째, 여러 관찰 결과를 함께 설명하는 분석이다.';
test('source-backed topic forms keep enumeration without output context vocabulary', () => {
  const output = source.replace('첫째,', '첫째는').replace('둘째,', '둘째는');
  assert.equal(compare(source, output).pass, true);
  assert.deepEqual(ordinalMarkers(output, { source }).map(x => x.number), [1, 2]);
});
test('family topics and unrelated topic bodies are not inferred as lists', () => {
  const family = '첫째는 학교에 갔다. 둘째는 집에서 책을 읽었다.';
  assert.equal(ordinalMarkers(family).length, 0);
  assert.equal(ordinalMarkers(family, { source }).length, 0);
  assert.equal(compare(source, family).pass, false);
});
test('missing, duplicated, reordered and ambiguous ordinal topics stay visible', () => {
  assert.equal(compare(source, source.replace('첫째, ', '')).pass, false);
  const first = '첫째는 자료의 흐름을 명확하게 보여 주는 도표다.';
  assert.equal(compare(source, first + ' ' + first).pass, false);
  assert.equal(compare(source, '둘째는 여러 관찰 결과를 함께 설명하는 분석이다. ' + first).pass, false);
  assert.equal(ordinalMarkers(first, { source: source + ' ' + source }).length, 0);
});
