'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {semanticReviewEnvelope:limit}=require('../engine-gpt-prod/semanticReviewEnvelope');
test('ordinary primary and confirming envelopes stay unchanged',()=>{
  assert.equal(limit(),6000);assert.equal(limit({operatorCount:4}),6000);
  assert.equal(limit({confirming:true}),10000);
});
test('explicit review workload reserves monotonic bounded room for reasoning plus JSON',()=>{
  assert.equal(limit({operatorCount:12}),10000);
  assert.equal(limit({operatorCount:4,obligationCount:4}),8000);
  for(let n=0;n<50;n++){
    assert.ok(limit({operatorCount:n})>=6000&&limit({operatorCount:n})<=10000);
    assert.ok(limit({operatorCount:n+1})>=limit({operatorCount:n}));
  }
  assert.equal(limit({operatorCount:NaN,obligationCount:-2}),6000);
});
test('confirming explicit reviews receive bounded headroom without weakening coverage',()=>{
  assert.equal(limit({confirming:true,operatorCount:10}),15000);
  assert.equal(limit({confirming:true,operatorCount:4,obligationCount:6}),15000);
  assert.equal(limit({confirming:true,operatorCount:2.9,obligationCount:-1}),11000);
  assert.equal(limit({confirming:true,operatorCount:NaN,obligationCount:Infinity}),10000);
  for(let n=0;n<50;n++){
    const a=limit({confirming:true,operatorCount:n});
    assert.ok(a>=10000&&a<=16000);
    assert.ok(limit({confirming:true,operatorCount:n+1})>=a);
  }
});
