'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {applySafeDeterministicRepairs:repair,applySafeFormattingRepairs:format,analyzeKoreanRefinement:audit}=require('../engine-gpt-prod/koreanRefinement');
test('academic contractions expand without changing tense or certainty before final audit',()=>{
 const source='측정이 반복되었다. 다른 조건에서 진행되었으며 결과는 같았다.';
 const output='측정이 반복됐다. 다른 조건에서 진행됐으며 결과는 같았다.';
 const args={source,outputText:output,documentProfile:'report_assignment'};
 const r=repair(args);assert.equal(r.text,source);
 assert.equal(audit({...args,outputText:r.text}).issues.find(x=>x.code==='formal_register_residual')?.afterCount||0,0);
 assert.equal(repair({...args,outputText:r.text}).applied,false);
 assert.equal(format(args).text,output,'final whitespace pass must not make lexical edits');
});
test('quotes, inline and fenced code retain academic contractions',()=>{
 const text='그는 “됐다”고 말했다. 「측정됐으며」와 `됐다`를 기록했다.\n```txt\n실행됐다.\n```\n측정됐다.';
 assert.equal(repair({source:text,outputText:text,documentProfile:'academic_paper'}).text,text.replace(/측정됐다\.$/u,'측정되었다.'));
});
test('personal voice, creative text and uncertain genre are not formalized',()=>{
 const text='준비가 됐다. 참 잘됐다.';
 for(const documentProfile of ['personal_essay','creative','general','unknown'])assert.equal(repair({source:text,outputText:text,documentProfile}).text,text);
});
test('formal reason wording keeps uncertainty and authenticity contrasts',()=>{
 const text='진짜 이유는 시간이 부족했기 때문일 가능성이 크다. 진짜와 가짜를 구분했다. “진짜 이유는 모른다”는 응답도 있었다.';
 assert.equal(repair({source:text,outputText:text,documentProfile:'report_assignment'}).text,text.replace('진짜 이유는','실제 이유는'));
});
