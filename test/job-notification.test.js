const test=require('node:test');const assert=require('node:assert/strict');
const {jobNotification}=require('../lib/jobNotification');
const envelope=require('../middleware/errorEnvelope');
test('each authoritative actionable transition produces a distinct durable event',()=>{
 let previous={status:'running'};
 for(const status of ['awaiting_approval','running','awaiting_payment','done']){
  const notice=jobNotification({id:'job1',uid:'user1',status},previous,1234);
  if(status==='running'){assert.equal(notice,null);previous={...previous,status};continue;}
  assert.equal(notice.revision,(previous.notificationRevision||0)+1);assert.equal(notice.data.jobStatus,status);assert.equal(notice.data.read,false);assert.equal(notice.data.writeSource,'server_job_transition');
  previous={status,notificationRevision:notice.revision};assert.equal(jobNotification({id:'job1',uid:'user1',status},previous,2345),null);
 }
});
test('previews and administrator experiments never create customer job notifications',()=>{
 for(const flags of [{structurePreview:true},{adminHumanizeLab:true}])assert.equal(jobNotification({id:'job',uid:'uid',status:'done',...flags},null,1),null);
});
test('error envelope preserves authoritative fields and never guesses billing',()=>{
 for(const status of [400,401,402,403,404,409,413,422,429,500,503]){
  let output;const res={statusCode:status,getHeader:()=> 'req-1',json:b=>{output=b}};envelope({},res,()=>{});res.json({error:'message'});assert.equal(output.ok,false);assert.equal(output.billingState,'unknown');assert.equal(output.requestId,'req-1');assert.equal(output.retryable,status===429||status>=500);
  res.json({error:'message',code:'CUSTOM',charged:0,billingState:'not_charged'});assert.equal(output.code,'CUSTOM');assert.equal(output.billingState,'not_charged');
 }
});
