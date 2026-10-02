'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const dedupe=require('../engine/dedupe');
const source='실험을 수행했다. 그 결과 조건에 따른 차이를 자세하게 확인했다.';
const candidate=source.replace('그 결과','그 결과 그 결과');
test('source-attested whole sentence enables safe local phrase-copy removal and audit',()=>{
  const repair=dedupe.removeGeneratedLocalOverlapDuplicates(source,candidate);
  assert.equal(repair.text,source);
  assert.ok(repair.reasons.includes('source_attested_adjacent_phrase_copy'));
  assert.equal(dedupe.auditGeneratedDuplicateIntegrity(source,candidate).pass,false);
  assert.equal(dedupe.auditGeneratedDuplicateIntegrity(source,repair.text).pass,true);
  assert.equal(dedupe.removeGeneratedLocalOverlapDuplicates(source,repair.text).applied,false);
});
test('source repeats, quotes, code, unattested or ambiguous sentences are untouched',()=>{
  for(const [a,b] of [[candidate,candidate],[source+' '+source,candidate],
    [source.replace('자세하게','빠르게'),candidate],
    ['“'+source+'”','“'+candidate+'”'],['`'+source+'`','`'+candidate+'`']]) {
    assert.equal(dedupe.removeGeneratedLocalOverlapDuplicates(a,b).text,b);
  }
});
test('same evidence contract covers other phrases without a connector whitelist',()=>{
  const a='실험 기록의 해당 항목을 다시 검토하면서 변화 과정을 확인했다.';
  const b=a.replace('해당 항목을','해당 항목을 해당 항목을');
  assert.equal(dedupe.removeGeneratedLocalOverlapDuplicates(a,b).text,a);
});
test('shared candidate gate rejects a new copy and final gate accepts the attested repair',()=>{
  const options={source,documentProfile:{profile:'report_assignment'},mode:'assignment'};
  const audit=require('../engine-gpt-prod/candidateIntegrity').auditCandidateIntegrity({...options,before:source,candidate});
  assert.ok(audit.reasons.includes('source_replay_worsened'));
  const fixed=require('../engine-gpt-prod').applyFinalGeneratedDedupe({...options,outputText:candidate});
  assert.equal(fixed.text,source);
  assert.equal(fixed.rejected,false);
  assert.equal(fixed.removedLocalOverlapCount,1);
});
