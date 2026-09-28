'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {restoreConfirmedRelations}=require('../engine-gpt-prod/confirmedRelationRestore');
const {sentenceSimilarity}=require('../engine-gpt-prod/sentenceAlignment');
const before='측정 장비를 실제로 조작하지 않았다면 기존 방법이 가장 적절하다고 계속 생각했을 것이다.';
const after='다음 실험에서는 측정 장치를 모두 점검하고 관측 기록을 실험 일지에 자세히 정리했다.';
const tail='추가 분석에서는 실험실의 온도와 조도 조건을 일정하게 유지하며 장비의 반응을 관찰했다.';
const a='실험 장비의 예상 밖 성능을 확인한 뒤 새로운 측정법을 직접 시험해보고 싶어졌다.';
const b='뜻밖의 결과는 다른 측정법에도 관심을 돌리게 했다.';
const report=()=>({pass:false,uncertain:false,verificationCompleted:true,violations:[{
  type:'distortion',origin:'introduced',relation:'modality_negation_causality',
  sourceSpan:a,candidateSpan:b,span:b,spanVerified:true,relationGrounded:true,
  repairable:true,grounding:'unique_exact_span'
}]});
const document=(sentence,pre=before,post=after)=>[pre,sentence,post,tail].join(' ');

test('confirmed low-surface pair uses two unique strong neighbouring anchors, never grants a verdict',()=>{
  assert.ok(sentenceSimilarity(a,b)<.35);
  const r=restoreConfirmedRelations(document(a),document(b),report());
  assert.equal(r.text,document(a));assert.equal(r.restoredCount,1);
  assert.equal(r.pass,undefined);
});

test('one anchor, different neighbouring claim, reordered or duplicate anchors cannot authorize repair',()=>{
  const source=document(a);
  for(const output of [
    [b,after,tail].join(' '),
    document(b,'기온이 크게 내려가자 연구팀은 다른 지역의 기후를 조사하기 시작했다.'),
    document(b,after,before),
    document(b)+' '+before,
    document(b,before,'인접한 다른 연구에서는 동물의 먹이와 서식 환경을 집중적으로 관찰했다.')
  ])assert.equal(restoreConfirmedRelations(source,output,report()).applied,false);
  assert.equal(restoreConfirmedRelations(source+' '+after,document(b),report()).applied,false);
});

test('unconfirmed evidence and multi-sentence windows cannot use the anchor alternative',()=>{
  for(const override of [{uncertain:true},{verificationCompleted:false},{pass:true}])
    assert.equal(restoreConfirmedRelations(document(a),document(b),{...report(),...override}).applied,false);
  const r=report();r.violations[0].relationGrounded=false;
  assert.equal(restoreConfirmedRelations(document(a),document(b),r).applied,false);
  const second='연구원은 관찰 기록을 나중에 검토할 계획이었다.';
  const changed='기록에 대한 검토는 곧 끝났다.';
  const multi=report();multi.violations[0].sourceSpan=a+' '+second;
  multi.violations[0].candidateSpan=b+' '+changed;
  assert.ok(sentenceSimilarity(a+' '+second,b+' '+changed)<.35);
  assert.equal(restoreConfirmedRelations(document(a+' '+second),document(b+' '+changed),multi).applied,false);
});

test('heading-bearing neighbours and altered protected quotations remain ineligible',()=>{
  assert.equal(restoreConfirmedRelations(document(a,'1. 새로운 절\n'+before),document(b,'1. 새로운 절\n'+before),report()).applied,false);
  const qa=a+' “관측값”이라고 적었다.',qb=b+' “측정값”이라고 적었다.';
  const r=report();r.violations[0].sourceSpan=qa;r.violations[0].candidateSpan=qb;
  assert.equal(restoreConfirmedRelations(document(qa),document(qb),r).applied,false);
});

test('optional anchor search has bounded document and anchor sizes',()=>{
  const padding=Array.from({length:260},(_,i)=>`관찰 번호 ${i}에 해당하는 추가 기록을 검토했다.`).join(' ');
  assert.equal(restoreConfirmedRelations(document(a)+' '+padding,document(b)+' '+padding,report()).applied,false);
  const longBefore='측정 장비의 안정성을 확인하기 위한 추가적인 관찰 내용을 '.repeat(20)+'기록했다.';
  assert.equal(restoreConfirmedRelations(document(a,longBefore),document(b,longBefore),report()).applied,false);
});
