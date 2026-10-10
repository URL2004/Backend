'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../engine-gpt-prod/sourcePreflight');
const s = require('../engine-gpt-prod/structureChunk');
test('tabular questions retain all cells before inline heading repair', () => {
  const row = '언어\t이해\t선택\t직접 읽을 수 있습니까? ① 직접 이해\t② 설명 필요';
  const source = `표 1. 조사 항목\n분류\t항목\t방법\t질문\t답변\n${row}\n\n조사 결과를 정리한다.`;
  const pre = p.auditAndSanitizeSource(source);
  assert.ok(pre.text.includes(row));
  assert.ok(s.splitChunksForGpt(pre.text).chunks.some(c => c.locked && c.text.includes(row)));
  assert.equal(p.auditAndSanitizeSource(pre.text).text, pre.text);
});
test('ordinary prose headings are still repaired alongside a table', () => {
  const result = p.repairInlineHeadingBoundaries('항목\t질문이다. ① 보기\n관찰을 마쳤다. 2. 결론\n다음 실험을 준비한다.');
  assert.ok(result.text.includes('항목\t질문이다. ① 보기'));
  assert.ok(result.text.includes('마쳤다.\n\n2. 결론'));
});
