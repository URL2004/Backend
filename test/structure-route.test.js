'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.HUMANIZE_STRUCTURE_ENABLED='1';process.env.LOG_LEVEL='fatal';
const config=require('../config');config.verifyToken=async token=>token;config.ADMIN_UIDS=[];
const billing=require('../lib/usageBilling'),runtime=require('../lib/gptRuntimeConfig'),structure=require('../engine-gpt-prod/documentStructure');
const balances=new Map([['owner',1000],['other',1000],['poor',0]]),ledger=new Map();let calls=0,plans=0,applyDelivery=true;
billing.authenticate=async token=>({uid:token});billing.precheckCredits=async(token,amount)=>{if((balances.get(token)||0)<amount)throw Object.assign(Error('CREDIT_NOT_ENOUGH'),{status:402});return {uid:token,plan:'free'};};
billing.commitCreditDeduct=async(uid,amount,op,key)=>{if(ledger.has(key))return false;ledger.set(key,amount);balances.set(uid,balances.get(uid)-amount);return true;};
runtime.getRuntimeConfig=async()=>({models:{detectEscalation:'fixture'}});runtime.isGptActive=()=>true;
structure.createPlan=async({text})=>{plans++;const doc=structure.buildDocument(text),plan=structure.identityPlan(doc);if(!text.includes('구조유지'))[plan.groups[3],plan.groups[4]]=[plan.groups[4],plan.groups[3]];return {...plan,...structure.applyPlan(doc,plan)};};
require('../routes/analyze-gpt').runHumanizeChunked=async opts=>{calls++;return {floorReport:{status:'pass',criticals:[],warnings:[],metrics:{}},qualityStatus:'clean',engineMeta:{},result:{outputText:opts.text+'\n\n검증 결과를 정리하였다.',structureImprovement:{requested:!!opts.approvedStructure,applied:!!opts.approvedStructure&&applyDelivery},engineMeta:{}}};};
const express=require('express'),app=express();app.use(express.json());const router=require('../routes/transform');app.use(router);
const source='I. 서론\n\n지역 도서관의 이용 현황을 확인했다. 신청 과정에서 생긴 불편을 정리했다.\n\nII. 본론\n\n첫 번째 방안은 안내문을 고치는 것이다. 이용자가 필요한 정보를 찾을 수 있게 해야 한다.\n\n조사에서는 안내가 어렵다는 의견이 있었다. 신청서 항목이 많아 작성 시간이 길었다.\n\nIII. 결론\n\n이용 과정의 개선을 위해 설명을 정리할 필요가 있다. 실행 이후에는 다시 의견을 받아 확인한다.';
test('real structure HTTP admission, free preview, stale/owner rejection, pricing and replay',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const request=async(p,body,uid='owner')=>{const r=await fetch(base+p,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+uid,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};};
 const done=async id=>{for(let i=0;i<100;i++){const r=await request('/transform/'+id);if(['done','error','blocked'].includes(r.status))return r;await new Promise(r=>setTimeout(r,20));}throw Error('Fixture job timeout');};
 try{
  assert.equal((await request('/transform/structure-plan',{text:source,mode:'formal'},'poor')).http,402);
  assert.equal((await request('/transform/structure-plan',{text:source,mode:'blog'})).http,400);
  assert.equal((await request('/transform/structure-plan',{text:source,mode:'formal',billingMode:'coupon'})).http,400);
  const started=await request('/transform/structure-plan',{text:source,mode:'formal'});assert.equal(started.http,200);const preview=await done(started.jobId);assert.equal(preview.status,'done');assert.equal(ledger.size,0);assert.equal(calls,0);
  const repeated=await request('/transform/structure-plan',{text:source,mode:'formal'});assert.equal(repeated.jobId,started.jobId);assert.equal(plans,1);
  const body={text:source,mode:'formal',structureMode:'improve',structurePlanId:started.jobId,effectNoticeAccepted:true};
  assert.equal((await request('/transform',{...body,text:source+' 변경'})).http,409);
  assert.equal((await request('/transform',body,'other')).http,409);
  const launched=await request('/transform',body);assert.equal(launched.http,200);const completed=await done(launched.jobId);assert.equal(completed.status,'done');assert.equal(completed.result.creditBreakdown.charged,130);assert.equal(balances.get('owner'),870);
  const replay=await request('/transform',body);assert.equal(replay.jobId,launched.jobId);assert.equal(calls,1);assert.equal(ledger.size,1);
  applyDelivery=false;const fallback=await request('/transform',{...body,memo:'다른 검증 설정'});const fallbackDone=await done(fallback.jobId);assert.equal(fallbackDone.result.creditBreakdown.structure,0);assert.equal(fallbackDone.result.creditBreakdown.charged,100);assert.equal(balances.get('owner'),770);
  const noOp=await request('/transform/structure-plan',{text:source+' 구조유지',mode:'formal'});assert.equal((await done(noOp.jobId)).result.structurePlan.applied,false);assert.equal(ledger.size,2);
 }finally{await new Promise(r=>server.close(r));}
});
