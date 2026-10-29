'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pre=require('../engine-gpt-prod/sourcePreflight'),layout=require('../engine-gpt-prod/layoutStructure');
const {groundViolation}=require('../engine-gpt-prod/judge');
const {confirmedMicroRepair:micro}=require('../engine-gpt-prod/confirmedMicroRepair');
const {restoreConfirmedRelations:restore}=require('../engine-gpt-prod/confirmedRelationRestore');
const finding=(a,b)=>groundViolation({type:'distortion',origin:'introduced',relation:'modality_negation_causality',sourceSpan:a,candidateSpan:b,span:b},a,b);

test('numbered report prose with wide sentence gaps remains editable; tables stay locked',()=>{
 const rows=[1,2,3].map(n=>`${n}. 현장 관찰의 기록: 연구팀은 매일 같은 장소를 방문하여 주변의 변화를 자세하게 관찰했습니다.   관찰한 내용은 조사표에 기록하고 다음 날의 결과와 비교하여 차이를 정리했습니다.`);
 const text='[관찰 보고서] '+rows.join(' '),prepared=pre.auditAndSanitizeSource(text).text;
 assert.equal(prepared.replace(/\s/gu,''),text.replace(/\s/gu,''));
 assert.equal(layout.buildLineRecords(prepared).filter(r=>r.role==='table').length,0);
 const plan=require('../engine-gpt-prod/structureChunk').splitChunksForGpt(prepared,{coalesceEditable:true,preserveLineBoundaries:'structural'});
 assert.equal(plan.chunks.filter(c=>!c.locked).length,3);
 assert.ok(plan.chunks.filter(c=>!c.locked).every(c=>c.text.includes('관찰한 내용')));
 for(const sep of ['\t','   ']){
   const table=['번호'+sep+'설명', '1. 관찰'+sep+'완료', '2. 기록'+sep+'대기'].join('\n');
   assert.ok(layout.buildLineRecords(table).filter(r=>r.role==='table').length>=2);
 }
 const tabbed=rows.map(r=>r.replace('   ','\t')).join('\n');
 assert.equal(layout.buildLineRecords(tabbed).filter(r=>r.role==='table').length,3);
});

test('attested reflection ending is restored while retaining the rewritten proposition',()=>{
 const a='현장 관찰에서는 주변 상황을 미리 파악하는 세심함과 정확한 기록이 중요하다는 것을 알게 되었습니다.';
 const b='현장을 관찰할 때는 주변 상황을 미리 파악하는 세심함과 정확한 기록도 중요합니다.';
 const f=finding(a,b),expected=b.replace('중요합니다.','중요하다는 것을 알게 되었습니다.');
 assert.equal(micro(a,b,f),expected);
 assert.equal(restore(a,b,{pass:false,violations:[f]},{preferSourceWindows:true}).text,expected);
 const c='좋은 조사를 진행하려면 혼자 기록하는 것보다 다른 연구자들과 소통하고 협력하는 과정이 핵심이라는 점을 새롭게 배웠습니다.';
 const d='좋은 조사를 진행하려면 혼자 기록하기보다 다른 연구자들과 소통하고 협력하는 과정이 핵심입니다.';
 assert.equal(micro(c,d,finding(c,d)),d.replace('핵심입니다.','핵심이라는 점을 새롭게 배웠습니다.'));
 for(const f2 of [{...f,origin:'source_issue'},{...f,spanVerified:false},{...f,span:'다른 내용'}]) assert.equal(micro(a,b,f2),'');
 assert.equal(micro('“'+a+'”',b,f),'');
 assert.equal(micro(a,b.replace('중요합니다','필요합니다'),f),'');
 assert.equal(micro(a,b+' '+b,f),'');
});

test('exact retained concession clause keeps its surrounding candidate sentences',()=>{
 const a='추가 조사를 하면 새로운 자료를 얻을 수 있지만, 조사 과정에서 기존의 환경이 달라지기도 한다.';
 const b='보고서는 조사 방법을 돌아보게 했다. 조사 과정에서 기존의 환경이 달라지기도 한다. 조사를 서둘러도 좋은 결과가 보장되지는 않는다.';
 const expected=b.replace('조사 과정에서 기존의 환경이 달라지기도 한다.',a),f=finding(a,b);
 assert.equal(micro(a,b,f),expected);
 const context=' 담당자는 현재의 장비 상태를 기록하고 다음 회의를 준비했다.'.repeat(10);
 assert.equal(restore(a+context,b+context,{pass:false,violations:[f]},{preferSourceWindows:true}).text,expected+context);
 assert.equal(micro(a,b.replace('달라지기도','달라진다고'),f),'');
 assert.equal(micro(a,'“'+b+'”',f),'');
});

test('detached PDF punctuation loses false line anchors without losing source characters',()=>{
 const rows=[
  '현장을 조사한 기록은 여러 연구자가 함께 비교한다 주변 환경을 살피는 동안에는',
  '.', '관찰한 내용을 자세하게 기록한다 또한 다음 날에 방문하는 연구자들에게는',
  ',', '앞서 확인했던 사항을 전달한다 이러한 자료는 장기간의 변화를 검토하는 데',
  '.', '활용된다 연구팀은 새로운 사실을 임의로 보충하지 않고 확인된 내용만 기록한다',
  ',', '결과를 검토할 때에는 원본 자료에 남은 문장부호와 단어도 함께 확인해야 한다.'
 ];
 const source=rows.join('\n'),repair=require('../engine-gpt-prod/detachedPunctuationLayout').repairDetachedPunctuationLayout;
 const r=repair(source);assert.equal(r.changes.length,1);
 assert.equal(r.text.replace(/\s/gu,''),source.replace(/\s/gu,''));
 assert.equal(r.text.includes('\n'),false);assert.equal(repair(r.text).text,r.text);
 assert.ok(pre.auditAndSanitizeSource(source).issueCodes.includes('source_detached_punctuation_review'));
 for(const input of ['```\n'+source+'\n```',source.replace('현장을','1. 현장을'),source.replace('관찰한 내용을','항목\t관찰한 내용을'),source.replaceAll('\n.\n','\n')])assert.equal(repair(input).text,input);
 const poem='하늘을 본다\n.\n바람이 분다\n,\n다시 걷는다\n.\n문을 연다\n,';
 assert.equal(repair(poem).text,poem);
});
