'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {improveInlineLabelLayout,isSafeLabelBodyLayout}=require('../engine-gpt-prod/inlineLabelParagraphs');
const structure=require('../engine-gpt-prod/structureChunk');
const layout=require('../engine-gpt-prod/layoutStructure');
const bare=s=>s.replace(/\s/gu,'');
const first='측정 장비는 시료에 빛을 비추고 투과한 빛의 세기를 기록하여 농도를 비교하는 방식으로 작동합니다. 관찰자는 시료의 양과 용기의 재질을 일정하게 유지하면서 반복 측정한 결과를 표에 기록하고 측정 조건에 따른 차이를 확인하며 장비의 영점을 조절한 시각과 주변 조명 상태도 함께 기록합니다.';
const second='기존 측정을 대신할 수 있는 방법으로는 표준 색상표를 사용하는 관찰 실험이 있습니다. 이 방법에서는 같은 조명 아래 시료와 표준 색상표를 나란히 놓고 비교하며 관찰자마다 판단이 달라질 수 있다는 한계를 기록하고 서로의 관찰 기록을 대조하여 차이를 논의합니다.';
const source=`1. 관찰 방법\n측정 원리:${first} ${second}\n주의 사항: 같은 조건에서 관찰합니다.`;
test('developed label prose splits at a topic transition without changing words',()=>{
 const result=improveInlineLabelLayout(source);
 assert.equal(bare(result.text),bare(source));assert.equal(result.splitCount,1);
 assert.ok(result.text.includes(`${first}\n\n${second}`));
 assert.ok(result.text.includes('측정 원리: '));
 assert.equal(improveInlineLabelLayout(result.text).text,result.text);
});
for(const mode of ['blog','formal'])test(`${mode}: final restoration and audit retain safe label paragraphs`,()=>{
 const chunks=structure.splitChunksForGpt(source).chunks;
 const args={source,outputText:source,chunks,mode,normalizeVisualGaps:true,documentProfile:{profile:'report_assignment',confidence:0.95}};
 const result=structure.restoreFinalDocumentLayout(args);
 assert.equal(result.pass,true);assert.equal(result.converged,true);
 assert.ok(result.text.includes(`${first}\n\n${second}`));
 assert.equal(structure.compareInlineLabelBodyLayout(source,result.text).pass,true);
 assert.equal(structure.restoreFinalDocumentLayout({...args,outputText:result.text}).text,result.text);
 assert.equal(bare(result.text),bare(source));
});
test('sentence fragments remain invalid; developed paragraphs containing inline quotes remain valid',()=>{
 assert.equal(isSafeLabelBodyLayout('시료를 관찰하고\n결과를 기록합니다.'),false);
 assert.equal(isSafeLabelBodyLayout(first+'\n\n'+second),true);
 assert.equal(isSafeLabelBodyLayout(first.replace('시료','“시료”')+'\n\n'+second),true);
 assert.equal(isSafeLabelBodyLayout('“'+first+'\n\n'+second+'”'),false);
});
test('short labels and fenced code do not acquire paragraphs',()=>{
 const short='항목: 하나입니다.\n결과: 둘입니다.';
 assert.equal(improveInlineLabelLayout(short).text,short);
 const code='```text\n'+source+'\n```';
 assert.equal(improveInlineLabelLayout(code).text,code);
});
test('polish does not opt into new label-body paragraphing',()=>{
 const result=structure.restoreFinalDocumentLayout({source,outputText:source,mode:'polish',normalizeVisualGaps:true,chunks:structure.splitChunksForGpt(source).chunks});
 assert.equal(result.labelBodySplitCount,0);
});
test('a label group does not exempt an oversized individual body from readability checks',()=>{
 const text='측정 원리: '+Array(9).fill(first).join(' ')+'\n주의 사항: 반복 측정합니다.';
 assert.ok(layout.measureParagraphReadability(text).overlongCount>0);
});
test('literal quotation and code boundaries are not paragraph candidates',()=>{
 for(const text of ['“측정 원리:'+first+' '+second+'”','측정 원리: `'+first+' '+second+'`']) {
  assert.equal(improveInlineLabelLayout(text).splitCount,0);
 }
});
