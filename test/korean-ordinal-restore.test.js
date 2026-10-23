'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {restoreMissingOrdinalMarkers:restore}=require('../engine-gpt-prod/koreanOrdinal');
const {compareOriginalStructuralMarkers:compare}=require('../engine-gpt-prod/structureChunk');
const source='검토할 내용이 남았다. 첫째, 초기의 실험 과정에서 확인한 측정 오차를 설명한다.\n\n둘째, 추가 실험 결과를 검토한다.\n\n셋째, 남은 연구 과제를 정리한다.';
test('restore a missing first marker at its exact source-backed sentence boundary',()=>{
 const output=source.replace('첫째, ',''), result=restore(source,output);
 assert.equal(compare(source,output).pass,false);
 assert.equal(result.text,source); assert.equal(result.repairCount,1);
 assert.equal(compare(source,result.text).pass,true);
 assert.equal(restore(source,result.text).repairCount,0);
});
test('ambiguous anchors, changed bodies, reordering, and no surviving list do not restore',()=>{
 const output=source.replace('첫째, ','');
 for(const candidate of [output+' 초기의 실험 과정에서 확인한 측정 오차를 설명한다.',output.replace('초기의 실험 과정에서 확인한','최초 관측에서 발견한'),output.replace('셋째,','둘째,'),output.replace(/둘째, |셋째, /g,'')]) {
  assert.deepEqual(restore(source,candidate),{text:candidate,repairCount:0});
 }
});
test('never insert into code, quotes, a phrase, or a family narrative',()=>{
 for(const candidate of ['~~~\n'+source.replace('첫째, ','')+'\n~~~', '“'+source.replace('첫째, ','')+'”',source.replace('첫째, ','여기서는 '),'첫째 아이가 집에 왔다. 둘째 아이도 돌아왔다.']) assert.equal(restore(source,candidate).repairCount,0);
});

test('ordinal repair count persists without source text',()=>{
 const {compactHistoryEngineMeta:compact}=require('../lib/historyService');
 assert.equal(compact({ordinalMarkerRestoreCount:1}).ordinalMarkerRestoreCount,1);
 assert.equal(compact({}).ordinalMarkerRestoreCount,undefined);
});

test('an exact item-count header anchors a list whose every prefix was lost',()=>{
 const header='검토할 과제는 두 가지이다.';
 const first='초기 실험에서 관측한 측정 오차를 원인별로 설명한다.';
 const second='후속 연구에 사용할 통계 자료의 수집 범위를 검토한다.';
 const original=`${header} 첫째, ${first} 둘째, ${second}`;
 const candidate=`${header} 먼저 ${first} 또한 ${second}`;
 const result=restore(original,candidate);
 assert.equal(result.text,original); assert.equal(result.repairCount,2);
 assert.equal(restore(original,result.text).repairCount,0);
 for(const unsafe of [
   candidate.replace(header,'검토할 과제를 설명한다.'),
   `${header} 또한 ${second} 먼저 ${first}`,
   candidate+` ${first}`,
   `“${candidate}”`,
   candidate.replace(' 또한 ','\n\n또한 ')
 ]) assert.equal(restore(original,unsafe).repairCount,0,unsafe);
});
