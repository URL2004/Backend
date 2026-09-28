'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selectFinalRepairEvidence } = require('../engine-gpt-prod/finalRelationRepair');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { obligationId } = require('../engine-gpt-prod/semanticObligations');
const { scheduleReviewPairs, planVerdictPairs } = require('../engine-gpt-prod/semanticAuditSchedule');
const a = '운영자는 기존 장비를 사용할 수 있는 여건을 마련했다.';
const b = '운영자는 기존 장비를 실제로 사용하여 결과를 확인했다.';
const finding = groundViolation({type:'distortion',span:b,sourceSpan:a,candidateSpan:b,
  relation:'modality_negation_causality',origin:'introduced'},a,b);
const prior = {pass:false,verificationCompleted:true,violations:[finding]};
test('unfinished/empty current verdict retains exact prior proposal, never a pass',()=>{
  for (const current of [{pass:false,verificationCompleted:false,reports:[]},
    {pass:false,verificationCompleted:true,uncertain:true,violations:[]}]) {
    const before=JSON.stringify(current);
    const result=selectFinalRepairEvidence(a,b,current,'uncertain',[prior,prior]);
    assert.equal(result.nominationOnly,true);assert.equal(result.pass,false);
    assert.equal(result.violations.length,1);assert.equal(JSON.stringify(current),before);
  }
});
test('explicit current dismissal applies only to its grounded exact pair',()=>{
  const review={id:obligationId(finding),status:'not_error',sourceSpan:a,candidateSpan:b,
    detail:'The same meaning is present in the current context.'};
  const current={pass:false,verificationCompleted:false,reports:[{
    pass:true,verificationCompleted:true,obligationReviews:[review]}]};
  assert.equal(selectFinalRepairEvidence(a,b,current,'uncertain',[prior]),null);
  assert.equal(selectFinalRepairEvidence(a,b,{pass:false,verificationCompleted:false},'uncertain',
    [prior,current.reports[0]]),null);
  for(const change of [{verificationCompleted:false},{obligationReviews:[{...review,candidateSpan:'unlocated'}]}]) {
    const changed={...current,reports:[{...current.reports[0],...change}]};
    assert.equal(selectFinalRepairEvidence(a,b,changed,'uncertain',[prior]).violations.length,1);
  }
});
test('prior nomination never uses changed, repeated, unconfirmed or incomplete evidence',()=>{
  const current={pass:false,verificationCompleted:false};
  assert.equal(selectFinalRepairEvidence(a,b,current,'pass',[prior]),null);
  assert.equal(selectFinalRepairEvidence(a,b.replace('기존','신규'),current,'uncertain',[prior]),null);
  assert.equal(selectFinalRepairEvidence(a,b+' '+b,current,'uncertain',[prior]),null);
  for(const changed of [{...prior,verificationCompleted:false},{...prior,uncertain:true},
    {...prior,violations:[{...finding,origin:'unconfirmed'}]}])
    assert.equal(selectFinalRepairEvidence(a,b,current,'uncertain',[changed]),null);
});
test('verdict-only scheduling preserves ownership, concurrency and repair ordering',async()=>{
  const pairs=[2,9,4,5].map((n,index)=>({index,sourceContext:'s'.repeat(n),output:String(index).repeat(n)}));
  assert.deepEqual(scheduleReviewPairs(pairs,true).map(r=>r.index),[0,1,2,3]);
  assert.deepEqual(scheduleReviewPairs(pairs,false).map(r=>r.index),[1,3,2,0]);
  for(let seed=0;seed<10;seed++) {
    let active=0,peak=0;const outputs=[];
    await require('../engine-gpt-prod/concurrency').mapWithConcurrency(scheduleReviewPairs(pairs,false),2,async({pair,index})=>{
      active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,(index+seed)%3));
      outputs[index]=pair.output;active--;
    });
    assert.equal(peak,2);assert.deepEqual(outputs,pairs.map(p=>p.output));
  }
});

test('final audit packs whole heading-owned sections into two bounded concurrent windows',()=>{
  const section=(name,count)=>`\n${name} 학습 기록\n`+Array.from({length:count},(_,i)=>`관찰 ${i}의 내용을 기록했고 팀원들과 함께 실험 과정을 검토했다. `).join('');
  const source=section('①',66)+section('②',56)+section('③',54)+section('④',48);
  const pairs=require('../engine-gpt-prod/finalQualityV2').buildReviewPairs(source,source);
  assert.ok(pairs.length>2);
  const actual=planVerdictPairs(source,source,pairs,false);
  assert.equal(actual.length,2);
  assert.equal(actual.map(p=>p.sourceContext).join(''),source);
  assert.equal(actual.map(p=>p.output).join(''),source);
  assert.ok(actual.every(p=>p.sourceContext.length<=6000));
  assert.equal(planVerdictPairs(source,source,pairs,true),pairs);
  const uncertain=pairs.map(p=>({...p,alignment:'shared_monotonic_sentence'}));
  assert.equal(planVerdictPairs(source,source,uncertain,false),uncertain);
  assert.equal(planVerdictPairs(source.repeat(2),source.repeat(2),pairs,false),pairs);
});

test('confirmed new repetition can nominate a bounded exact window, not fuzzy deletion',()=>{
  const left='수업을 통해 관심 분야를 구체적으로 알게 됐다. 실험을 수행하며 새로운 원리를 배우는 일에 재미를 느꼈다.';
  const right='수업을 통해 실험을 수행하며 새로운 원리를 배워 관심 분야를 구체적으로 알게 됐다. 실험을 수행하며 새로운 원리를 배우는 일에 재미를 느꼈다.';
  const tail=Array.from({length:12},(_,i)=>`자료 ${i}의 내용을 검토하여 원래 기록과 일치하는지 확인했다.`).join(' ');
  const source=left+' '+tail, output=right+' '+tail;
  const v=groundViolation({type:'duplicate_conclusion',origin:'introduced',relation:'genre_naturalness',
    span:right,sourceSpan:left,candidateSpan:right},source,output);
  const restore=require('../engine-gpt-prod/confirmedRelationRestore').restoreConfirmedRelations;
  const report={pass:false,verificationCompleted:true,violations:[v]};
  const result=restore(source,output,report);
  assert.equal(result.text,source);assert.equal(result.restoredCount,1);assert.equal(result.pass,undefined);
  for(const changed of [{...v,repairable:false},{...v,origin:'source_issue'},
    {...v,candidateSpan:right.replace('관심','새로운 관심')}])
    assert.equal(restore(source,output,{...report,violations:[changed]}).applied,false);
  assert.equal(restore(source,output,{...report,pass:true}).applied,false);
});
