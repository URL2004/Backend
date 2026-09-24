'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compareLineAnchorLayout:anchors,compareOriginalStructuralMarkers:markers,compareStructuralRoleSignatures:roles}=require('../engine-gpt-prod/structureChunk');
const source='Materials   and   Methods  1)   재료   및   기구  시료 :   밀가루를   사용하였다.   시료는   밀폐   상태로   보관하였다.  기구 :   저울과   용기를   사용하였다.';
const output='Materials and Methods\n1) 재료 및 기구\n시료: 밀가루를 사용하였다. 시료는 밀폐 상태로 보관하였다.\n기구: 저울과 용기를 사용하였다.';
test('packed PDF anchors can regain boundaries without an escalation for invented structure',()=>{
 assert.equal(anchors(source,output).pass,true);assert.equal(markers(source,output).pass,true);
 assert.equal(roles(source,output).pass,true);
 assert.equal(markers(source,output).source[0].lineOrdinal,1,'diagnostics retain original source line ownership');
});

test('packed title recovery cannot flatten a separate tab table or hide its column loss',()=>{
 const table='\n항목\t수치\t단위\n질량\t25\tg\n부피\t30\tml';
 assert.equal(roles(source+table,output+table).tableColumnOwnershipPass,true);
 assert.equal(roles(source+table,output+table.replace('25\tg','25 g')).tableColumnOwnershipPass,false);
});
test('duplicate, renamed, renumbered and quote-derived anchors are still additions',()=>{
 for(const changed of [output+'\n1) 재료 및 기구',output.replace('1)','2)'),output.replace('재료 및 기구','새로운 결론')]) {
  assert.ok(anchors(source,changed).additions.length>0 || markers(source,changed).additions.length>0);
 }
 assert.ok(anchors('“'+source+'”',output).additions.length>0);
});
test('ordinary prose and arbitrary mid-sentence phrases cannot become titles',()=>{
 assert.ok(anchors('연구 목적은 실험 결과를 비교하는 것이다.','연구 목적\n실험 결과를 비교하는 것이다.').additions.length>0);
 const packed='분석은   시료의   구성과   보관   상태를   확인하고   반복   실험   결과를   비교하는   과정이다.';
 assert.ok(anchors(packed,'반복 실험 결과\n분석은 시료의 구성과 보관 상태를 확인한다.').additions.length>0);
});
test('packed bracket labels and compact numbering retain identifiers, not numeric decimals',()=>{
 const a='3.Results  <측정 1>  첫   시료를   측정한   결과   질량은   35.0795   g으로   기록되었다.  <측정 2>  다음   시료도   같은   방식으로   측정하였다.';
 const b='3. Results\n<측정 1>\n첫 시료를 측정한 결과 질량은 35.0795 g으로 기록되었다.\n<측정 2>\n다음 시료도 같은 방식으로 측정하였다.';
 assert.equal(anchors(a,b).pass,true);assert.equal(markers(a,b).pass,true);
 assert.equal(markers('35.0795 g이다.','35.0795 g이다.').source.length,0);
 assert.equal(markers('2.2에서는 원인을 검토한다.','2.2에서는 원인을 검토한다.').source.length,0);
 assert.ok(markers(a,b.replace('3. Results','4. Results')).losses.length>0);
});
