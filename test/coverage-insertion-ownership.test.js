'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreMissingClaimsLocally:restore}=require('../engine-gpt-prod/resumeCoverage');
const a='담당자와 함께 장비 점검을 마쳤습니다.',b='낯선 환경에도 관심을 갖고 새로운 방법을 배우려 합니다.',c='궁금한 내용은 동료에게 물어보겠습니다.';
const audit={applicable:true,pass:false,repairTargets:[{sourceSentence:b,previousContext:a,nextContext:c,types:['action'],sourceIndex:1}]};
test('a possibly paraphrased occupied gap cannot receive a duplicate source claim',()=>{
 const output=a+' 처음 보는 도구라도 지나치지 않고 사용법을 익히고 싶습니다. '+c;
 assert.equal(restore({source:a+' '+b+' '+c,currentOutput:output,audit}).text,output);
 const empty=restore({source:a+' '+b+' '+c,currentOutput:a+' '+c,audit});
 assert.equal(empty.applied,true);assert.equal(empty.text,a+' '+b+' '+c);
});
test('a source-final claim is not appended over an occupied candidate tail',()=>{
 const final={...audit,repairTargets:[{...audit.repairTargets[0],nextContext:''}]};
 const output=a+' 처음 보는 도구라도 지나치지 않고 사용법을 익히고 싶습니다.';
 assert.equal(restore({source:a+' '+b,currentOutput:output,audit:final}).text,output);
 assert.equal(restore({source:a+' '+b,currentOutput:a,audit:final}).text,a+' '+b);
});
