'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sha}=require('../lib/detectBenchmark');
const {evaluate,spearman}=require('../scripts/evaluate-nikl-writing-corpus');
const text='이 문장은 검사를 위해 직접 작성한 합성 자료다. 자료의 원래 역할을 보존한다.';
const record=(id,split='development')=>({id,kind:'raw2023',familyId:id,chars:text.length,sha256:sha(text),
  normalizedSha256:sha(text),corpusNormalizedSha256:sha(text),
  split,lineageReviewRequired:false,authorshipGoldEligible:false,permissions:{localEvaluate:true}});
test('local diagnostics leave holdout and lineage exceptions unscored',()=>{
  const records=[record('dev'),record('holdout','holdout_candidate'),{...record('issue'),lineageReviewRequired:true}];
  const result=evaluate({version:'nikl-writing-intake-v1',records},Object.fromEntries(records.map(r=>[r.id,text])));
  assert.equal(result.measured,1);assert.equal(result.excluded,2);assert.equal(result.rows[0].id,'dev');
  assert.equal(result.authorshipAccuracy,null);assert.equal(result.providersCalled,0);
  assert.equal(result.liveDetectorCalled,false);assert.equal(result.releaseEligible,false);
  const registry=require('../lib/detectDatasetRegistry').buildRegistry([result.exposureManifest]);
  assert.ok(registry.records.some(r=>r.key==='text:'+sha(text)));
});
test('changed source and fabricated authorship are rejected',()=>{
  const manifest={version:'nikl-writing-intake-v1',records:[record('a')]};
  assert.throws(()=>evaluate(manifest,{a:text+' changed'}),/text_changed/);
  manifest.records[0].authorshipGoldEligible=true;
  assert.throws(()=>evaluate(manifest,{a:text}),/authorship/);
});
test('rank correlation handles ties, constants and too few samples',()=>{
  assert.equal(spearman([[1,3],[1,3],[2,1]]),-1);
  assert.equal(spearman([[1,1],[1,2],[1,3]]),null);
  assert.equal(spearman([[1,2]]),null);
});
test('annotations are never guessed to be rewritten texts',()=>{
  const r={...record('a'),kind:'instruction2024',feedbackType:'expression',textType:'sentence'};
  const result=evaluate({version:'nikl-writing-intake-v1',records:[r]},{a:text});
  assert.equal(result.rows[0].twoRaterMean,null);assert.equal(result.completedHumanQualityReviews,0);
  assert.ok(!JSON.stringify(result).includes(text));
});
