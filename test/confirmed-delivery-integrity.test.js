'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {bindSemanticValidation}=require('../engine-gpt-prod/semanticProvenance');
const {confirmedOmissions,explainConfirmedOmissions,stopUnproductiveShortEscalation:stop}=require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const {applyDeliveryPolicy}=require('../lib/humanizeDeliveryPolicy');
const source='측정 결과를 직접 정리하는 일에 익숙하다. 연구 모임에서 자료를 모으고 발표했다.';
const candidate='연구 모임에서 자료를 수집하고 발표를 맡았다.';
const finding={type:'omission',origin:'introduced',repairable:true,relationGrounded:true,grounding:'unique_exact_span',sourceSpanVerified:true,sourceSpan:'측정 결과를 직접 정리하는 일에 익숙하다.',candidateSpan:candidate};
const previous={ran:true,pass:false,verificationCompleted:true,violations:[finding]};
const final=()=>bindSemanticValidation({...previous,violations:[{...finding}]},source,candidate);
test('only current, repeated, grounded missing claims become a hard gate',()=>{
 assert.equal(confirmedOmissions(source,candidate,final(),[previous]).length,1);
 for(const report of [{...final(),uncertain:true},{...final(),verificationCompleted:false},{...final(),nominationOnly:true}])assert.equal(confirmedOmissions(source,candidate,report,[previous]).length,0);
 assert.equal(confirmedOmissions(source,candidate,final(),[]).length,0);
 assert.equal(confirmedOmissions(source,candidate+' 추가 문장이다.',final(),[previous]).length,0);
 assert.equal(confirmedOmissions(source,candidate,final(),[{...previous,uncertain:true}]).length,0);
});
test('reordered source claims and addition warnings are not omission gates',()=>{
 const moved=candidate+' '+finding.sourceSpan;
 assert.equal(confirmedOmissions(source,moved,bindSemanticValidation(previous,source,moved),[previous]).length,0);
 const addition={...previous,violations:[{...finding,type:'addition'}]};
 assert.equal(confirmedOmissions(source,candidate,bindSemanticValidation(addition,source,candidate),[addition]).length,0);
});

test('a current omission verdict still gates after whitespace-only paragraph repair',()=>{
 const originalCandidate='연구 모임에서 자료를 수집했다. 발표 자료도 작성했다.';
 const delivered='연구 모임에서 자료를 수집했다.\n\n발표 자료도 작성했다.';
 const violation={...finding,candidateSpan:originalCandidate};
 const prior={...previous,violations:[violation]};
 const report=bindSemanticValidation(prior,source,originalCandidate);
 assert.equal(confirmedOmissions(source,delivered,report,[prior]).length,1);
 const explanation=explainConfirmedOmissions(source,delivered,report,[prior]);
 assert.equal(explanation.rows[0].candidateUnique,true);
 assert.equal(explanation.confirmedCount,1);
 const changed=delivered.replace('수집했다','폐기했다');
 assert.equal(confirmedOmissions(source,changed,report,[prior]).length,0,'semantic edits invalidate the receipt');
 const duplicate=delivered+'\n\n'+delivered.replace(/\n\n/g,'\n');
 const repeated=bindSemanticValidation(prior,source,duplicate);
 assert.equal(confirmedOmissions(source,duplicate,repeated,[prior]).length,0,'ambiguous whitespace-normalized spans stay rejected');
 assert.equal(explainConfirmedOmissions(source,duplicate,repeated,[prior]).rows[0].candidateUnique,false);
});
test('confirmed integrity gates cannot be softened into charged review delivery',()=>{
 for(const gate of ['confirmed_semantic_omission','citation_integrity_unresolved']){
  const r=applyDeliveryPolicy({status:'blocked',criticals:[{gate}],warnings:[]});
  assert.equal(r.decision,'block_technical');assert.equal(r.report.status,'blocked');
 }
 assert.equal(applyDeliveryPolicy({criticals:[{gate:'semantic_addition'}],warnings:[]}).decision,'deliver_review');
});
test('short-text stop preserves mandatory no-op recovery and final verification',()=>{
 const x={attempt:1,sourceLength:300,semantic:{ran:true,pass:true,verificationCompleted:true},metrics:{substantiveChangedSentenceCount:1,substantiveEditRatio:.04},reason:'candidate_unchanged'};
 assert.equal(stop(x),true);
 for(const v of [{attempt:0},{sourceLength:900},{semantic:{ran:false,pass:true}},{metrics:{substantiveChangedSentenceCount:0,substantiveEditRatio:0}},{reason:'semantic_audit_failed'}])assert.equal(stop({...x,...v}),false);
});
