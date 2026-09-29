'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRecoveryBudget}=require('../engine-gpt-prod/recoveryBudget');
const ledger=require('../engine-gpt-prod/callLedger');

test('mandatory audits do not consume the optional wall-time allowance or extend the job deadline',()=>{
  let now=1000;
  const b=createRecoveryBudget(1,{clock:()=>now,maxElapsedMs:240000,jobDeadlineMs:1000000});
  now+=30000;const end=b.beginMandatoryAudit();now+=300000;end();end();
  assert.equal(b.snapshot().elapsedMs,30000);
  assert.equal(b.snapshot().mandatoryExcludedMs,300000);
  assert.equal(b.snapshot().wallElapsedMs,330000);
  assert.equal(b.deadlineMs(),now+210000);
  now+=210000;
  assert.equal(b.canStart({priority:'late'}),false);
  assert.equal(b.snapshot().timeLimitExhausted,true);
  const end2=b.beginMandatoryAudit();now=990000;end2();
  assert.ok(b.deadlineMs()<=880000,'same job deadline minus final reserve');
});

test('overlapping mandatory audits are excluded once; concurrent optional calls still spend time',()=>{
  let now=0;const b=createRecoveryBudget(1,{clock:()=>now,maxElapsedMs:240000});
  const end1=b.beginMandatoryAudit();now=10000;const end2=b.beginMandatoryAudit();
  now=20000;const r=b.reserveCall(.1,{priority:'late'});
  now=60000;end1();now=70000;b.settleCall(r,{estimatedUsd:.05});
  now=100000;end2();
  assert.equal(b.snapshot().elapsedMs,50000);
  assert.equal(b.snapshot().mandatoryExcludedMs,50000);
  assert.equal(b.snapshot().spentUsd,.05);
});

test('mandatory audit failure closes the exclusion; optional and repair tasks never pause it',async()=>{
  let now=0;const b=createRecoveryBudget(1,{clock:()=>now,maxElapsedMs:240000});
  await ledger.run(async()=>{
    ledger.setRecoveryBudget(b);
    await assert.rejects(ledger.withPolicy({optional:false},()=>ledger.track({meta:{task:'judge'}},async()=>{
      now=100000;throw new Error('synthetic_abort');
    })),/synthetic_abort/);
    await ledger.withPolicy({optional:true},()=>ledger.track({meta:{task:'judge'}},async()=>{
      now=130000;return {usage:{estimatedUsd:0}};
    }));
    await ledger.withPolicy({optional:false},()=>ledger.track({meta:{task:'repair'}},async()=>{
      now=150000;return {usage:{estimatedUsd:0}};
    }));
    assert.equal(b.snapshot().mandatoryExcludedMs,100000);
    assert.equal(b.snapshot().elapsedMs,50000);
    assert.equal(ledger.snapshot().entries.length,3);
  });
});

test('excluding time never changes money, attempt limits or unknown reservations',()=>{
  let now=0;const b=createRecoveryBudget(.1,{clock:()=>now,maxCalls:2,reservedLateCalls:0});
  const id=b.reserveCall(.1,{priority:'late'});now=20000;b.settleCall(id,null);
  const end=b.beginMandatoryAudit();now=500000;end();
  assert.equal(b.reserveCall(.01,{priority:'late'}),null);
  assert.equal(b.snapshot().unknownUsageUsd,.1);
  assert.equal(b.snapshot().attemptedCallCount,1);
  assert.equal(b.snapshot().lastDeniedReason,'recovery_budget_exhausted');
});

test('long-document optional recovery reserves the full approved final audit without extending the job',()=>{
  let now=1000;
  const long=createRecoveryBudget(1,{clock:()=>now,jobDeadlineMs:301000,finalAuditReserveMs:180000});
  assert.equal(long.canStart({priority:'late'}),true);
  assert.equal(long.deadlineMs(),121000);
  now=1001;
  assert.equal(long.canStart({priority:'late'}),false);
  assert.equal(long.denialReason({priority:'late'}),'recovery_final_audit_time_reserved');
  assert.equal(long.snapshot().finalAuditReserveMs,180000);
  const normal=createRecoveryBudget(1,{clock:()=>now,jobDeadlineMs:301000});
  assert.equal(normal.canStart({priority:'late'}),true);
  assert.equal(normal.snapshot().finalAuditReserveMs,120000);
  assert.equal(createRecoveryBudget(1,{finalAuditReserveMs:999999}).snapshot().finalAuditReserveMs,180000);
  assert.equal(createRecoveryBudget(1,{finalAuditReserveMs:-10}).snapshot().finalAuditReserveMs,120000);
});

test('a candidate growing into the long audit envelope can only increase the final reserve',()=>{
  let now=0;
  const budget=createRecoveryBudget(1,{clock:()=>now,jobDeadlineMs:300000});
  assert.equal(budget.snapshot().finalAuditReserveMs,120000);
  assert.equal(budget.raiseFinalAuditReserve(180000),180000);
  assert.equal(budget.raiseFinalAuditReserve(120000),180000);
  assert.equal(budget.raiseFinalAuditReserve(NaN),180000);
  assert.equal(budget.deadlineMs(),120000);
  now=1;
  assert.equal(budget.canStart({priority:'late'}),false);
});

test('every admission observes current candidate growth before reserving an optional call',()=>{
  let chars=5900;
  const budget=createRecoveryBudget(1,{clock:()=>1,jobDeadlineMs:300000,
    getFinalAuditReserveMs:()=>chars>6000?180000:120000});
  assert.equal(budget.canStart({priority:'late'}),true);
  chars=6100;
  assert.equal(budget.reserveCall(.01,{priority:'late'}),null);
  assert.equal(budget.snapshot().attemptedCallCount,0);
  assert.equal(budget.deadlineMs(),120000);
  chars=5000;
  assert.equal(budget.snapshot().finalAuditReserveMs,180000);
  const failedReader=createRecoveryBudget(1,{clock:()=>1,jobDeadlineMs:300000,
    getFinalAuditReserveMs:()=>{throw new Error('synthetic');}});
  assert.equal(failedReader.canStart({priority:'late'}),false);
  assert.equal(failedReader.snapshot().finalAuditReserveMs,180000);
});
