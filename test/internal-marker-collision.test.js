'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const lit=require('../engine-gpt-prod/literalSpans');
const s=require('../engine-gpt-prod/structureChunk');
const engine=require('../engine-gpt-prod');
const {buildBoundaryMarkerInstructions}=require('../engine-gpt-prod/prompts/humanize/userBlock');
const paragraphs=()=>[0,1,2].map(i=>({text:`관찰 ${i}의 결과를 자세히 설명한다. 측정 과정과 의미도 기록한다.`,sep:'\n\n',locked:false}));
test('request namespaces differ, reuse stays stable, and full-source token collisions are skipped',t=>{
 let seed=0;t.mock.method(crypto,'randomInt',()=>seed++);
 const source='ZXQCODE0000QXZ 식별자와 `sample` 코드, ZXQMATH0000QXZ 수식 $x=1$.';
 const ctx=lit.createMarkerContext(source),code=lit.freezeInlineCode(source,ctx),math=lit.freezeMath(code.text,ctx);
 assert.equal(code.blocks[0].token,'ZXQCODE0001QXZ');
 assert.equal(math.blocks[0].token,'ZXQMATH0001QXZ');
 const thaw=lit.restoreInlineCode(lit.restoreMath(math.text,math).text,code);
 assert.equal(thaw.pass,true);assert.equal(thaw.text,source);
 assert.equal(lit.materializeChunkLiterals([{text:math.text}],{inlineCodeFreeze:code,inlineMathFreeze:math})[0].text,source);
 assert.equal(lit.freezeInlineCode(source,ctx).blocks[0].token,code.blocks[0].token);
 assert.notEqual(lit.freezeInlineCode(source).blocks[0].token,lit.freezeInlineCode(source).blocks[0].token);
});
test('boundary round-trip preserves user tokens and flags extra unknown tokens',t=>{
 t.mock.method(crypto,'randomInt',()=>1);
 const chunks=paragraphs();chunks[0].text+=' [[[V2_BOUNDARY_0001]]] [[[V2_BOUNDARY_001]]]';
 const chunk=s.coalesceEditableChunks(chunks)[0];
 assert.equal(chunk.boundaryMarkers[0].marker,'[[[V2_BOUNDARY_0002]]]');
 const result=s.restoreBoundaryMarkers(chunk.llmText,chunk);
 assert.equal(result.ok,true);assert.equal(result.text,chunk.text);
 assert.equal(s.restoreBoundaryMarkers(chunk.llmText+' [[[V2_BOUNDARY_001]]]',chunk).leaked,true);
 assert.equal(s.restoreBoundaryMarkers(chunk.llmText+' [[[V2_LINE_9999]]]',chunk).leaked,true);
 const token=chunk.boundaryMarkers[0].marker;
 assert.equal(s.restoreBoundaryMarkers(chunk.llmText.replace(token,''),chunk).ok,false);
 assert.equal(s.restoreBoundaryMarkers(chunk.llmText+token,chunk).ok,false);
});
test('locked blocks share request IDs across refreezes and preserve literal token-shaped text',t=>{
 t.mock.method(crypto,'randomInt',()=>0);
 const source='ZXQLOCK0000QXZ\n## 관찰\n본문이다.';
 const chunks=[{index:0,text:'## 관찰',locked:true}];
 const frozen=engine.freezeLockedBlocks(source,source,chunks);
 assert.equal(frozen.blocks[0].token,'ZXQLOCK0001QXZ');
 assert.equal(frozen.source.split(frozen.blocks[0].token).join(frozen.blocks[0].value),source);
 assert.equal(engine.freezeLockedBlocks(source,source,chunks,frozen.markerContext).source,frozen.source);
 const pair=engine.buildHumanizationDepthPair({source,outputText:source,chunks});
 assert.equal(pair.source,pair.output);
});
test('random IDs never enter the fixed boundary instructions',t=>{
 let seed=100;t.mock.method(crypto,'randomInt',()=>seed++);
 const a=s.coalesceEditableChunks(paragraphs())[0],b=s.coalesceEditableChunks(paragraphs())[0];
 assert.notEqual(a.llmText,b.llmText);
 assert.equal(buildBoundaryMarkerInstructions(a),buildBoundaryMarkerInstructions(b));
 assert.ok(!buildBoundaryMarkerInstructions(a).includes(a.boundaryMarkers[0].marker));
});
test('line and sentence tokens avoid collisions across the entire document',t=>{
 t.mock.method(crypto,'randomInt',()=>0);
 const source='원문에 [[[V2_LINE_0000]]]와 [[[V2_SENTENCE_0000]]]가 있다.\n\n첫 문장을 자세하게 설명한다. 두 번째 문장도 충분하게 설명한다. 마지막 문장을 마무리한다.\n추가 설명이 다음 행에 있다.';
 const plan=s.splitChunksForGpt(source,{coalesceEditable:true,preserveLineBoundaries:true,preserveSentenceBoundaries:true,sentenceBoundaryMinimum:2});
 for(const chunk of plan.chunks){for(const item of [...chunk.lineBoundaryMarkers||[],...chunk.sentenceBoundaryMarkers||[]])assert.ok(!source.includes(item.marker));assert.equal(s.restoreBoundaryMarkers(chunk.llmText||chunk.text,chunk).ok,true);}
});
