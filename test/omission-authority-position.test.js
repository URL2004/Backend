'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreConfirmedSemanticOmissions:restore}=require('../engine-gpt-prod/omissionRestore');
const {groundViolation}=require('../engine-gpt-prod/judge');
const A='동아리에서는 참여자들과 함께 여러 활동을 준비했다.';
const B='처음 해본 작업은 스스로를 알아가는 데 필요한 시간이었다.';
const M='관찰 기록을 정리하면서 나의 관심 분야를 보다 구체적으로 이해할 수 있었다.';
const N='지역 자료실에서 신문 기사를 읽고 필요한 정보를 정리했다.';
const Z='다음 학기에도 같은 활동을 꾸준히 이어갈 생각이다.';
test('explicitly ungrounded or unrepairable omission never authorizes keyword insertion',()=>{
 const source=[A,M,Z].join('\n\n'),output=[A,Z].join('\n\n');
 for(const flags of [{repairable:false},{relationGrounded:false},{origin:'unconfirmed'}]){
  const finding={type:'omission',span:M,detail:'관심 분야를 이해한 경험이 빠졌다.',...flags};
  const r=restore({source,outputText:output,semanticReport:{pass:false,violations:[finding]}});
  assert.equal(r.text,output);assert.equal(r.restoredCount,0);
  assert.deepEqual(r.remainingViolations,[finding]);
 }
});
test('near successor anchors a recovered paragraph lead instead of a remote predecessor',()=>{
 const source=[A,B,M,N,Z].join('\n\n');
 const rewritten='낯설었던 경험 덕분에 자신을 돌아보게 됐다.';
 const output=[A,rewritten,N,Z].join('\n\n');
 const finding=groundViolation({type:'omission',span:M,sourceSpan:M,candidateSpan:N,
  detail:'관심 분야를 이해한 경험이 빠졌다.',relation:'other',origin:'introduced'},source,output);
 const r=restore({source,outputText:output,semanticReport:{pass:false,uncertain:false,violations:[finding]}});
 assert.equal(r.restoredCount,1);assert.equal(r.restored[0].anchorType,'before_next');
 assert.ok(r.text.indexOf(M)>r.text.indexOf(rewritten));
 assert.ok(r.text.indexOf(M)<r.text.indexOf(N));
 assert.equal(r.text.split(M).length,2);
});

test('adjacent anchor ties preserve final-sentence paragraph ownership',()=>{
 const source=A+' '+M+'\n\n'+N+' '+Z,output=A+'\n\n'+N+' '+Z;
 const r=restore({source,outputText:output,semanticReport:{pass:false,violations:[{type:'omission',span:M}]}});
 assert.equal(r.restoredCount,1);assert.equal(r.restored[0].anchorType,'after_previous');
 assert.ok(r.text.startsWith(A+' '+M));
});

test('two consecutive omissions keep source order when recovered iteratively',()=>{
 const source=[A,B,M,N,Z].join(' '),output=[A,N,Z].join(' ');
 const r=restore({source,outputText:output,semanticReport:{pass:false,violations:[
  {type:'omission',span:B},{type:'omission',span:M}]}});
 assert.equal(r.restoredCount,2);assert.equal(r.text,source);
});

test('distant anchors cannot insert across unknown intervening source sentences',()=>{
 const source=[A,B,M,N,Z].join(' '),output=[A,Z].join(' ');
 const finding={type:'omission',span:M};
 const r=restore({source,outputText:output,semanticReport:{pass:false,violations:[finding]}});
 assert.equal(r.text,output);assert.deepEqual(r.remainingViolations,[finding]);
});
