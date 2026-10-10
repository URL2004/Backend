'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('semantic transport admits open windows and ignores undersized timeout overrides',async t=>{
 const oldFetch=global.fetch,oldTimer=global.setTimeout,oldKey=process.env.OPENAI_API_KEY,oldLimit=process.env.OPENAI_API_TIMEOUT_MS;
 process.env.OPENAI_API_KEY='test';delete process.env.OPENAI_API_TIMEOUT_MS;
 const timers=[];global.setTimeout=(fn,ms,...args)=>{timers.push(ms);return oldTimer(fn,ms,...args);};
 global.fetch=async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:10,output_tokens:5}});
 t.after(()=>{global.fetch=oldFetch;global.setTimeout=oldTimer;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;if(oldLimit===undefined)delete process.env.OPENAI_API_TIMEOUT_MS;else process.env.OPENAI_API_TIMEOUT_MS=oldLimit;});
 const call=require('../engine-gpt-prod/openaiClient').completeJson;
 const opts={model:'gpt-6-sol',reasoningEffort:'high',system:'synthetic',user:'synthetic',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},meta:{task:'judge',phase:'escalation:semantic'}};
 for(const remaining of [120000,40000]) assert.equal((await call({...opts,deadlineMs:Date.now()+remaining})).json.ok,true);
 assert.deepEqual(timers,[180000,180000]);timers.length=0;
 process.env.OPENAI_API_TIMEOUT_MS='7000';await call({...opts,deadlineMs:Date.now()+190000});assert.ok(timers.includes(180000));timers.length=0;
 delete process.env.OPENAI_API_TIMEOUT_MS;await call({...opts,meta:{task:'repair',phase:'primary:repair'},deadlineMs:Date.now()+120000});assert.ok(timers.includes(110112));
});
