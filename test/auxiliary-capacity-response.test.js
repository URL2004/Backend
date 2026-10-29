'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createExecutionCoordinator}=require('../lib/transformExecution');
const {responseForDenial}=require('../lib/auxiliaryAdmission');
test('capacity is distinct from account exclusivity and never starts duplicate execution',async()=>{
 const coordinator=createExecutionCoordinator({db:null,caps:{short:1,formal:1},totalCap:1});
 const first=await coordinator.acquireDetailed({id:'first',uid:'alice',mode:'blog'},'main');
 assert.ok(first.lease);
 const own=await coordinator.acquireDetailed({id:'refine',uid:'alice',mode:'blog'},'refine');
 assert.equal(own.lease,null);assert.equal(own.reason,'user_busy');
 const other=await coordinator.acquireDetailed({id:'second',uid:'bob',mode:'blog'},'refine');
 assert.equal(other.lease,null);assert.equal(other.reason,'capacity');
 assert.equal(responseForDenial(other.reason).status,503);
 assert.equal(responseForDenial(other.reason).body.billingState,'not_started');
 assert.equal(responseForDenial(own.reason).body.retryable,false);
 await coordinator.release(first.lease);
 const retry=await coordinator.acquireDetailed({id:'second',uid:'bob',mode:'blog'},'refine');
 assert.ok(retry.lease);assert.equal(retry.reason,'');
 assert.equal(await coordinator.acquire({id:'third',uid:'carol',mode:'blog'},'main'),null);
 await coordinator.release(retry.lease);
});
test('state and deletion denials never authorize automatic retry or expose another owner',()=>{
 for(const reason of ['account_deletion','job_state_changed','unavailable']){
  const r=responseForDenial(reason);assert.equal(r.status,409);assert.equal(r.body.retryable,false);
  assert.equal(r.body.retryAfterMs,undefined);assert.equal(r.body.billingState,'not_started');
 }
});
