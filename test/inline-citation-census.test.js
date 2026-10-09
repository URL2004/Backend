'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreInlineCitationLayout:repair}=require('../engine-gpt-prod/inlineCitationLayout');
const structure=require('../engine-gpt-prod/structureChunk');
test('page atoms and repeated inline footnotes survive a paragraph split',()=>{
 const source='관찰 결과를 기록했다.(p.42) 다음 내용을 검토한다.3)\n다른 결과도 확인했다.3)';
 const output='관찰 결과를 적었다.(p.\n\n42) 다음 내용을 검토했다.\n\n3)\n다른 결과도 확인했다.\n\n3)';
 const r=repair(source,output); assert.equal(r.pass,true); assert.equal(r.contentPreserved,true);
 assert.equal(r.text,'관찰 결과를 적었다.(p.42) 다음 내용을 검토했다.3)\n다른 결과도 확인했다.3)');
 assert.equal(repair(source,r.text).repairCount,0);
});
test('actual numbered lists, code and decimal text remain untouched',()=>{
 const source='1) 첫 번째 항목이다.\n2) 두 번째 항목이다.\n값은 3.14다. `p. 42`\n```\np.\n42\n```';
 assert.equal(repair(source,source).text,source);assert.equal(repair(source,source).pass,true);
});
test('missing and reordered citations are reported without guessing',()=>{
 const src='첫 번째 결과를 검토했다.3) 두 번째 결과를 확인했다.4)';
 for(const out of ['첫 번째 결과를 검토했다. 두 번째 결과를 확인했다.4)','첫 번째 결과를 검토했다.4) 두 번째 결과를 확인했다.3)']){
  const r=repair(src,out);assert.equal(r.pass,false);assert.equal(r.text,out);
 }
});
test('final layout retains inline numeric references and reaches a fixed point',()=>{
 const source='관찰 자료의 비중은 이전보다 높아졌다.6) 추가 결과는 다음 조사에서 확인할 예정이다.\n\n1) 실제 확인 항목\n준비 과정을 차례로 기록한다.';
 const chunks=structure.splitChunksForGpt(source,{preserveLineBoundaries:'structural'}).chunks;
 const run=outputText=>structure.restoreFinalDocumentLayout({source,outputText,chunks,mode:'assignment',requestStrength:'basic',documentProfile:{profile:'report_assignment'},normalizeVisualGaps:true});
 const r=run(source.replace('다.6)','다.\n\n6)'));
 assert.equal(r.pass,true);
 assert.match(r.text,/높아졌다\.6\)/u);assert.match(r.text,/\n1\) 실제 확인 항목/u);
 assert.equal(run(r.text).text,r.text);
});

test('whether predicates retain ordinal ownership before another numbered section',()=>{
 const source='검토할 요인은 두 가지다. 첫째는 참여가 계속되는가이다. 둘째는 준비 기간이다.\n6. 다음 계획\n첫째, 자료를 모은다. 둘째, 결과를 정리한다.';
 const output='검토할 요인은 두 가지다.\n\n첫째는 참여가 계속될지 여부다. 둘째는 준비 기간이다.\n6. 다음 계획\n첫째, 자료를 모은다. 둘째, 결과를 정리한다.';
 assert.equal(structure.compareOriginalStructuralMarkers(source,output).pass,true);
 assert.equal(require('../engine-gpt-prod/koreanOrdinal').ordinalMarkers('첫째는 학교에 갔다. 둘째는 집에 남았다.').length,0);
});
