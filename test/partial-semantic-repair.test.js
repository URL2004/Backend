'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {canRetainPartialSemanticRepair:accept}=require('../engine-gpt-prod/partialSemanticRepair');
const {bindSemanticValidation:bind}=require('../engine-gpt-prod/semanticProvenance');
const o=require('../engine-gpt-prod/semanticObligations');
const a='관측값을 보아도 곧바로 결론을 확정하지 않았다.',b='관측값을 보아도 결론을 확정하지 않았다.';
const c='수행하기 위한 과정은 추가 자료를 확인하는 단계였다.',d='수행하는 과정은 추가 자료를 확인하는 단계였다.';
const source=a+' '+c,before=b+' '+d,candidate=a+' '+d;
const finding=(sourceSpan,candidateSpan)=>({type:'distortion',relation:'modality_negation_causality',origin:'introduced',sourceSpan,candidateSpan,span:candidateSpan,spanVerified:true,sourceSpanVerified:true,relationGrounded:true,repairable:true,grounding:'unique_exact_span'});
const f=finding(a,b),g=finding(c,d),previous={violations:[f,g]};
const next=()=>bind({ran:true,pass:false,uncertain:false,violations:[g],obligationReviews:[{id:o.obligationId(f),status:'resolved'}]},source,candidate);
test('verified local progress can survive an unchanged unrelated error without claiming pass',()=>{
 const n=next();assert.equal(accept(source,before,candidate,previous,n),true);assert.equal(n.pass,false);
});
test('new, ungrounded, unreviewed, repeated, stale and incomplete repairs are not retained',()=>{
 for(const mutate of [n=>n.uncertain=true,n=>n.verificationCompleted=false,n=>n.obligationReviews=[],
  n=>n.violations=[{...g,sourceSpan:a}],n=>n.violations=[{...g,candidateSpan:a}],
  n=>n.violations=[{...g,repairable:false}],n=>n.validation.candidateDigest='wrong']){
  const n=next();mutate(n);assert.equal(accept(source,before,candidate,previous,n),false);
 }
 assert.equal(accept(source,before+' '+d,candidate,previous,next()),false);
 assert.equal(accept(source,before,before,previous,next()),false);
});
