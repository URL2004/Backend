'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {finalSemanticDeadline}=require('../engine-gpt-prod/finalSemanticDeadline');
const {completeJson}=require('../engine-gpt-prod/openaiClient');
const ledger=require('../engine-gpt-prod/callLedger');

// F-01: a final verdict request used to be cut at the 120s/180s audit deadline
// (or the fixed 180s request limit). The final audit now runs under its verdict
// policy: one request may take the 270s section limit, still one attempt, and
// the job deadline still wins when it is closer. A verdict outside that policy
// keeps the 180s request limit.
// [chars, job remaining, use the final verdict policy, expected cut, cut by]
for(const [chars,jobRemaining,finalPolicy,expected,cutBy] of [
 [6000,5000000,true,270000,'request'],[6001,5000000,true,270000,'request'],[20000,5000000,true,270000,'request'],
 [8000,90000,true,90000,'job'],[6000,5000000,false,180000,'request']])
test(`final transport ${chars} chars / job ${jobRemaining}ms / policy ${finalPolicy} stays one attempt`,{concurrency:false},async t=>{
 const oldFetch=global.fetch,keys=['OPENAI_API_KEY','OPENAI_API_TIMEOUT_MS','OPENAI_CHUNK_TOTAL_TIMEOUT_MS'];
 const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 for(const k of keys)delete process.env[k];process.env.OPENAI_API_KEY='test-key';
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 t.after(()=>{global.fetch=oldFetch;for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}t.mock.timers.reset();});
 let calls=0,finished=false;
 global.fetch=async()=>{calls++;return new Promise(()=>{});};
 const policy=finalSemanticDeadline({source:'가'.repeat(chars),startedAt:Date.now(),jobDeadlineMs:Date.now()+jobRemaining});
 const deadlineMs=policy.verdictDeadlineMs(Date.now());
 const controller=new AbortController();
 setTimeout(()=>controller.abort(new DOMException('Final deadline','TimeoutError')),deadlineMs-Date.now());
 const request=()=>completeJson({system:'synthetic',user:'synthetic',model:'gpt-6-sol',reasoningEffort:'high',
  maxOutputTokens:10000,signal:controller.signal,deadlineMs,meta:{task:'judge',phase:'primary:semantic'},
  schema:{type:'object',additionalProperties:false,properties:{value:{type:'string'}},required:['value']}
 });
 const pending=ledger.run(()=>finalPolicy?ledger.withPolicy(policy.verdictPolicy,request):request())
  .then(()=>{throw Error('unexpected success');},error=>{finished=true;return error;});
 for(let i=0;i<20&&calls===0;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1);t.mock.timers.tick(expected-1);
 for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(finished,false);assert.equal(controller.signal.aborted,false);
 t.mock.timers.tick(2);const error=await pending;
 if(cutBy==='job')assert.equal(controller.signal.reason.name,'TimeoutError');
 else{assert.equal(controller.signal.aborted,false);assert.equal(error.code,'ETIMEDOUT');}
 assert.equal(error.httpAttemptCount,1);assert.equal(error.retryCounts.timeout,0);
 assert.equal(error.unknownUsageCount,1);assert.ok(error.unknownEstimatedUsd>0);assert.equal(calls,1);
});
