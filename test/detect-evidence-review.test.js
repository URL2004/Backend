'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsEvidenceReview } = require('../lib/detectEvidenceReview');
const { groundSignals } = require('../lib/detectGrounding');
const { recheckReason } = require('../lib/detectDiagnostics');
const source = Array.from({length:10},(_,i)=>`실험 ${i+1}에서 관찰 결과를 기록했다.`).join(' ');
const make = (overrides={}) => ({ probability:35, confidence:'high', signalEvidence:groundSignals([{
  category:'generic_abstraction',strength:'moderate',scope:'recurring',evidenceSentences:[0,1,2,3,4,5,6], ...overrides
}],source) });
test('dense located observations can request a second opinion, never change the score', () => {
  const out=make(); const before=JSON.stringify(out);
  assert.equal(needsEvidenceReview(out,source),true);
  assert.equal(JSON.stringify(out),before);
  assert.equal(recheckReason(out,source,{models:{detect:'gpt-6-luna',detectEscalation:'gpt-6-sol'}}),'evidence_score_tension');
});
test('a low score, genre conventions or a sparse/short sample alone cannot request review', () => {
  for(const out of [ {probability:3,signalEvidence:[]}, make({strength:'weak'}),
    make({category:'ending_repetition'}),make({category:'insufficient_grounding'}),
    make({scope:'isolated'}),make({evidenceSentences:[0,1,2]}),{...make(),probability:65},
    {...make(),signalEvidence:make().signalEvidence.map(s=>({...s,locationStatus:'unlocated'}))}]) {
    assert.equal(needsEvidenceReview(out,source),false,JSON.stringify(out));
  }
  assert.equal(needsEvidenceReview(make(),source+' '+source),false);
  assert.equal(needsEvidenceReview(make(),source.split('. ').slice(0,4).join('. ')),false);
});
test('second opinion replaces the primary even when LOWER; no max-score selection or retry loop', {concurrency:false}, async t => {
  const engine=require('../engine-gpt-prod'); const fetch=global.fetch, key=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key'; let calls=0;
  global.fetch=async()=>{calls++; return new Response(JSON.stringify({status:'completed',
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(calls===1?{
      probability:35,confidence:'high',signals:[{category:'generic_abstraction',strength:'moderate',scope:'recurring',evidenceSentences:[0,1,2,3,4,5,6]}]
    }:{probability:8,confidence:'high',signals:[]})}]}],usage:{input_tokens:20,output_tokens:10,total_tokens:30}
  }),{status:200,headers:{'content-type':'application/json'}});};
  t.after(()=>{global.fetch=fetch;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;});
  const out=await engine.detect({text:source,allowLocalFallback:false,config:{models:{detect:'gpt-6-luna',detectEscalation:'gpt-6-sol'},reasoning:{detect:'low',escalation:'high'},cache:{enabled:false}}});
  assert.equal(calls,2); assert.equal(out.probability,8);
  assert.equal(out.detectDiagnostics.recheckReason,'evidence_score_tension');
});

test('capped evidence samples in a long document require strong, pervasive and dispersed observations', () => {
  const text=Array.from({length:40},(_,i)=>`관찰 ${i+1}의 별도 결과를 정리했다.`).join(' ');
  const out=indices=>({probability:25,signalEvidence:groundSignals([{
    category:'lexical_template',strength:'strong',scope:'pervasive',evidenceSentences:indices
  }],text)});
  const broad=out([0,6,12,20,28,33,39]);
  assert.equal(needsEvidenceReview(broad,text),true);
  assert.equal(needsEvidenceReview(out([0,1,2,3,4,5,6]),text),false);
  for(const change of [{strength:'moderate'},{scope:'recurring'}]) {
    assert.equal(needsEvidenceReview({...broad,signalEvidence:broad.signalEvidence.map(s=>({...s,...change}))},text),false);
  }
});
