'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const outcome = require('../engine-gpt-prod/finalSemanticOutcome');
const semantic = require('../engine-gpt-prod/semanticProvenance');
const { groundViolation } = require('../engine-gpt-prod/judge');
const source = '참가자는 실험 장비를 자유롭게 사용해 볼 수 있는 환경이었다.';
const candidate = '참가자는 실험 장비를 자유롭게 사용하는 환경이었다.';
const finding = groundViolation({type:'distortion',sourceSpan:source,candidateSpan:candidate,
  span:candidate,relation:'modality_negation_causality',origin:'introduced'},source,candidate);
const section = {pass:false,verificationCompleted:true,violations:[finding]};
const interrupted = semantic.bindSemanticValidation({ran:true,pass:false,uncertain:true,
  verificationCompleted:false,outputText:candidate,usage:{estimatedUsd:.04},
  progress:{expectedSections:3,completedSections:1},reports:[section,
    {pass:false,verificationCompleted:false,violations:[],usage:{estimatedUsd:.03}}]},source,candidate);

test('interrupted final audit retains completed findings, usage and incomplete status, not the old pass',()=>{
  const prior={ran:true,pass:true,verificationCompleted:true,repairCount:2};
  const retained=outcome.retainIncompleteFinalAudit(prior,interrupted);
  assert.equal(retained.pass,false);assert.equal(retained.verificationCompleted,false);
  assert.equal(retained.repairCount,2);assert.equal(retained.usage.estimatedUsd,.04);
  assert.equal(retained.progress.completedSections,1);
  assert.deepEqual(retained.reports,interrupted.reports);
  assert.equal(semantic.verifySemanticValidation(retained,{source,candidate,requireDigest:true}).status,'uncertain');
  assert.deepEqual(outcome.completedFinalFindings(retained,source,candidate),[finding]);
});

test('incomplete cannot become a pass even with contradictory flags or a legacy validated status',()=>{
  const report=semantic.bindSemanticValidation({ran:true,pass:true,verificationCompleted:false},source,candidate);
  assert.equal(report.validation.status,'uncertain');
  report.validation.status='validated_pass';
  assert.equal(semantic.verifySemanticValidation(report,{source,candidate,requireDigest:true}).status,'uncertain');
});

test('unfinished/uncertain sections and stale, repeated or source-only pairs cannot constrain fallback',()=>{
  for(const row of [{...section,verificationCompleted:false},{...section,uncertain:true},
    {...section,pass:true},{...section,skipped:true},
    {...section,violations:[{...finding,origin:'source_issue'}]},
    {...section,violations:[{...finding,spanVerified:false}]}])
    assert.deepEqual(outcome.completedFinalFindings({reports:[row]},source,candidate),[]);
  assert.deepEqual(outcome.completedFinalFindings(interrupted,source,candidate+' '+candidate),[]);
  assert.deepEqual(outcome.completedFinalFindings(interrupted,source,source),[]);
});

test('completed failures prevent selecting an older pass with the same confirmed error',()=>{
  const api=require('../engine-gpt-prod/candidateLedger');
  const ledger=api.createCandidateLedger({source,assess:()=>({hardViolationCodes:[],languageViolationCodes:[],
    languageRisk:0,transformed:true,minimumEffectPass:true})});
  ledger.record({stage:'old_pass',text:candidate,semanticReport:semantic.bindSemanticValidation({ran:true,pass:true},source,candidate)});
  const current=ledger.record({stage:'interrupted',text:candidate,semanticReport:interrupted});
  const choice=ledger.chooseFinal(current.id,{knownViolations:outcome.completedFinalFindings(interrupted,source,candidate)});
  assert.equal(choice.applied,false);
  assert.equal(choice.reason,'no_safe_transformed_candidate');
});

test('production final handling retains the actual report and uses completed findings for fallback',()=>{
  const code=require('node:fs').readFileSync(require.resolve('../engine-gpt-prod'),'utf8');
  assert.match(code,/semanticReport = outcome\.retainIncompleteFinalAudit\(priorReport, recheck\)/u);
  assert.match(code,/finalSemanticRevalidation\.completedFindings = outcome\.completedFinalFindings/u);
  assert.match(code,/: finalSemanticRevalidation\.completedFindings \|\| \[\]/u);
});
