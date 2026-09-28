'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hasOutsideSourceContribution:outside}=require('../engine-gpt-prod/restorationOwnership');
const {restoreConfirmedRelations:restore}=require('../engine-gpt-prod/confirmedRelationRestore');
const {groundViolation}=require('../engine-gpt-prod/judge');
const a='그럴 때에는 연구자가 모르는 것이 있다는 사실을 받아들이고 싶다.';
const b='기존 이론만 고집하기보다 필요할 때는 실험 방법을 바꿀 수 있는 연구자로 성장하고 싶다.';
const c='새로운 측정 기술도 다른 분야의 일이라고 넘기지 않으려 한다.';
const merged='모르는 것이 있다는 사실을 받아들이고, 기존 이론만 고집하지 않으며 필요할 때 실험 방법을 바꿀 줄 아는 연구자로 성장하고 싶다.';
const tail=' 별도의 수치는 자료실에 보관한다. 다음 조사는 정해진 일정에 따라 진행한다.'.repeat(15);
const finding=(source,output,sourceSpan,candidateSpan)=>groundViolation({type:'distortion',span:candidateSpan,sourceSpan,candidateSpan,
 relation:'condition_result',origin:'introduced'},source,output);

test('a one-source/multi-claim merged window cannot copy one sentence and erase its neighbor',()=>{
 const source=a+' '+b+' '+c+tail,output=merged+' '+c+tail;
 assert.equal(outside(source,0,a.length,merged,a),true);
 assert.equal(restore(source,output,{pass:false,violations:[finding(source,output,a,merged)]}).applied,false);
});
test('repairing an omission must not overwrite the surviving next sentence and create a new omission',()=>{
 const source=a+' '+b+' '+c+tail,output=a+' '+c+tail;
 const v=finding(source,output,a+' '+b,a+' '+c);
 assert.equal(restore(source,output,{pass:false,violations:[v]}).applied,false);
});
test('a correctly bounded two-source relation repair is still available',()=>{
 const source=a+' '+b+' '+c+tail,output=merged+' '+c+tail;
 assert.equal(outside(source,0,(a+' '+b).length,merged,a+' '+b),false);
 assert.equal(restore(source,output,{pass:false,violations:[finding(source,output,a+' '+b,merged)]}).text,source);
});
test('a short adjacent outcome is not erased merely because it has fewer than eight grams',()=>{
 const a='담당자는 실험을 다시 시작하고 결과를 기다렸다.';
 const b='그러나 실패했다.';
 const source=a+' '+b;
 const merged='담당자는 실험을 다시 시작하고 결과를 기다렸으나 실패했다.';
 assert.equal(outside(source,0,a.length,merged,a),true);
 assert.equal(outside(source,0,source.length,merged,source),false);
});
test('same-topic neighboring words do not veto a fully owned sentence split',()=>{
 const source='측정 결과가 불안정할 때에는 장비를 다시 점검하고 센서를 바꿀 수 있다. 다음 측정도 같은 장비를 사용한다.';
 const original=source.split('. ')[0]+'.';
 const candidate='측정 결과가 불안정하면 장비를 다시 점검한다. 센서도 바꾼다.';
 assert.equal(outside(source,0,original.length,candidate,original),false);
});

test('an unchanged unique leading heading does not block a grounded first-sentence repair',()=>{
 const title='① 첫 번째 관찰 기록\n';
 const a=title+'담당자는 기온이 낮아 배관이 얼었다는 사실을 확인했다.';
 const b=title+'담당자는 기온이 낮고 배관이 얼었다는 사실을 확인했다.';
 const source=a+tail,output=b+tail;
 assert.equal(restore(source,output,{pass:false,violations:[finding(source,output,a,b)]}).text,source);
 assert.equal(restore(source,output,{pass:false,violations:[finding(source,output,a.slice(title.length),b.slice(title.length))]}).text,source);
 for(const otherTitle of ['② 다른 관찰 기록\n','']){
   const changed=otherTitle+b.slice(title.length)+tail;
   assert.equal(restore(source,changed,{pass:false,violations:[finding(source,changed,a,otherTitle+b.slice(title.length))]}).applied,false);
 }
 const repeated=output+'\n'+title+'다른 본문이다.';
 assert.equal(restore(source,repeated,{pass:false,violations:[finding(source,repeated,a,b)]}).applied,false);
 assert.equal(restore(source,repeated,{pass:false,violations:[finding(source,repeated,a.slice(title.length),b.slice(title.length))]}).applied,false);
});
