'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {finalSemanticDeadline}=require('../engine-gpt-prod/finalSemanticDeadline');
const {completeJson}=require('../engine-gpt-prod/openaiClient');
for(const [chars,jobRemaining,expected] of [[6000,500000,120000],[6001,500000,180000],[8000,90000,90000]])
test(`final transport ${chars} chars / job ${jobRemaining}ms stays one attempt`,{concurrency:false},async t=>{
 const oldFetch=global.fetch,keys=['OPENAI_API_KEY','OPENAI_API_TIMEOUT_MS','OPENAI_CHUNK_TOTAL_TIMEOUT_MS'];
 const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 for(const k of keys)delete process.env[k];process.env.OPENAI_API_KEY='test-key';
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 t.after(()=>{global.fetch=oldFetch;for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}t.mock.timers.reset();});
 let calls=0,finished=false;
 global.fetch=async()=>{calls++;return new Promise(()=>{});};
 const policy=finalSemanticDeadline({source:'가'.repeat(chars),startedAt:Date.now(),jobDeadlineMs:Date.now()+jobRemaining});
 const controller=new AbortController();
 setTimeout(()=>controller.abort(new DOMException('Final deadline','TimeoutError')),policy.deadlineMs-Date.now());
 const pending=completeJson({system:'synthetic',user:'synthetic',model:'gpt-6-sol',reasoningEffort:'high',
  maxOutputTokens:10000,signal:controller.signal,meta:{task:'judge',phase:'escalation:semantic'},
  schema:{type:'object',additionalProperties:false,properties:{value:{type:'string'}},required:['value']}
 }).then(()=>{throw Error('unexpected success');},error=>{finished=true;return error;});
 for(let i=0;i<20&&calls===0;i++)await Promise.resolve();
 assert.equal(calls,1);t.mock.timers.tick(expected-1);
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(finished,false);assert.equal(controller.signal.aborted,false);
 t.mock.timers.tick(2);const error=await pending;
 assert.equal(controller.signal.reason.name,'TimeoutError');
 assert.equal(error.httpAttemptCount,1);assert.equal(error.retryCounts.timeout,0);
 assert.equal(error.unknownUsageCount,1);assert.ok(error.unknownEstimatedUsd>0);assert.equal(calls,1);
});
