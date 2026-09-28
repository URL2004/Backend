'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prepareFinalRelationRepair, selectFinalRepairEvidence } = require('../engine-gpt-prod/finalRelationRepair');
const { groundViolation } = require('../engine-gpt-prod/judge');
const a = '전압 차이는 정상 범위 안에서 나타나는 차이를 의미한다.';
const b = '전압 차이는 정상 범위를 벗어난 정도를 의미한다.';
const c = '과거 연출가인 수민은 공연을 제안했지만 현재에는 기자인 하준이 자료를 공개한 경위를 추궁한다.';
const d = '과거의 수민은 공연을 제안했다. 공연을 허용해야 한다는 입장이었다. 현재 하준은 기자가 되어 자료를 공개했다. 공개 경위를 두고 추궁이 이어진다.';
const fixed = d.replace('공개 경위를 두고 추궁이 이어진다.', '수민은 하준이 자료를 공개한 경위를 추궁한다.');
const tail = '별도 문서는 다음 달에 공개한다. 행사 장소는 추후 공지한다. 담당자는 자료를 보관한다. 관찰 결과는 날짜 순서로 정리한다. 참여자의 의견을 수렴한다. 실험 장비를 점검한다.';
const source = `${a} ${c} ${tail}`, output = `${b} ${d} ${tail}`;
const report = { pass:false, verificationCompleted:true, violations:[
  [a,b,'condition_result'],[c,d,'actor_action_target']
].map(([sourceSpan,candidateSpan,relation])=>groundViolation({type:'distortion',span:candidateSpan,
  sourceSpan,candidateSpan,relation,origin:'introduced'},source,output)) };
const opts = {deadlineMs:120000,now:()=>0,assessLiteral:()=>({pass:true}),assessPatch:()=>({pass:true}),structurePreserved:()=>true};

test('explicit unrelated uncertainty cannot veto confirmed targets or grant semantic pass',async()=>{
 const mixed={...report,uncertain:true,violations:[...report.violations,
   {type:'omission',origin:'unconfirmed',repairable:false,relationGrounded:false,span:'unlocated'}]};
 assert.equal(selectFinalRepairEvidence(source,output,mixed,'uncertain'),mixed);
 let calls=0;
 const result=await prepareFinalRelationRepair(source,output,mixed,{...opts,repair:async(base,findings)=>{
   calls++;assert.equal(findings.length,1);assert.equal(findings[0].origin,'introduced');
   return {outputText:base.replace(d,fixed),repaired:true};
 }});
 assert.equal(calls,1);assert.equal(result.text,`${a} ${fixed} ${tail}`);assert.equal(result.pass,undefined);
 assert.equal(selectFinalRepairEvidence(source,output,{...report,uncertain:true},'uncertain'),null);
});

test('partial literal restoration does not suppress remaining exact patch; shifted offsets are rebuilt', async()=>{
  let count=0;
  const result=await prepareFinalRelationRepair(source,output,report,{...opts,repair:async(base,findings,deadline)=>{
    count++;assert.ok(base.startsWith(a));assert.equal(findings.length,1);assert.equal(findings[0].candidateSpan,d);
    assert.equal(deadline,30000);return {outputText:base.replace(d,fixed),repaired:true};
  }});
  assert.equal(count,1);assert.equal(result.restoredCount,1);assert.equal(result.patchedCount,1);
  assert.equal(result.text,`${a} ${fixed} ${tail}`);assert.equal(result.pass,undefined);
});
for(const reason of ['throw','reject','deadline','round','uncertain']) test(`partial restoration survives ${reason} without invented pass`,async()=>{
  const result=await prepareFinalRelationRepair(source,output,{...report,...(reason==='uncertain'?{uncertain:true}: {})},{...opts,
    ...(reason==='deadline'?{deadlineMs:100000}:{}),...(reason==='round'?{allowPatch:false}:{}),
    repair:async()=>{if(reason==='throw')throw Object.assign(Error(),{code:'CANCELLED'});return{repaired:false};}
  });
  if(reason!=='uncertain')assert.equal(result.text,`${a} ${d} ${tail}`);
  assert.equal(result.patchedCount,0);assert.equal(result.pass,undefined);
});
test('incomplete/unlocated/source issues cannot start final repair',async()=>{
  for(const r of [{...report,verificationCompleted:false},{...report,pass:true},
    {...report,violations:report.violations.map(v=>({...v,repairable:false,origin:'source_issue'}))}]){
    const out=await prepareFinalRelationRepair(source,output,r,{...opts,repair:()=>assert.fail('must not call')});
    assert.equal(out.applied,false);
  }
});

test('a stale later pass cannot erase unchanged exact prior findings; exact pass stays final', async()=>{
  const later={pass:true,verificationCompleted:true,violations:[]};
  const selected=selectFinalRepairEvidence(source,output,later,'stale',[report]);
  assert.equal(selected.nominationOnly,true);
  assert.equal(selected.violations.length,2);
  const proposed=await prepareFinalRelationRepair(source,output,selected,{...opts,
    repair:async(base)=>({outputText:base.replace(d,fixed),repaired:true})});
  assert.equal(proposed.text,`${a} ${fixed} ${tail}`);
  assert.equal(proposed.pass,undefined);
  assert.equal(selectFinalRepairEvidence(source,output,later,'pass',[report]),null);
  assert.equal(selectFinalRepairEvidence(source,proposed.text,later,'stale',[report]),null);
});

test('prior uncertain, incomplete, repeated or source-only findings never nominate a stale repair',()=>{
  const later={pass:true};
  for(const r of [{...report,uncertain:true},{...report,verificationCompleted:false},
    {...report,violations:report.violations.map(v=>({...v,origin:'source_issue'}))}])
    assert.equal(selectFinalRepairEvidence(source,output,later,'stale',[r]),null);
  assert.equal(selectFinalRepairEvidence(source,output+' '+output,later,'stale',[report]),null);
});
