'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../lib/gptRuntimeConfig');
const { completeJson } = require('../engine-gpt-prod/openaiClient');
const { priceFor, estimateUsd } = require('../engine-gpt-prod/usageCost');
const schema = { type:'object', properties:{value:{type:'string'}}, required:['value'], additionalProperties:false };

test('v2 stored models migrate without replacing custom reasoning/cache/escalation', async () => {
  const stored = { version:'gpt-runtime-config-v2', models:{humanizePrimary:'gpt-5.6-luna-2026-07-30',humanizeEscalation:'gpt-5.6-terra'}, reasoning:{humanize:'low',escalation:'medium'}, cache:{keyPrefix:'custom'}, escalation:{longTextChars:12345} };
  const db = {collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>stored})})})};
  const cfg = await runtime.getRuntimeConfig({db,force:true});
  assert.equal(cfg.models.humanizePrimary,'gpt-6-luna');
  assert.equal(cfg.models.humanizeEscalation,'gpt-6-sol');
  assert.equal(cfg.reasoning.humanize,'low');assert.equal(cfg.reasoning.escalation,'medium');
  assert.equal(cfg.cache.keyPrefix,'custom');assert.equal(cfg.escalation.longTextChars,12345);
  assert.equal(runtime.sanitizeConfig({models:{judge:'custom-model'},reasoning:{repair:'minimal'}}).models.judge,'custom-model');
  assert.equal(runtime.sanitizeConfig({reasoning:{repair:'minimal'}}).reasoning.repair,'low');
  runtime.clearRuntimeConfigCache();
});

test('GPT-6 standard prices include cache writes and dated IDs', () => {
  assert.deepEqual(priceFor('gpt-6-luna'),{input:.1,cachedInput:.01,cacheWrite:.125,output:.5});
  assert.deepEqual(priceFor('gpt-6-sol-2026-09-22'),{input:2,cachedInput:.2,cacheWrite:2.5,output:10});
  const usage={inputTokens:1000,cachedInputTokens:100,cacheWriteTokens:200,outputTokens:50};
  assert.equal(estimateUsd('gpt-6-luna',usage),.000121);
  assert.equal(estimateUsd('gpt-6-sol',usage),.00242);
});

test('GPT-6 requests use Responses, new cache TTL and supported efforts', async t => {
  const oldFetch=global.fetch,oldKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  const bodies=[];
  global.fetch=async(url,init)=>{assert.match(String(url),/\/responses$/);bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"value":"ok"}'}]}],usage:{input_tokens:10,output_tokens:5}}),{status:200});};
  t.after(()=>{global.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;});
  for(const model of ['gpt-6-luna','gpt-6-sol']) for(const effort of ['none','low','medium','high','xhigh','max','minimal']) {
    await completeJson({system:'test',user:'test',schema,model,reasoningEffort:effort,config:{cache:{retention:'24h'}}});
    const b=bodies.at(-1);assert.deepEqual(b.prompt_cache_options,{ttl:'30m'});assert.equal(b.prompt_cache_retention,undefined);
    assert.equal(b.reasoning.effort,effort==='minimal'?'low':effort);assert.equal(b.temperature,undefined);assert.equal(b.top_p,undefined);
  }
  const {callGpt}=require('../engine-gpt-prod/compat');
  for(const [task,effort] of [['classify','low'],['detect','low'],['humanize','medium'],['judge','medium'],['evidence_search','medium']]) {
    await callGpt({userText:'test',systemText:'test',tool:{name:'test_result',input_schema:schema},task,phase:'primary',config:runtime.DEFAULT_CONFIG});
    assert.equal(bodies.at(-1).model,'gpt-6-luna');assert.equal(bodies.at(-1).reasoning.effort,effort);
  }
  for(const task of ['detect','evidence_search','judge']) {
    await callGpt({userText:'test',systemText:'test',tool:{name:'test_result',input_schema:schema},task,phase:'escalation',config:runtime.DEFAULT_CONFIG});
    assert.equal(bodies.at(-1).model,'gpt-6-sol');assert.equal(bodies.at(-1).reasoning.effort,'high');
  }
});
