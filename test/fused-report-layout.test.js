'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {repairFusedReportLayout:repair}=require('../engine-gpt-prod/fusedReportLayout');
const preflight=require('../engine-gpt-prod/sourcePreflight');
const prefix='과제명: 지역 관찰 보고서교과목: 사회 분석작성자: 연구팀제출일자: 2030년 5월 20일';
const source=prefix+'1. 자료 조사기사명: 공개 자료(https://example.org/article?id=123)2. 지역 현황[관찰 현황]현장의 특징을 살펴보았다.[주요 특징]자연 조건에 따라 결과가 달라졌다.3. 종합 의견추가 자료가 필요하다는 의견을 제시하였다.';
test('explicit metadata, sequential sections and bracket headings split without changing text',()=>{
 const out=repair(source).text;
 assert.match(out,/보고서\n교과목/u);assert.match(out,/20일\n1\./u);
 assert.match(out,/id=123\)\n2\./u);assert.match(out,/\[관찰 현황\]\n현장/u);
 assert.equal(out.replace(/\s/gu,''),source.replace(/\s/gu,''));
 assert.equal(repair(out).text,out);
 const pre=preflight.auditAndSanitizeSource(source);
 assert.match(pre.text,/\n교과목/u);assert.match(pre.text,/\n2\./u);
});
test('ordinary prose, incomplete metadata, nonsequential lists and code stay unchanged',()=>{
 for(const text of [source.replace('과제명:','본문: '),source.replace('작성자:','연구자 '),source.replace('3. 종합','5. 종합'),'```\n'+source+'\n```'])assert.equal(repair(text).text,text);
});
test('quoted labels and bracket references are not split',()=>{
 const text=prefix+'1. 자료 조사"교과목: 시범 [특징 설명]자료"를 읽었다.2. 분석 [주요 특징]은 앞 절의 표현이다.3. 결론 여러 근거를 비교했다.';
 assert.ok(repair(text).text.includes('"교과목: 시범 [특징 설명]자료"'));
 assert.ok(repair(text).text.includes('[주요 특징]은'));
});

test('dotted calendar dates do not become sequential section numbers',()=>{
 const text=source.replace('2030년 5월 20일','2030. 5. 20. ');
 assert.match(repair(text).text,/2030\. 5\. 20\. \n1\./u);
});

test('bracket references followed by compound particles stay inline',()=>{
 for(const particle of ['으로','에서','에게','만','까지','에서는','에는','처럼']){
  const text=prefix+`1. 소개 내용이다.2. 분석 [주요 특징]${particle} 알 수 있다.3. 결론 내용을 정리했다.`;
  assert.ok(repair(text).text.includes(`분석 [주요 특징]${particle}`),particle);
 }
});

test('label restoration and final audit use source-derived field boundaries',()=>{
 const sc=require('../engine-gpt-prod/structureChunk');
 const output=preflight.auditAndSanitizeSource(source).text;
 assert.equal(sc.compareInlineLabelBodyLayout(source,output).pass,true);
 assert.equal(sc.restoreInlineLabelBodyLayout(source,output).text,output);
 assert.equal(sc.compareInlineLabelBodyLayout(source,output.replace('작성자: 연구팀\n','')).pass,false);
 assert.equal(sc.compareInlineLabelBodyLayout(source,output.replace(/\n/gu,' ')).pass,false);
});

test('production preflight normalizes CRLF before report anchors and is idempotent',()=>{
 const text=source.replace('2. 지역','\r\n2. 지역');
 const output=preflight.auditAndSanitizeSource(text).text;
 assert.ok(!output.includes('\r'));
 assert.equal(preflight.auditAndSanitizeSource(output).text,output);
 const r=repair(source);let recovered=r.text;
 for(let i=r.insertedOffsets.length-1;i>=0;i--){const p=r.insertedOffsets[i]+i;assert.equal(recovered[p],'\n');recovered=recovered.slice(0,p)+recovered.slice(p+1);}
 assert.equal(recovered,source);
});
