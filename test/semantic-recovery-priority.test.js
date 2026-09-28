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

for(const verdict of ['pass','fail','timeout']) test(`confirmed operator repair requires fresh verdict: ${verdict}`,async()=>{
  const a='참여자들이 새로운 관측 기구를 함께 만드는 과정은 흥미로웠다.';
  const b='새로운 관측 기구를 참여자들이 함께 만드는 과정이 무척 흥미로웠다.';
  const tail=' 담당자는 다음 날 측정 장비를 점검했다. 관찰 기록은 자료실에 따로 보관했다.'.repeat(12);
  const source=a+tail,output=b+tail,expected=b.replace('무척 ','')+tail;
  const finding={type:'intensity_amplification',span:'무척 흥미로웠다',sourceSpan:a,candidateSpan:b,
    detail:'원문에 없던 정도 강화',origin:'introduced',relation:'modality_negation_causality'};
  const phases=[];
  await withJudgeStub(async opts=>{
    phases.push(opts.meta.phase);
    if(phases.length===1)return {...reply,json:{violations:[finding]}};
    assert.equal(phases.length,2);
    assert.ok(opts.user.includes(expected));
    if(verdict==='timeout')throw Object.assign(new Error('timeout'),{code:'OPENAI_TIMEOUT',usage:{estimatedUsd:.03}});
    return {...reply,json:require('./helpers/semantic-review-fixture.cjs')({violations:verdict==='pass'?[]:[{type:'distortion',span:'찾을 수 없는 문장',detail:'대응 불명'}]},opts.user)};
  },async judge=>{
    const options={maxRounds:1,config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-luna',repair:'gpt-6-luna'}}};
    if(verdict==='timeout') {
      const result=await judge.judgeAndRepair(source,output,options);
      assert.equal(result.outputText,output);assert.equal(result.pass,false);
      assert.equal(result.reason,'repair_verification_failed');
      assert.equal(result.verificationCompleted,true);assert.equal(result.usage.estimatedUsd,.04);
      assert.equal(result.violations.length,1);
    }
    else {
      const result=await judge.judgeAndRepair(source,output,options);
      assert.equal(result.pass,verdict==='pass');assert.equal(result.outputText,expected);
      assert.equal(result.usage.estimatedUsd,.02);
    }
  });
  assert.deepEqual(phases,['primary:semantic','primary:semantic_after_repair']);
});

test('a timed-out optional repair retains completed verdict and failed-call cost',async()=>{
  let calls=0;
  await withJudgeStub(async()=>{if(++calls===1)return reply;throw Object.assign(new Error('timeout'),{code:'OPENAI_TIMEOUT',usage:{estimatedUsd:.03,totalTokens:30}});},async judge=>{
    const result=await judge.judgeAndRepair(src,out,{config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-luna',repair:'gpt-6-luna'}}});
    assert.equal(result.pass,false);assert.equal(result.outputText,out);
    assert.equal(result.violations[0].span,violation.span);
    assert.equal(result.reason,'repair_call_failed');assert.equal(result.usage.estimatedUsd,.04);
  });
});

test('truncated repair verification reaches the existing escalation on the last verified text',async()=>{
  const a='참여자들이 새로운 관측 기구를 함께 만드는 과정은 흥미로웠다.';
  const b='새로운 관측 기구를 참여자들이 함께 만드는 과정이 무척 흥미로웠다.';
  const tail=' 담당자는 다음 날 측정 장비를 점검했다. 관찰 기록은 자료실에 따로 보관했다.'.repeat(12);
  const finding={type:'intensity_amplification',span:'무척 흥미로웠다',sourceSpan:a,candidateSpan:b,
    detail:'원문에 없던 정도 강화',origin:'introduced',relation:'modality_negation_causality'};
  const phases=[];let repairReservations=0;
  await withJudgeStub(async opts=>{
    phases.push(opts.meta.phase);
    if(phases.length===2)throw Object.assign(new Error('truncated'),{code:'OPENAI_TRUNCATED',usage:{estimatedUsd:.03}});
    if(phases.length===3){assert.equal(opts.model,'gpt-6-sol');assert.ok(opts.user.includes(b+tail));}
    return {...reply,json:require('./helpers/semantic-review-fixture.cjs')({violations:[finding]},opts.user)};
  },async judge=>{
    const result=await judge.judgeAndRepair(a+tail,b+tail,{maxRounds:1,reserveRepair:()=>{repairReservations++;return true;},
      config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-sol',repair:'gpt-6-luna'}}});
    assert.equal(result.pass,false);assert.equal(result.escalated,true);
    assert.equal(result.outputText,b+tail);assert.equal(result.rounds,1);
    assert.equal(repairReservations,1);assert.equal(result.usage.estimatedUsd,.05);
    assert.ok(result.repairRejectReasons.includes('repair_verification_failed'));
  });
  assert.deepEqual(phases,['primary:semantic','primary:semantic_after_repair','escalation:semantic']);
});

test('failed escalation cannot discard a completed primary violation report',async()=>{
  let calls=0;
  await withJudgeStub(async()=>{if(++calls===1)return reply;throw Object.assign(new Error('timeout'),{code:'OPENAI_TIMEOUT',usage:{estimatedUsd:.03,totalTokens:30}});},async judge=>{
    const result=await judge.judgeAndRepair(src,out,{maxRounds:0,config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-sol'}}});
    assert.equal(result.pass,false);assert.equal(result.escalationFailed,true);
    assert.equal(result.violations[0].span,violation.span);assert.equal(result.usage.estimatedUsd,.04);
  });
});

for(const phase of ['repair','escalation']) test(`cancelled ${phase} preserves prior findings and both billed costs`,async()=>{
  let calls=0;
  await withJudgeStub(async()=>{if(++calls===1)return reply;throw Object.assign(new Error('cancelled'),{code:'ABORT_ERR',usage:{estimatedUsd:.03,totalTokens:30}});},async judge=>{
    await assert.rejects(judge.judgeAndRepair(src,out,{maxRounds:phase==='repair'?1:0,config:{models:{judge:'gpt-6-luna',judgeEscalation:phase==='repair'?'gpt-6-luna':'gpt-6-sol',repair:'gpt-6-luna'}}}),error=>{
      assert.equal(error.usage.estimatedUsd,.04);assert.equal(error.partialSemanticReport.pass,false);
      assert.equal(error.partialSemanticReport.verificationCompleted,false);
      assert.equal(error.partialSemanticReport.violations[0].span,violation.span);return true;
    });
  });
});
