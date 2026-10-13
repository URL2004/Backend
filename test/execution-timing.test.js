'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {executionTiming}=require('../lib/executionTiming');
const row=(startedAtMs,finishedAtMs)=>({startedAtMs,finishedAtMs});
test('later refinement excludes the time spent reading the completed result',()=>{
  assert.deepEqual(executionTiming({observed:true,attemptCount:2,attempts:[row(1000,21000),row(1301000,1316000)]}),{
    executionDurationMs:35000,observedExecutionDurationMs:35000,executionDurationCoverage:'complete'});
});
test('interrupted or truncated attempts expose only observed time',()=>{
  for(const extra of [{attempts:[row(1000,undefined),row(100000,110000)],attemptCount:2},{attempts:[row(100000,110000)],attemptCount:2,truncated:true}]){
    const result=executionTiming({observed:true,...extra});assert.equal(result.executionDurationMs,null);assert.equal(result.observedExecutionDurationMs,10000);assert.equal(result.executionDurationCoverage,'partial');
  }
});
test('overlapping intervals are not double counted and absent evidence is not zero',()=>{
  assert.equal(executionTiming({observed:true,attemptCount:2,attempts:[row(10,40),row(20,50)]}).executionDurationMs,40);
  assert.equal(executionTiming({}).executionDurationMs,null);
  assert.equal(executionTiming({observed:true,attemptCount:1,attempts:[row(10,10)]}).executionDurationMs,0);
});
