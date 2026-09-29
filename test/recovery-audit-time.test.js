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
