'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../lib/detectEvidenceReview'),{groundSignals}=require('../lib/detectGrounding');
const text=n=>Array.from({length:n},(_,i)=>`관찰 ${i+1}의 과정을 통해 중요한 의미를 찾는다.`).join(' ');
const result=(s,n,changes={})=>({probability:34,confidence:'medium',signalEvidence:groundSignals([{
 category:'sentence_uniformity',strength:'moderate',scope:'recurring',evidenceSentences:Array.from({length:n},(_,i)=>i),...changes
}],s)});
test('short consistency requires ceil(80%) grounding for every sample size and no low-score-only trigger',()=>{
 for(let n=2;n<=7;n++){
  const s=text(n),count=Math.max(2,Math.ceil(n*.8));
  assert.equal(policy.needsShortConsistencyReview(result(s,count),s),true);
  assert.equal(policy.needsShortConsistencyReview(result(s,count-1),s),false);
 }
 for(const n of [1,8])assert.equal(policy.needsShortConsistencyReview(result(text(n),n),text(n)),false);
 const s=text(2),a=result(s,2);
 for(const probability of [0,20,50,NaN])assert.equal(policy.needsShortConsistencyReview({...a,probability},s),false);
 for(const change of [{strength:'weak'},{scope:'isolated'},{category:'ending_repetition'},
  {category:'formulaic_transition'},{category:'overstructured_progression'}])
  assert.equal(policy.needsShortConsistencyReview(result(s,2,change),s),false);
});
test('high second score needs fresh independent evidence, low score and complete evidence remain paired',()=>{
 const s=text(2),first=result(s,2),second={...result(s,2),probability:64};
 assert.equal(policy.selectShortConsistencyResult(first,second,s),first);
 const two={...second,signalEvidence:[...second.signalEvidence,...result(s,2,{category:'generic_abstraction'}).signalEvidence]};
 assert.equal(policy.selectShortConsistencyResult(first,two,s),two);
 const lower={probability:8,signalEvidence:[]};
 assert.equal(policy.selectShortConsistencyResult(first,lower,s),lower);
});
test('consistency call is bounded, records both costs and the truly selected phase', {concurrency:false},async t=>{
 const engine=require('../engine-gpt-prod'),native=global.fetch,key=process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY='test';t.after(()=>{global.fetch=native;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;});
 for(const second of [{probability:64,signals:[{category:'sentence_uniformity',strength:'moderate',scope:'recurring',evidenceSentences:[0,1]}]},
  {probability:8,signals:[]}, {probability:62,signals:['sentence_uniformity','generic_abstraction'].map(category=>({category,strength:'moderate',scope:'recurring',evidenceSentences:[0,1]}))}]){
  let calls=0;global.fetch=async()=>{calls++;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(calls===1?{
   probability:34,confidence:'medium',signals:[{category:'sentence_uniformity',strength:'moderate',scope:'recurring',evidenceSentences:[0,1]}]
  }:{confidence:'medium',...second})}]}],usage:{input_tokens:20,output_tokens:10,total_tokens:30}});};
  const r=await engine.detect({text:text(2),allowLocalFallback:false,config:{models:{detect:'gpt-6-luna',detectEscalation:'gpt-6-sol'},cache:{enabled:false}}});
  assert.equal(calls,2);assert.equal(r.detectDiagnostics.recheckReason,'short_evidence_consistency');
  assert.equal(r.probability,second.probability===64?34:second.probability);
  assert.equal(r.detectDiagnostics.selectedPhase,second.probability===64?'primary':'recheck');
  assert.equal(r.detectDiagnostics.attempts.length,2);assert.equal(r.gptMeta.usage.totalTokens,60);
  assert.equal(r.signalEvidence.length,second.probability===64?1:second.signals.length);
 }
});
