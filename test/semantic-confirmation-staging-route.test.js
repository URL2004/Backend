'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const source='조사팀은 세 지역의 자료를 검토했다. 참여 인원은 120명이며 결과는 잠정치다.';
const candidate='세 지역의 자료는 조사팀이 검토했다. 참여자는 120명이며 결과는 잠정치다.';
const config={models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6.1-sol',repair:'gpt-6-luna'},
 reasoning:{judge:'medium',escalation:'high',repair:'medium'}};
function load(responses){
 const file=path.join(__dirname,'../engine-gpt-prod/judge.js'),req=createRequire(file),calls=[],module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:n=>n==='./openaiClient'?{
  completeJson:async opts=>{
   calls.push(opts);const next=responses[calls.length-1];assert.ok(next,'unexpected extra call');
   if(next.error)throw Object.assign(Error(next.error),{code:next.error});
   const json=require('./helpers/semantic-review-fixture.cjs')(next,opts.user);
   return {json,model:opts.model,usage:{estimatedUsd:0.01,inputTokens:100,outputTokens:10}};
  }
 }:req(n)},{filename:file});
 return {judge:module.exports,calls};
}
test('required confirmation selects configured strong model before any repair or primary pass',async()=>{
 const {judge,calls}=load([{violations:[]}]);
 const result=await judge.judgeAndRepair(source,candidate,{config,requireConfirmation:true,maxRounds:1});
 assert.equal(result.pass,true);assert.equal(result.relationConfirmationFirst,true);
 assert.equal(result.selectedJudgeModel,'gpt-6.1-sol');assert.equal(calls.length,1);
 assert.equal(calls[0].model,'gpt-6.1-sol');assert.equal(calls[0].reasoningEffort,'high');
 assert.equal(calls[0].maxOutputTokens,10000);assert.equal(result.usage.estimatedUsd,0.01);
 assert.equal(result.outputText,candidate);
});
test('ordinary clean audits retain primary routing and strict boolean prevents accidental opt-in',async()=>{
 for(const requireConfirmation of [undefined,false,'true',1]){
  const {judge,calls}=load([{violations:[]}]);
  const result=await judge.judgeAndRepair(source,candidate,{config,requireConfirmation,maxRounds:1});
  assert.equal(result.pass,true);assert.equal(calls.length,1);assert.equal(calls[0].model,'gpt-6-luna');
  assert.equal(calls[0].reasoningEffort,'medium');
 }
});
test('required confirmation never falls back to cheaper pass after a grounded failure',async()=>{
 const {judge,calls}=load([{violations:[{type:'distortion',origin:'introduced',relation:'quantity_target',
  sourceSpan:source,candidateSpan:candidate,span:'120명',detail:'합성 테스트용 수치 귀속 검토 지적이다.'}]}]);
 const result=await judge.judgeAndRepair(source,candidate,{config,requireConfirmation:true,maxRounds:0});
 assert.equal(result.pass,false);assert.equal(calls.length,1);assert.equal(result.relationConfirmationFirst,true);
 assert.equal(result.outputText,candidate);
});
test('truncated confirming response remains an error and does not create a replacement pass',async()=>{
 const {judge,calls}=load([{error:'OPENAI_TRUNCATED_OUTPUT'}]);
 await assert.rejects(judge.judgeAndRepair(source,candidate,{config,requireConfirmation:true}),
  e=>e.code==='OPENAI_TRUNCATED_OUTPUT');
 assert.equal(calls.length,1);
});
test('same configured judge and escalation do not duplicate calls',async()=>{
 const {judge,calls}=load([{violations:[]}]);
 const result=await judge.judgeAndRepair(source,candidate,{config:{...config,models:{...config.models,judgeEscalation:'gpt-6-luna'}},
  requireConfirmation:true});
 assert.equal(result.pass,true);assert.equal(calls.length,1);assert.equal(calls[0].model,'gpt-6-luna');
});

test('staged primary failure keeps the repair quota for confirmation rather than repairing twice',async()=>{
 const finding={type:'distortion',origin:'introduced',relation:'modality_negation_causality',
  sourceSpan:source,candidateSpan:candidate,span:candidate,detail:'합성 테스트: 잠정 결과의 주장 강도를 재검토한다.'};
 const {judge,calls}=load([{violations:[finding]},{violations:[]}]);
 const result=await judge.judgeAndRepair(source,candidate,{config,stagedConfirmation:true,maxRounds:1});
 assert.equal(result.pass,true);assert.equal(result.escalated,true);assert.equal(result.rounds,0);
 assert.equal(calls.length,2);assert.equal(calls[0].model,'gpt-6-luna');assert.equal(calls[1].model,'gpt-6.1-sol');
 assert.ok(calls.every(c=>c.meta.task==='judge'));assert.equal(result.outputText,candidate);
 assert.equal(result.usage.estimatedUsd,0.02);
});

test('denied staged confirmation preserves failed verdict and makes no unreserved repair',async()=>{
 const finding={type:'distortion',origin:'introduced',relation:'modality_negation_causality',
  sourceSpan:source,candidateSpan:candidate,span:candidate,detail:'합성 테스트: 잠정 결과의 주장 강도를 재검토한다.'};
 const {judge,calls}=load([{violations:[finding]}]);
 const result=await judge.judgeAndRepair(source,candidate,{config,stagedConfirmation:true,maxRounds:1,reserveEscalation:()=>false});
 assert.equal(result.pass,false);assert.equal(result.rounds,0);assert.equal(calls.length,1);
 assert.equal(result.escalationSkippedReason,'escalation_reserve_denied');assert.equal(result.outputText,candidate);
});

test('staging leaves a clean primary pass alone',async()=>{
 const {judge,calls}=load([{violations:[]}]);
 const result=await judge.judgeAndRepair(source,candidate,{config,stagedConfirmation:true,maxRounds:1});
 assert.equal(result.pass,true);assert.equal(calls.length,1);assert.equal(calls[0].model,'gpt-6-luna');
});

test('staging does not escalate exact omission-only findings when repair is unavailable',async()=>{
 const missing='참여 인원은 120명이며 결과는 잠정치다.';
 const finding={type:'omission',origin:'introduced',relation:'quantity_target',
  sourceSpan:missing,candidateSpan:'세 지역의 자료는 조사팀이 검토했다.',span:missing,
  detail:'합성 테스트: 참여 인원과 잠정 결과 설명이 누락됐다.'};
 for(const stagedConfirmation of [false,true]){
  const {judge,calls}=load([{violations:[finding]}]);
  const result=await judge.judgeAndRepair(source,'세 지역의 자료는 조사팀이 검토했다.',{
   config,stagedConfirmation,maxRounds:1,reserveRepair:()=>false});
  assert.equal(result.pass,false);assert.equal(calls.length,1);
  assert.equal(result.escalationSkippedReason,'deterministic_omission_restore');
  assert.equal(result.repairDeferredForConfirmation,false);
 }
});
