'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const o=require('../engine-gpt-prod/omissionRestore'),s=require('../engine-gpt-prod/sourcePreflight');
const f=require('../engine-gpt-prod/factAudit');
const sc=require('../engine-gpt-prod/structureChunk');
const intro='조사 전에는 현장의 상황을 확인하고 평가 기준을 정리했다. 자료를 분류한 뒤 각 항목을 검토했다.';
const paragraph='지역 도서관의 조사 결과는 처음 생각과 달랐다. 이용자는 자료 검색과 예약 과정을 모두 중요하게 생각했다. 특히 검색 과정의 응답 비중은 40%라는 설명을 들었다. 이후 이용자의 의견을 비교하면서 그 이유를 살펴보았다. 조사 기준과 실제 결과의 관계를 이해할 수 있었다.';
const ending='다음 조사에서는 안내 방식도 살펴볼 예정이다. 확인한 내용을 바탕으로 개선 계획을 마련했다.';
const source=intro+'\n\n'+paragraph+'\n\n'+ending;
test('partial paraphrase quantity loss restores a uniquely aligned paragraph without duplicate claims',()=>{
 const output=source.replace('40%라는','높다는');
 const r=o.restoreConfirmedSemanticOmissions({source,outputText:output,semanticReport:{pass:false,violations:[]}});
 assert.equal(r.restoredCount,1);assert.equal(r.text,source);
 assert.equal(f.compareNumberMultiset(source,r.text).changed,false);
 assert.equal(o.restoreMissingQuantifiedParagraphs(source,r.text).restored.length,0);
});
test('numeric restoration preserves approved extra facts and avoids ambiguous endpoints',()=>{
 const output=source.replace('40%라는','높다는');
 assert.equal(o.restoreConfirmedSemanticOmissions({source,outputText:output,allowedExtra:'추가 조사 수치는 승인된 자료를 사용한다.'}).applied,false);
 assert.equal(o.restoreMissingQuantifiedParagraphs(source,output+'\n\n'+paragraph.replace('40%라는','높다는')).restored.length,0);
 assert.equal(o.restoreMissingQuantifiedParagraphs(source,output.replace('이후 이용자의 의견을 비교하면서 그 이유를 살펴보았다.','별도의 해외 투자 계약을 체결하고 새로운 회사를 설립했다.')).restored.length,0);
});
test('unchanged quantities and numeric formatting aliases do not trigger source restoration',()=>{
 assert.equal(o.restoreMissingQuantifiedParagraphs(source,source.replace('40%','40퍼센트')).restored.length,0);
 assert.equal(o.restoreMissingQuantifiedParagraphs(paragraph,paragraph.replace('40%라는','높다는')).restored.length,0);
});
test('hierarchical section numbers are not split at their internal decimal dots',()=>{
 const source='2.1.3 세부 과정 이 과정은 세 가지 단계로 구성된다. 각 단계의 차이를 자세히 설명한다. 2.1.4 다음 과정 여기에서는 확인한 내용을 비교한다. 내용을 충분히 검토한 뒤 결과를 정리한다.';
 const r=s.repairInlineHeadingBoundaries(source);
 assert.ok(r.text.includes('\n\n2.1.4'));
 assert.equal(f.compareNumberMultiset(source,r.text).changed,false);
 assert.doesNotMatch(r.text,/2\.\s*\n1\./);
});
test('document-attested PDF word boundaries repair without changing characters or verse',()=>{
 const prefix='장치 내부를 먼저 살펴보았다. 전체 구조를 확인한 다음 각 부분을 검토했다. '+('이 과정에서는 자료를 확인하고 관찰한 내용을 자세히 기록한다. ').repeat(3);
 const source=prefix+'좁은 공간 내\n\n부를 채우는 방식으로 진행했다.';
 const r=s.repairSourceLayoutArtifacts(source);
 assert.ok(r.text.includes('공간 내부를'));
 assert.equal(r.text.replace(/\s/g,''),source.replace(/\s/g,''));
 assert.equal(s.repairSourceLayoutArtifacts(r.text).text,r.text);
 const verse='내부의 노래\n창가에 선 나\n조용한 공간 내\n부는 바람의 소리';
 assert.equal(s.repairSourceLayoutArtifacts(verse).text,verse);
 const code='```text\n'+source+'\n```';
 assert.equal(s.repairSourceLayoutArtifacts(code).text,code);
});

test('semantic paragraph layout still splits an overlong local paragraph after reaching the document count',()=>{
 const long=Array.from({length:11},(_,i)=>`조사 과정에서는 자료의 특성과 관찰 기준을 비교하고 각 항목의 차이를 충분히 검토한 뒤 ${i+1}차 기록을 정리했다.`).join(' ');
 const tail='반면 다음 조사에서는 다른 관점도 확인할 필요가 있었다. 자료의 차이를 살펴보며 후속 조사 계획을 마련했다.';
 const text=long+'\n\n'+tail;
 const options={source:text,outputText:text,mode:'assignment',requestStrength:'basic',documentProfile:'report_assignment'};
 const r=sc.restoreParagraphLayout(options);
 assert.equal(r.policy,'semantic_prose_roles');
 assert.equal(r.readability.overlongCount,0);
 assert.ok(r.proseSplitCount>0);
 assert.equal(r.text.replace(/\s/gu,''),text.replace(/\s/gu,''));
 assert.equal(sc.restoreParagraphLayout({...options,outputText:r.text}).text,r.text);
});

test('readability completion preserves quoted sentences, citations and polish line ownership',()=>{
 const quoted='“관찰한 자료를 기록했다. 비교한 결과를 확인했다. 다른 항목도 검토했다. 모든 내용을 정리했다.”';
 const body=('확인한 내용을 자세히 정리하고 각 항목의 차이를 살펴보았다. ').repeat(8)+quoted;
 const text=body+'\n\n반면 다음 조사에서는 다른 방법도 비교했다. 관찰한 결과를 기록했다.';
 const r=sc.restoreParagraphLayout({source:text,outputText:text,mode:'assignment',requestStrength:'basic',documentProfile:'report_assignment'});
 assert.ok(r.text.includes(quoted));
 const polish=sc.restoreParagraphLayout({source:text,outputText:text,mode:'polish',documentProfile:'report_assignment'});
 assert.equal(polish.text,text);
});
