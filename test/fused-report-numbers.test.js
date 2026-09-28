'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compareNumberMultiset:compare,extractNumberTokens:tokens}=require('../engine-gpt-prod/factAudit');
const {repairFusedReportLayout:repair}=require('../engine-gpt-prod/fusedReportLayout');
const source='과제명: 관찰 보고서교과목: 자료 분석작성자: 연구팀제출일자: 2030년 5월 20일'
 +'1. 현황 높이는 15m이다.2. 분석 비율은 30%이다.3. 결론 표본은 12개이다.';
test('cover date adjacent to a section number has identical numeric tokens after layout repair',()=>{
 const output=repair(source).text;
 assert.equal(compare(source,output).changed,false);
 assert.ok(tokens(source).includes('20일'));
 assert.deepEqual(tokens(source),tokens(output));
});
test('real date, value, unit, section number and duplicate mutations still fail',()=>{
 const output=repair(source).text;
 for(const changed of [output.replace('20일','21일'),output.replace('15m','16m'),
   output.replace('15m','15km'),output.replace('3. 결론','4. 결론'),output+' 12개']){
  assert.equal(compare(source,changed).changed,true,changed);
 }
});
test('ordinary numeric extraction is unchanged outside the explicit report contract',()=>{
 assert.deepEqual(tokens('기한은 20일이다. 길이 15m, 비율 30%, 표본 12개.'),['20일','15m','30%','12개']);
 assert.equal(compare('높이는 15m이다.','높이는 15km이다.').changed,true);
});
