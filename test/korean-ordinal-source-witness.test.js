'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ordinalMarkers } = require('../engine-gpt-prod/koreanOrdinal');
const { compareOriginalStructuralMarkers: compare } = require('../engine-gpt-prod/structureChunk');
const numbers = (text, source) => ordinalMarkers(text, source == null ? {} : { source }).map(item => item.number);

test('adjectives before procedural objects do not remove ordinal protection', () => {
  for (const source of [
    '첫째로 안전한 장비를 사용한다. 둘째로 충분한 공간을 확보한다.',
    '첫째로 오염된 물을 제거한다. 둘째로 필요한 자료를 정리한다.',
    '첫째로 다양한 의견을 수집한다. 둘째로 준비된 문서를 검토한다.'
  ]) {
    assert.deepEqual(numbers(source), [1, 2]);
    assert.equal(compare(source, source.replace('첫째로 ', '')).pass, false);
  }
});

test('explicit relative noun references keep their equivalent noun frame', () => {
  const source = '검토가 이어졌다. 세 번째로 비판할 점은 근거가 부족하다는 것이다.';
  const output = '검토가 이어졌다. 세 번째 비판점은 근거가 부족하다는 것이다.';
  assert.deepEqual(numbers(source), []);
  assert.equal(compare(source, output).pass, true);
  assert.deepEqual(numbers('사례를 살폈다. 두 번째로 소개되는 지역의 주민은 협력했다.'), []);
});

const source = '검토 방법은 세 가지이다. 첫째, 장비의 손상 여부를 확인하는 안전 점검, '
  + '둘째, 기록의 누락 항목을 검토하는 자료 점검, 셋째, 측정값의 변화를 분석하는 결과 점검이다.';
const output = '검토 방법은 세 가지이다. 첫째는 장비의 손상 여부를 확인하는 안전 점검이다. '
  + '둘째는 기록의 누락 항목을 검토하는 자료 점검이다. 셋째는 측정값의 변화를 분석하는 결과 점검이다.';

test('a split inline item requires the same local body in a consecutive source series', () => {
  assert.deepEqual(numbers(source), [1]);
  assert.deepEqual(numbers(output, source), [1]);
  assert.equal(compare(source, output).pass, true);
  const unrelated = output.replace('측정값의 변화를 분석하는 결과 점검', '새로운 예산을 신청하는 운영 계획');
  assert.deepEqual(numbers(unrelated, source), [1, 3]);
  assert.equal(compare(source, unrelated).pass, false);
});

test('quoted, code and unrelated source mentions do not authorize a new topic marker', () => {
  const base = '첫째, 품질은 중요한 요소이다. ';
  const newItem = '셋째는 측정값의 변화를 분석하는 결과 점검이다.';
  const mention = '예시, 셋째, 측정값의 변화를 분석하는 결과 점검이다.';
  for (const extra of ['“' + mention + '”', '`' + mention + '`', '\n~~~\n' + mention + '\n~~~', '안내문에는 ' + mention]) {
    const original = base + extra;
    assert.deepEqual(numbers(base + newItem, original), [1, 3]);
    assert.equal(compare(original, base + newItem).pass, false);
  }
});

test('duplicated output topics cannot share a single source witness', () => {
  const duplicate = output + ' 셋째는 측정값의 변화를 분석하는 결과 점검이다.';
  assert.deepEqual(numbers(duplicate, source), [1, 3, 3]);
  assert.equal(compare(source, duplicate).pass, false);
  const repeatedSource = source + ' ' + source;
  assert.deepEqual(numbers(output, repeatedSource), [1, 2, 3]);
});
