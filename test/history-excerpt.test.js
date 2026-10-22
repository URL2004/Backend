'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exactExcerptMatch } = require('../lib/historyExcerpt');
const sentence = index => `${index}번 조사에서는 지역 도서관의 이용 시간과 자료 분류 방법을 확인하고 담당자가 제공한 기록을 순서대로 대조했다. 참여자들이 직접 작성한 의견과 현장 관찰 내용을 함께 살펴보며 조사 결과의 범위와 한계를 구체적으로 기록했다.`;
const parts = Array.from({ length: 14 }, (_, i) => sentence(i + 1));
const output = parts.join('\n\n');

test('unchanged prefix, suffix and middle excerpts retain complete sentence boundaries', () => {
  for (const text of [parts.slice(0, 9).join(' '), parts.slice(4).join('\n'), parts.slice(2, 11).join('\n\n')]) {
    const match = exactExcerptMatch(text, output);
    assert.ok(match); assert.ok(match.lengthRatio < 1); assert.ok(match.sentenceCount >= 3);
  }
});
test('excerpt proof rejects edits, internal omissions, reordered sentences and changed Korean word boundaries', () => {
  const text = parts.slice(0, 9).join('\n\n');
  for (const invalid of [text + ' 새로운 주장을 추가했다.', text.replace('1번', '99번'),
    text.replace('확인하고', '확인하지 않고'), text.replace('이용 시간', '이용시간'),
    [...parts.slice(0, 3), ...parts.slice(4, 10)].join('\n\n'),
    [parts[1], parts[0], ...parts.slice(2, 9)].join('\n\n'), text.slice(5), text.slice(0, -4)]) {
    assert.equal(exactExcerptMatch(invalid, output), null);
  }
});
test('small or ambiguous samples do not become excerpt matches', () => {
  assert.equal(exactExcerptMatch(parts[0], output), null);
  const repeated = parts.slice(0, 7).join('\n\n');
  assert.equal(exactExcerptMatch(repeated, repeated + '\n\n' + repeated), null);
  assert.equal(exactExcerptMatch(output, output), null);
});
