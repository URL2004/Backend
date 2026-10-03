'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const layout=require('../engine-gpt-prod/layoutStructure');
const st=require('../engine-gpt-prod/structureChunk');
const {refreshDeliveredLayoutAudit:refresh,digest}=require('../engine-gpt-prod/deliveredLayoutAudit');
const source='도서관 창가에서\n— 한 작가의 《낯선 길》을 읽고\n1. 첫 만남\n나는 도서관에서 오래된 책을 읽었다. 책의 질문을 따라 나의 경험을 되돌아보았다.\n2. 다시 생각하기\n나는 그 질문을 친구와 함께 이야기했다. 같은 장면을 다르게 받아들일 수 있다는 사실을 알았다.';
for(const gap of ['\n','\n\n','\n\n\n'])test('reading subtitle role is stable across gaps '+gap.length,()=>{
 const text=source.split('\n').join(gap);
 const record=layout.buildLineRecords(text).find(r=>r.text.startsWith('—'));
 assert.equal(record.role,'title');
 const chunks=st.splitChunksForGpt(text,{coalesceEditable:true}).chunks;
 assert.ok(chunks.some(c=>c.locked&&c.text.includes('《낯선 길》')));
 const result=st.restoreFinalDocumentLayout({source:text,outputText:text.replace('오래된 책','낡은 책'),chunks,mode:'blog',documentProfile:'personal_essay',normalizeVisualGaps:true});
 assert.equal(result.structuralPass,true);
 assert.equal(result.returnedStructureAudit.sourceLineAnchorAdditionCount,0);
 assert.equal(st.restoreFinalDocumentLayout({source:text,outputText:result.text,chunks,mode:'blog',documentProfile:'personal_essay',normalizeVisualGaps:true}).text,result.text);
});
test('ordinary dash prose is not promoted to a protected cover subtitle',()=>{
 const text='산책의 기록\n— 나는 책을 읽고 오래 생각했다.\n1. 첫 만남\n나는 길을 걸었다.';
 assert.notEqual(layout.buildLineRecords(text).find(r=>r.text.startsWith('—')).role,'title');
});
test('actual heading loss remains a failure',()=>{
 const chunks=st.splitChunksForGpt(source).chunks;
 assert.equal(st.buildStructureAudit({source,outputText:source.replace('2. 다시 생각하기\n',''),chunks}).pass,false);
});
test('rollback refreshes stale layout failure and counts from the delivered text',()=>{
 const chunks=st.splitChunksForGpt(source).chunks;
 const repair={pass:false,structuralPass:false,readabilityPass:true,paragraphs:{afterCount:58,explicitParagraphCountAfter:58}};
 refresh({source,outputText:source,chunks,mode:'blog',documentProfile:'personal_essay',layoutRepair:repair});
 assert.equal(repair.pass,true);
 assert.equal(repair.paragraphs.afterCount,layout.measureParagraphReadability(source).paragraphCount);
 assert.equal(repair.paragraphs.explicitParagraphCountAfter,1);
 assert.equal(repair.preDeliverySnapshot.paragraphCount,58);
 assert.equal(st.buildStructureAudit({source,outputText:source,chunks,layoutRepair:repair}).pass,true);
 assert.equal(JSON.stringify(repair).includes('도서관'),false);
});
test('same-candidate unresolved layout cycle cannot become a pass',()=>{
 const chunks=st.splitChunksForGpt(source).chunks;
 const repair={deliveryIntegrityFixedPoint:{candidateDigest:digest(source),converged:false}};
 refresh({source,outputText:source,chunks,layoutRepair:repair});
 assert.equal(repair.pass,false);
 assert.equal(repair.finalDelivered.unsettled,true);
});
test('a discarded candidate cycle does not contaminate another verified layout',()=>{
 const repair={deliveryIntegrityFixedPoint:{candidateDigest:digest(source+'\n\n'),converged:false}};
 refresh({source,outputText:source,chunks:st.splitChunksForGpt(source).chunks,layoutRepair:repair});
 assert.equal(repair.pass,true);
});
test('late real damage is detected even if previous statistics passed',()=>{
 const repair={pass:true,structuralPass:true};
 refresh({source,outputText:source.replace('1. 첫 만남',''),chunks:st.splitChunksForGpt(source).chunks,layoutRepair:repair});
 assert.equal(repair.pass,false);
});

test('latest same-candidate convergence supersedes an earlier unsettled attempt',()=>{
 const candidateDigest=digest(source);
 const repair={finalFixedPoint:{candidateDigest,converged:false},deliveryIntegrityFixedPoint:{candidateDigest,converged:true}};
 refresh({source,outputText:source,chunks:st.splitChunksForGpt(source).chunks,layoutRepair:repair});
 assert.equal(repair.pass,true);
 assert.equal(repair.finalDelivered.unsettled,false);
});

test('returned readability is measured after quotation ownership restoration',()=>{
 const prose='나는 기록 속 질문을 따라 나의 경험을 되돌아보았다. 같은 사건도 처한 상황에 따라 다르게 느껴진다는 점을 생각했다. ';
 const text='기록을 읽으며\n1. 첫 질문\n“'+prose.repeat(9).trim()+'”(22p)\n나는 이 대목을 다시 읽고 내 경험과 비교했다.';
 const chunks=st.splitChunksForGpt(text,{coalesceEditable:true}).chunks;
 const options={source:text,outputText:text,chunks,mode:'blog',documentProfile:'personal_essay',normalizeVisualGaps:true};
 const result=st.restoreFinalDocumentLayout(options);
 const measured=layout.measureParagraphReadability(result.text,{...options,protectedBlocks:chunks.filter(c=>c.locked).map(c=>c.text)});
 assert.equal(result.paragraphs.paragraphs.afterCount,measured.paragraphCount);
 assert.equal(result.paragraphs.paragraphs.readability.overlongCount,measured.overlongCount);
 assert.equal(result.readabilityPass,measured.overlongCount===0);
 assert.equal(result.paragraphs.paragraphs.explicitParagraphCountAfter,layout.splitExplicitParagraphs(result.text).length);
});
