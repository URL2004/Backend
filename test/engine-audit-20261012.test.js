'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {bindSemanticValidation}=require('../engine-gpt-prod/semanticProvenance');
const {confirmedOmissions,explainConfirmedOmissions}=require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const {residualSourceLoss,mixedScriptWordChanges}=require('../engine-gpt-prod/deliveryIntegrityWitnesses');
const {ordinalMarkers}=require('../engine-gpt-prod/koreanOrdinal');
const {sanitizeDiagnostics,VERSION,STAGE_VERSION}=require('../lib/detectDiagnostics');
test('independent omission findings can name nested spans of the same absent claim',()=>{
 const claim='지역 도서관의 안정적인 운영을 위해서는 장기간에 걸친 예산 확보와 주민의 지속적인 참여가 필요하다.';
 const source=claim+' 우선 자료를 분류하고 새 안내문을 배포해야 한다.';
 const candidate='먼저 자료 분류를 마치고 새 안내문을 배포해야 한다.';
 const finding={type:'omission',origin:'introduced',repairable:true,relationGrounded:true,grounding:'unique_exact_span',sourceSpanVerified:true,sourceSpan:claim,candidateSpan:candidate};
 const prior={ran:true,pass:false,verificationCompleted:true,violations:[{...finding,sourceSpan:'장기간에 걸친 예산 확보와 주민의 지속적인 참여가 필요하다.'}]};
 const final=bindSemanticValidation({...prior,violations:[finding]},source,candidate);
 assert.equal(confirmedOmissions(source,candidate,final,[prior]).length,1);
 assert.equal(explainConfirmedOmissions(source,candidate,final,[prior]).confirmedCount,1);
 assert.equal(confirmedOmissions(source,candidate,final,[{...prior,uncertain:true}]).length,0);
 assert.equal(confirmedOmissions(source,candidate+' '+claim,final,[prior]).length,0,'stale or restored candidates do not block');
});
test('literal orphan detection excludes source headings and whole retained sentences',()=>{
 const source='도서관의 지역 교류를 넓히기 위해서는 어린이 프로그램과 성인 독서 모임을 함께 지원하고 자료 대출을 편리하게 만드는 지속적인 지원 노력이 필요하다고 본다.';
 assert.ok(residualSourceLoss(source,'지속적인 지원 노력').length);
 assert.equal(residualSourceLoss(source,source).length,0);
 assert.equal(residualSourceLoss('지속적인 지원 노력\n\n'+source,'지속적인 지원 노력\n\n'+source).length,0);
});
test('mixed script guard uses the local word context and keeps attested foreign text',()=>{
 const source='가나다 도서관은 오래된 자료를 보관한다. 다른 페이지 정보도 있다.';
 assert.equal(mixedScriptWordChanges(source,'ガ나다 도서관은 오래된 자료를 보관한다.').length,1);
 assert.equal(mixedScriptWordChanges(source+' ガ나다 도서관','ガ나다 도서관').length,0);
 assert.equal(mixedScriptWordChanges(source,'일본어 カタカナ 표기를 소개한다.').length,0);
});
test('ordinal adverbs retain enumeration while family references remain ordinary prose',()=>{
 assert.deepEqual(ordinalMarkers('첫째로, 자료를 정리한다. 둘째로, 지역 의견을 수집한다.').map(x=>x.number),[1,2]);
 assert.deepEqual(ordinalMarkers('첫째 아이가 왔다. 둘째 아이는 집에 있다.'),[]);
});
test('diagnostics retain model and final-stage consistency independently without rescaling',()=>{
 const d=sanitizeDiagnostics({version:VERSION,attempts:[{phase:'primary',modelScore:12}],stageVersion:STAGE_VERSION,
  selectedModelScore:12,statisticalScore:53,engineFinalScore:53,displayedScore:32,
  modelCandidateConsistency:{status:'consistent',reason:'consistent'},finalCandidateConsistency:{status:'conflict',reason:'unsupported_high_score'}});
 assert.equal(d.modelCandidateConsistency.status,'consistent');assert.equal(d.finalCandidateConsistency.status,'conflict');
 assert.equal(d.displayedScore,32);assert.equal(d.engineFinalScore,53);
});
