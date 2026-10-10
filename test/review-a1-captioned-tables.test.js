'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const p = require('../engine-gpt-prod/sourcePreflight');
const s = require('../engine-gpt-prod/structureChunk');
const definitions = ['세부요인','조작적 정의','접근성','사용자가 자료를 쉽게 찾을 수 있는 정도','정확성','자료가 실제 관찰 결과를 반영하는 정도','적시성','필요한 시기에 정보를 제공하는 정도'];
const ranks = ['순위','선택대안','소속분류','종합가중치','1','대안 가','운영 분류','0.42','2','대안 나','관리 분류','0.33','3','대안 다','지원 분류','0.25'];
for (const [name, cells] of [['definition',definitions],['ranking',ranks]]) {
  test(`captioned ${name} cells stay locked through source preparation`, () => {
    const source = '<표 2-3> 조사 결과\n\n'+cells.join('\n')+'\n\n결과를 별도로 검토한다.';
    assert.equal(layout.analyzeLineStructure(source).tableLineCount, cells.length);
    const pre = p.auditAndSanitizeSource(source);
    assert.ok(pre.text.includes(cells.join('\n')));
    const chunks = s.splitChunksForGpt(pre.text).chunks;
    for (const cell of cells) assert.ok(chunks.some(c => c.locked && c.text.includes(cell)), cell);
  });
}
test('caption alone, short lists, verse and uncaptained definitions do not prove columns', () => {
  for (const text of [definitions.join('\n'), '봄\n새로운 계절의 시작\n여름\n뜨거운 바람의 기억\n가을\n차가운 계절의 시작',
    '<표 1> 메모\n\n항목\n내용\n하나\n둘\n셋\n넷\n다섯\n여섯'])
    assert.equal(layout.analyzeLineStructure(text).tableLineCount, 0);
});
