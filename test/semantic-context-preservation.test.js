'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {semanticJudge}=require('../engine-gpt-prod/judge');
const runtime=require('../lib/gptRuntimeConfig');
test('relation contract distinguishes implicit adjacent references from changed referents and order',async t=>{
  const old=global.fetch,key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{global.fetch=old;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;});
  let instructions='';
  global.fetch=async(_url,init)=>{
    const body=require('./helpers/responses-request.cjs')(init.body);instructions=body.instructions;
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({violations:[]})}]}],
      usage:{input_tokens:10,output_tokens:10,total_tokens:20}});
  };
  await semanticJudge('관측 기록을 모았다. 그렇게 모은 기록을 검토했다.','관측 기록을 모았다. 모은 기록을 검토했다.',null,
    {config:runtime.publicConfig(runtime.DEFAULT_CONFIG,'test')});
  assert.match(instructions,/연결어·지시어 자체의 누락과 관계 정보의 누락은 구별/);
  assert.match(instructions,/선행 대상이 바뀌거나/);
  assert.match(instructions,/필수 순서·동시성·인과·범위가 실제로 달라진 경우는 계속 검출/);
  assert.match(instructions,/독자가 다르게 이해하게 되는 구체적 주장/);
});
