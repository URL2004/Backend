'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {completeFinalRestoration:complete}=require('../engine-gpt-prod/finalRestorationCompletion');
const base='a'.repeat(300),first='b'+base.slice(1),second='bc'+base.slice(2);
const failed={pass:false,verificationCompleted:true,violations:[]};
const initial={text:first,restoredCount:1,restorationBudget:{removed:10,added:10},applied:true};
const options=()=>({source:base,before:base,initial,deadlineMs:120000,now:()=>0,
  accepts:r=>r.pass===true&&r.verificationCompleted===true,
  observe:()=>{},propose:async()=>({text:second,applied:true,restoredCount:1,restorationBudget:{removed:10,added:10}})});
test('late findings get one literal completion, carrying all prior obligations and fresh verdict',async()=>{
  const seen=[];
  const out=await complete({...options(),verify:async(text,prior)=>{
    seen.push(text);if(text===first){assert.equal(prior.length,0);return failed;}
    assert.deepEqual(prior,[failed]);return {pass:true,verificationCompleted:true};
  }});
  assert.deepEqual(seen,[first,second]);assert.equal(out.accepted,true);
  assert.equal(out.text,second);assert.equal(out.restoredCount,2);assert.equal(out.rounds,2);
});
test('a first pass needs no additional restoration or model call',async()=>{
  const out=await complete({...options(),verify:async()=>({pass:true,verificationCompleted:true}),
    propose:()=>assert.fail('no extra repair')});
  assert.equal(out.rounds,1);assert.equal(out.text,first);
});
test('second failure retains evidence but cannot deliver either failed candidate',async()=>{
  const evidence=[];let calls=0;
  const out=await complete({...options(),verify:async()=>{calls++;return failed;},observe:x=>evidence.push(x)});
  assert.equal(calls,2);assert.equal(evidence.length,2);assert(evidence.every(e=>!e.accepted));
  assert.equal(out.accepted,false);assert.equal(out.text,undefined);
});
for(const [size,a,b,allowed] of [[13921,8,2,true],[13921,2,7,true],[300,7,2,false],[9000,8,2,false],[30000,8,8,true],[30000,8,9,false]])
test(`literal count budget scales with document length: ${size}/${a}+${b}`,async()=>{
  const source='a'.repeat(size), first='b'+source.slice(1), second='bc'+source.slice(2);let calls=0;
  const out=await complete({...options(),source,before:source,
    initial:{...initial,text:first,restoredCount:a},
    propose:async()=>({text:second,applied:true,restoredCount:b,restorationBudget:{removed:10,added:10}}),
    verify:async()=>++calls===1?failed:{pass:true,verificationCompleted:true}});
  assert.equal(out.accepted,allowed);assert.equal(calls,allowed?2:1);
});
test('a long document still cannot exceed cumulative literal byte limits',async()=>{
  let calls=0;const source='a'.repeat(14000);
  const out=await complete({...options(),source,before:source,
    initial:{...initial,text:'b'+source.slice(1),restoredCount:8,restorationBudget:{removed:4100,added:4100}},
    propose:async()=>({text:'bc'+source.slice(2),applied:true,restoredCount:2,restorationBudget:{removed:150,added:150}}),
    verify:async()=>{calls++;return failed;}});
  assert.equal(out.accepted,false);assert.equal(calls,1);
});
for(const reason of ['deadline','cancel','incomplete','budget','cycle','patch','no_target','stale_pass'])test(`bounded completion stops on ${reason}`,async()=>{
  let calls=0,tick=0;
  const o=options();
  if(reason==='patch')o.initial={...initial,patchAttempted:true};
  if(reason==='cancel')o.signal={aborted:false};
  const result=await complete({...o,now:()=>tick,verify:async()=>{
    calls++;if(reason==='deadline')tick=110000;if(reason==='cancel')o.signal.aborted=true;
    return reason==='incomplete'?{...failed,verificationCompleted:false}
      :reason==='stale_pass'?{pass:true,verificationCompleted:true}:failed;
  },accepts:()=>false,propose:async()=>reason==='no_target'?{applied:false,skipReason:'safety_ineligible'}
    :{text:reason==='cycle'?first:second,applied:true,restoredCount:1,
      restorationBudget:{removed:reason==='budget'?90:10,added:10}}});
  assert.equal(result.accepted,false);assert.equal(calls,1);assert.equal(result.text,undefined);
});
