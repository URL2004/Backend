'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../engine-gpt-prod/semanticObligations');
const source='검사자는 최초 관찰만으로 곧바로 결과를 확신하지 않았다.';
const before='검사자는 관찰로 결과를 확신하지 않았다.';
const group={id:'fixed-source-id',finding:{type:'omission',sourceSpan:source,candidateSpan:before,relation:'condition_result'}};
const answer={id:group.id,status:'resolved',sourceSpan:'',candidateSpan:'',detail:'관찰 범위와 판단 시점의 한정이 동일 주체에 유지된다.'};
test('unique restored source quotation can be referenced without re-emission but not without an answer',()=>{
 const refs=p.currentCandidateReferences([group],source);
 assert.equal(refs[group.id],source);
 assert.equal(p.reviewPayload([group],refs)[0].currentCandidateReference,'sourceSpan');
 assert.equal(p.assessReviews([group],[answer],source,source,{candidateReferences:refs}).pending.length,0);
 assert.equal(p.assessReviews([group],[],source,source,{candidateReferences:refs}).pending.length,1);
 assert.equal(p.assessReviews([group],[answer],source,source).pending.length,1);
});
test('unchanged prior error still cannot be called resolved and dismissal needs confirming tier',()=>{
 const refs=p.currentCandidateReferences([group],before),a={...answer,status:'not_error'};
 assert.equal(p.reviewPayload([group],refs)[0].currentCandidateReference,'previousCandidateSpan');
 assert.equal(p.assessReviews([group],[answer],source,before,{candidateReferences:refs}).pending.length,1);
 assert.equal(p.assessReviews([group],[a],source,before,{candidateReferences:refs}).pending.length,1);
 assert.equal(p.assessReviews([group],[a],source,before,{candidateReferences:refs,allowDismiss:true}).pending.length,0);
});
test('stale, repeated, invented, absent and omitted references do not certify evidence',()=>{
 const refs=p.currentCandidateReferences([group],source);
 for(const candidate of [source+source,'관찰 결과는 추후 확인해야 한다.']){
  assert.equal(p.currentCandidateReferences([group],candidate)[group.id],undefined);
  assert.equal(p.assessReviews([group],[answer],source,candidate,{candidateReferences:refs}).pending.length,1);
 }
 for(const rows of [[answer,answer],[{...answer,id:'invented'}],[{...answer,candidateSpan:undefined}],[{...answer,detail:''}]])
  assert.equal(p.assessReviews([group],rows,source,source,{candidateReferences:refs}).pending.length,1);
 assert.equal(p.assessReviews([group],[answer],source,source,{candidateReferences:{[group.id]:'검사자는'}}).pending.length,1);
});
