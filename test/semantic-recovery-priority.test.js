'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRecoveryBudget}=require('../engine-gpt-prod/recoveryBudget');

test('style recovery cannot spend the final minute or reserved semantic call slots',()=>{
  let now=1000;
  const b=createRecoveryBudget(1,{clock:()=>now,maxCalls:4,reservedLateCalls:2,maxElapsedMs:240000});
  assert.equal(b.deadlineMs({priority:'normal'}),181000);
  assert.equal(b.deadlineMs({priority:'late'}),241000);
  for(let i=0;i<2;i++){const id=b.reserveCall(.01,{priority:'normal'});assert.ok(id);b.settleCall(id,{estimatedUsd:.001});}
  assert.equal(b.reserveCall(.01,{priority:'normal'}),null);
  assert.equal(b.denialReason({priority:'normal'}),'recovery_late_call_reserve');
  now=181000;
  assert.equal(b.denialReason({priority:'normal'}),'recovery_late_time_reserve');
  assert.ok(b.reserveCall(.01,{priority:'late'}));
  now=241000;
  assert.equal(b.denialReason({priority:'late'}),'recovery_time_limit_exhausted');
});

test('HTTP admission distinguishes style recovery from semantic repair',async t=>{
  const client=require('../engine-gpt-prod/openaiClient'),ledger=require('../engine-gpt-prod/callLedger');
  const oldFetch=global.fetch,oldKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key';const priorities=[],deadlines=[];
  global.fetch=async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"value":"ok"}'}]}],usage:{input_tokens:10,output_tokens:5}}));
  t.after(()=>{global.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;});
  await ledger.run(async()=>{
    ledger.setRecoveryBudget({enableCallAccounting(){},deadlineMs(o){deadlines.push(o.priority);return Date.now()+30000;},reserveCall(n,o){priorities.push(o.priority);return priorities.length;},settleCall(){}});
    const opts={system:'synthetic',user:'synthetic',model:'gpt-6-luna',schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},meta:{task:'repair',phase:'humanization_depth_retry'}};
    await client.completeJson(opts);
    await ledger.withPolicy({optional:false,stage:'semantic_document'},()=>client.completeJson({...opts,meta:{task:'repair',phase:'primary:repair'}}));
    await client.completeJson({...opts,meta:{task:'repair',phase:'post_semantic_noop_recovery'}});
  });
  assert.deepEqual(priorities,['normal','late','late']);assert.deepEqual(deadlines,['normal','late','late']);
});

async function withJudgeStub(stub,fn){
  const clientPath=require.resolve('../engine-gpt-prod/openaiClient'),judgePath=require.resolve('../engine-gpt-prod/judge');
  const oldClient=require.cache[clientPath],oldJudge=require.cache[judgePath];
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{completeJson:stub}};
  delete require.cache[judgePath];
  try{return await fn(require(judgePath));}finally{if(oldClient)require.cache[clientPath]=oldClient;else delete require.cache[clientPath];if(oldJudge)require.cache[judgePath]=oldJudge;else delete require.cache[judgePath];}
}
const src='관측 자료는 경향을 보여 주지만 원인을 입증한 것은 아니다.';
const out='관측 자료는 원인을 입증했다.';
const violation={type:'distortion',span:'원인을 입증했다',detail:'관측 경향을 인과 입증으로 바꾸었다.'};
const reply={json:{violations:[violation]},usage:{estimatedUsd:.01,inputTokens:10,outputTokens:5,totalTokens:15},model:'gpt-6-luna'};

test('a timed-out optional repair retains completed verdict and failed-call cost',async()=>{
  let calls=0;
  await withJudgeStub(async()=>{if(++calls===1)return reply;throw Object.assign(new Error('timeout'),{code:'OPENAI_TIMEOUT',usage:{estimatedUsd:.03,totalTokens:30}});},async judge=>{
    const result=await judge.judgeAndRepair(src,out,{config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-luna',repair:'gpt-6-luna'}}});
    assert.equal(result.pass,false);assert.equal(result.outputText,out);
    assert.equal(result.violations[0].span,violation.span);
    assert.equal(result.reason,'repair_call_failed');assert.equal(result.usage.estimatedUsd,.04);
  });
});

test('failed escalation cannot discard a completed primary violation report',async()=>{
  let calls=0;
  await withJudgeStub(async()=>{if(++calls===1)return reply;throw Object.assign(new Error('timeout'),{code:'OPENAI_TIMEOUT',usage:{estimatedUsd:.03,totalTokens:30}});},async judge=>{
    const result=await judge.judgeAndRepair(src,out,{maxRounds:0,config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-sol'}}});
    assert.equal(result.pass,false);assert.equal(result.escalationFailed,true);
    assert.equal(result.violations[0].span,violation.span);assert.equal(result.usage.estimatedUsd,.04);
  });
});
