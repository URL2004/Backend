'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const q=require('../engine-gpt-prod/koreanRefinement');
const args=(source,outputText)=>({source,outputText,documentProfile:{profile:'report_assignment'}});

test('comparative copula after quoted noun stays attached and repairs converge',()=>{
 for(const [open,close] of [['‘','’'],['“','”'],['「','」'],['『','』'],['《','》']]) {
  for(const ending of ['이라기보다','이라기보다는','이라기보단','라기보다']) {
   const correct=`이는 ${open}상태의 변화${close}${ending} 관찰 결과에 가깝다.`;
   const input=correct.replace(close+ending,close+' '+ending);
   const repaired=q.applySafeFormattingRepairs(args(correct,input)).text;
   assert.equal(repaired,correct);
   assert.equal(q.applySafeFormattingRepairs(args(correct,repaired)).text,correct);
   assert.equal(q.applySafeDeterministicRepairs(args(correct,repaired)).text,correct);
  }
 }
});

test('quote boundary spacing does not modify code or interior nested quotations',()=>{
 for(const text of ['`‘변화’ 이라기보다`','```txt\n‘변화’ 이라기보다\n```','“문구에는 ‘변화’ 이라기보다라고 적혀 있었다.”']) {
  assert.equal(q.applySafeDeterministicRepairs(args(text,text)).text,text);
  assert.equal(q.applySafeFormattingRepairs(args(text,text)).text,text);
 }
 const mixed='‘항목A\', ’항목B\', ‘항목C\'의 차이를 비교한다.';
 assert.equal(q.applySafeFormattingRepairs(args(mixed,mixed)).text,mixed);
});

test('source-proven evidential frame restores only the changed prefix',()=>{
 const source='이번 조사를 통해 수분은 용기의 재질에 따라 이동 속도가 달라진다고 결론 내렸다.';
 const output='이번 조사에서는 수분은 용기의 재질에 따라 이동 속도가 달라진다고 결론 내렸다.';
 assert.ok(q.analyzeKoreanRefinement(args(source,output)).issueCodes.includes('introduced_evidential_topic_frame'));
 assert.equal(q.applySafeDeterministicRepairs(args(source,output)).text,source);
});

test('normal scope, contrast topics and ambiguous source matches are preserved',()=>{
 const valid='이번 연구에서는 온도는 일정하게 두고 압력은 단계적으로 조절했다고 결론 내렸다.';
 assert.equal(q.applySafeDeterministicRepairs(args(valid,valid)).text,valid);
 const source='이번 연구를 통해 온도는 일정하게 두었다고 결론 내렸다.';
 const contrast='이번 연구에서는 온도는 일정하게 두었지만 반면 압력은 변화시켰다고 결론 내렸다.';
 assert.equal(q.applySafeDeterministicRepairs(args(source,contrast)).text,contrast);
 const output=source.replace('연구를 통해','연구에서는');
 assert.equal(q.applySafeDeterministicRepairs(args(source+' '+source,output)).text,output);
});

test('one-to-many reflection alignment uses the unique proposition, not generic lexical overlap',()=>{
 const source='처음에는 모든 자극을 없애야 한다고 생각했지만, 자극도 정상적인 감각 정보 전달에 사용된다는 점을 알게 되면서 생각이 달라졌다.';
 const output='처음에는 모든 자극을 없애야 한다고 생각했다. 하지만 자극도 정상적인 감각 정보 전달에 사용된다는 점은 생각을 바꾸었다.';
 const fixed=q.applySafeDeterministicRepairs(args(source,output));
 assert.equal(fixed.text,output.replace('점은 생각을 바꾸었다','점을 알게 되면서 생각이 달라졌다'));
 assert.ok(q.analyzeKoreanRefinement(args(source,output)).issueCodes.includes('introduced_reflection_agency_shift'));
 assert.equal(q.applySafeDeterministicRepairs(args(source,fixed.text)).applied,false);
});

test('reflection repair needs source experience and cannot alter quoted or ambiguous statements',()=>{
 const original='자극도 정상적인 감각 정보 전달에 사용된다는 점을 알게 되면서 생각이 달라졌다.';
 const candidate='자극도 정상적인 감각 정보 전달에 사용된다는 점은 생각을 바꾸었다.';
 for(const source of [candidate,original+' '+original,'정보 전달에 자극이 사용된다.']) {
  assert.equal(q.applySafeDeterministicRepairs(args(source,candidate)).text,candidate);
 }
 assert.equal(q.applySafeDeterministicRepairs(args('“'+original+'”','“'+candidate+'”')).text,'“'+candidate+'”');
});
