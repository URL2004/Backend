'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../engine-gpt-prod/semanticObligations');
const {groundViolation}=require('../engine-gpt-prod/judge');
const source='연구자는 첫 관찰만으로 곧바로 결론을 확신하지는 않았다.';
const before='연구자는 첫 관찰로 결론을 확신하지는 않았다.';
const after='연구자는 첫 관찰만으로 곧바로 결론을 확신한 것은 아니었다.';
const finding=groundViolation({type:'omission',span:'곧바로',sourceSpan:source,candidateSpan:before,
  relation:'condition_result',origin:'introduced',detail:'확신의 시점에 대한 한정이 빠졌다.'},source,before);
const report={pass:false,verificationCompleted:true,violations:[finding]};
const obligations=p.collectObligations(source,[report]);
const review=(status='resolved',candidateSpan=after)=>({id:obligations[0].id,status,sourceSpan:source,candidateSpan,detail:'같은 연구자의 확신 시점과 첫 관찰만이라는 한정을 확인했다.'});
test('omission grounding belongs to source, and still requires a unique candidate owner',()=>{
 assert.equal(finding.spanVerified,false);assert.equal(finding.sourceSpanVerified,true);assert.equal(p.hasGroundedSpan(finding),true);
 assert.equal(obligations.length,1);
 assert.equal(p.hasGroundedSpan({...finding,repairable:false}),false);
 assert.equal(p.hasGroundedSpan({...finding,sourceSpanVerified:false}),false);
});
test('empty later pass and a rewritten candidate cannot erase an earlier obligation',()=>{
 for(const candidate of [before,after,'첫 관찰에서 결론을 바로 정하지는 않았다.']){
  const r=p.assessReviews(obligations,[],source,candidate);assert.equal(r.pending.length,1);assert.equal(r.pending[0].repairable,false);
 }
 assert.equal(p.allExplicitlyReviewed(obligations,{pass:true,violations:[]}),false);
});
test('grounded explicit resolution closes only the quoted current candidate',()=>{
 assert.equal(p.assessReviews(obligations,[review()],source,after).pending.length,0);
 assert.equal(p.assessReviews(obligations,[review()],source,before).pending.length,1);
 assert.equal(p.assessReviews(obligations,[review('resolved',before)],source,before).pending.length,1);
});
test('a genuine false positive requires explicit confirming-tier dismissal',()=>{
 const r=review('not_error',before);
 assert.equal(p.assessReviews(obligations,[r],source,before).pending.length,1);
 assert.equal(p.assessReviews(obligations,[r],source,before,{allowDismiss:true}).pending.length,0);
});
test('duplicate, invented, missing or incorrectly grounded review IDs cannot clear findings',()=>{
 for(const reviews of [[review(),review()],[{...review(),id:'invented'}],[{...review(),sourceSpan:'다른 원문이다.'}],[]])
  assert.equal(p.assessReviews(obligations,reviews,source,after).pending.length,1);
 assert.equal(p.assessReviews(obligations,[review()],source,after+after).pending.length,1);
});
test('candidate rewrite does not change identity and ambiguous projected source remains open',()=>{
 assert.equal(p.obligationId(finding),p.obligationId({...finding,candidateSpan:after}));
 const collected=p.collectObligations(source+source,[report]);assert.equal(collected.length,1);
 assert.equal(p.assessReviews(collected,[review()],source+source,after).pending.length,1);
 assert.equal(p.assessReviews(p.collectObligations('바뀐 원문이다.',[report]),[review()],'바뀐 원문이다.',after).pending.length,1);
});
test('complete child findings survive incomplete aggregate, but incomplete child is not authority',()=>{
 assert.equal(p.collectObligations(source,[{verificationCompleted:false,reports:[report]}]).length,1);
 assert.equal(p.collectObligations(source,[{...report,verificationCompleted:false}]).length,0);
});
test('missing overflow reviews remain pending instead of being truncated into a pass',()=>{
 const many=Array.from({length:18},(_,i)=>({...obligations[0],id:String(i)}));
 const reviews=many.slice(0,16).map(o=>({...review(),id:o.id}));
 assert.equal(p.assessReviews(many,reviews,source,after).pending.length,2);
});
test('same-anchor reviews share stable identity without dropping any previous question',()=>{
 const second={...finding,detail:'관찰 횟수에 대한 제한까지 빠졌다.'};
 const groups=p.collectObligations(source,[report,{violations:[second]},{violations:[second]}]);
 assert.equal(groups.length,1);assert.equal(groups[0].questions.length,2);
 assert.equal(p.reviewPayload(groups)[0].previousQuestions[1].detail,second.detail);
 assert.equal(p.assessReviews(groups,[],source,after).pending.length,1);
});

for(const verdict of ['silent','resolved','wrong_id','not_error_primary','not_error_confirming'])
test(`actual semantic judge enforces the obligation contract: ${verdict}`,async()=>{
 const clientPath=require.resolve('../engine-gpt-prod/openaiClient'),judgePath=require.resolve('../engine-gpt-prod/judge');
 const oldClient=require.cache[clientPath],oldJudge=require.cache[judgePath];
 let calls=0;
 require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{completeJson:async opts=>{
   calls++;assert.ok(opts.schema.required.includes('obligationReviews'));
   assert.ok(opts.user.includes(obligations[0].id));
   const dismiss=verdict.startsWith('not_error'), r=review(dismiss?'not_error':'resolved',dismiss?before:after);
   if(verdict==='wrong_id')r.id='invented';
   const operators=require('../engine-gpt-prod/promptEnvelope').extractPromptDataSection(opts.user,'OPERATOR_REVIEW_TARGETS');
   const operatorReviews=operators?JSON.parse(operators).map(t=>({...t,status:'preserved',detail:'Separate synthetic operator review explicitly confirms this intended false-positive fixture.'})):[];
   return {json:{violations:[],operatorReviews,obligationReviews:verdict==='silent'?[]:[r]},model:opts.model,usage:{estimatedUsd:0}};
 }}};
 delete require.cache[judgePath];
 try {
   const r=await require(judgePath).semanticJudge(source,verdict.startsWith('not_error')?before:after,{},
     {priorReports:[report],model:verdict==='not_error_confirming'?'gpt-6-sol':'gpt-6-luna',
       config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-sol'}}});
   assert.equal(calls,1);assert.equal(r.pass,['resolved','not_error_confirming'].includes(verdict));
   if(!r.pass)assert.equal(r.uncertain,true);
 } finally {
   if(oldClient)require.cache[clientPath]=oldClient;else delete require.cache[clientPath];
   if(oldJudge)require.cache[judgePath]=oldJudge;else delete require.cache[judgePath];
 }
});
test('fallback cannot resurrect an earlier pass that never adjudicated the known obligation',()=>{
 const {createCandidateLedger}=require('../engine-gpt-prod/candidateLedger');
 const {bindSemanticValidation}=require('../engine-gpt-prod/semanticProvenance');
 const ledger=createCandidateLedger({source,assess:()=>({hardViolationCodes:[],minimumEffectPass:true,transformed:true})});
 const old=ledger.record({stage:'old_pass',text:before,
  semanticReport:bindSemanticValidation({ran:true,pass:true},source,before)});
 const current=ledger.record({stage:'unverified',text:after,
  semanticReport:bindSemanticValidation({ran:true,pass:false,uncertain:true},source,after)});
 assert.equal(ledger.chooseFinal(current.id).entry.id,old.id);
 assert.equal(ledger.chooseFinal(current.id,{reviewObligations:obligations}).applied,false);
 const verified=ledger.record({stage:'explicit_pass',text:after,semanticReport:bindSemanticValidation({ran:true,pass:true,
   obligationReviews:[review()]},source,after)});
 assert.equal(ledger.chooseFinal(current.id,{reviewObligations:obligations}).entry.id,verified.id);
});
