'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync(require.resolve('../routes/transform'),'utf8');
function harness(execute) {
 const events=[],scheduled=[],launchingJobs=new Set();
 const ctx={launchingJobs,Date,db:null,TERMINAL_JOB_STATUSES:new Set(['done','cancelled']),
  providerAvailability:require('../lib/providerAvailability'),providerRecovery:require('../lib/transformProviderRecovery'),
  restartRecovery:{isRestartRecoveryHeld:()=>false},logger:{info:(event,data)=>events.push({event,data}),warn:()=>{}},
  executeOwned:execute,scheduleQueueDrain:ms=>scheduled.push(ms),persistJob:async()=>{},
  runHumanizeJob:async job=>{job.status='done';},runJob:async()=>{},runSearchPhase:async()=>{},runStructurePreview:async()=>{},recoverCompletion:async()=>{}};
 vm.runInNewContext(code.slice(code.indexOf('function launchQueuedJob(job) {'),code.indexOf('const queueDrainInterval =')),ctx);
 return {ctx,events,scheduled,launchingJobs,launch:ctx.launchQueuedJob};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('provider pause runs no generation and releases the worker; saved completion bypasses it',async()=>{
 const h=harness(async(job,feature,run)=>{await run();return true;});let saved=0;
 h.ctx.providerAvailability={checkAdmission:async()=>{throw Object.assign(Error(),{code:'OPENAI_QUOTA_EXHAUSTED',retryAtMs:Date.now()+60000});},isUnavailable:()=>true};
 h.ctx.persistJob=async()=>{saved++;return{ok:true};};
 h.ctx.runHumanizeJob=async()=>assert.fail('paused provider must not start generation');
 const job={id:'outage',status:'queued',mode:'formal',needed:80,text:'보존되는 합성 원문',deducted:false};
 h.launch(job);await turn();
 assert.equal(job.status,'queued');assert.equal(job.queueWaitReason,'provider_recovery');
 assert.equal(job.mode,'formal');assert.equal(job.deducted,false);assert.equal(saved,1);
 assert.equal(h.events.length,0);assert.equal(h.launchingJobs.size,0);
 let delivered=0;h.ctx.recoverCompletion=async()=>{delivered++;};
 h.launch({id:'saved',status:'queued',mode:'formal',pendingCompletion:{outputText:'이미 검증한 결과'}});await turn();
 assert.equal(delivered,1);
});
test('lease acquisition keeps queued status, prevents double admission and logs only an actual start',async()=>{
 let admit;const h=harness((job,feature,run)=>new Promise(resolve=>{admit=async()=>{await run();resolve(true);};}));
 const job={id:'synthetic-queue',uid:'fixture',mode:'blog',status:'queued',text:'합성 대기열 입력',createdAt:Date.now()-900000,queuedAt:Date.now()-900000};
 assert.equal(h.launch(job),true);assert.equal(h.launch(job),false);
 assert.equal(job.status,'queued');assert.equal(job.startedAt,undefined);assert.equal(h.events.length,0);
 await admit();await turn();
 assert.equal(h.events.length,1);assert.equal(h.events[0].event,'transform.started');
 assert.ok(h.events[0].data.queuedMs>=900000);assert.equal(h.launchingJobs.size,0);assert.equal(job.status,'done');
});
test('rejected ownership neither logs a false start nor overwrites cancellation',async()=>{
 const h=harness(async()=>false);const job={id:'synthetic-denied',mode:'blog',status:'queued'};
 h.launch(job);await turn();assert.equal(h.events.length,0);assert.equal(job.status,'queued');assert.equal(job.startedAt,undefined);
 assert.equal(job.queueWaitReason,'execution_lease');assert.ok(job.retryNotBeforeMs>Date.now());assert.equal(h.launchingJobs.size,0);
 const c=harness(async job=>{job.status='cancelled';return false;});const cancelled={id:'cancelled',mode:'blog',status:'queued'};
 c.launch(cancelled);await turn();assert.equal(cancelled.status,'cancelled');assert.equal(c.events.length,0);
});
test('a released slot supersedes a later retry timer',()=>{
 const timers=[],cleared=[];const ctx={Date,draining:false,drainQueue:()=>{},setTimeout:(fn,ms)=>{const t={fn,ms,unref(){}};timers.push(t);return t;},clearTimeout:t=>cleared.push(t)};
 vm.runInNewContext(code.slice(code.indexOf('let queueDrainPending ='),code.indexOf('function drainQueue()')),ctx);
 ctx.scheduleQueueDrain(60000);ctx.scheduleQueueDrain(0);
 assert.equal(timers.length,2);assert.equal(timers[1].ms,0);assert.ok(cleared.includes(timers[0]));
});
