'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {auditClauseCoverage,restoreConfirmedClauseOmissions}=require('../engine-gpt-prod/clauseCoverage');
const {restoreConfirmedSemanticOmissions}=require('../engine-gpt-prod/omissionRestore');
const f=require('./fixtures/compound-claims');
const confirmed=span=>({type:'omission',span,sourceSpanVerified:true,repairable:true});
test('missing compound arm is nominated independently of the surviving arm',()=>{
 const r=auditClauseCoverage(f.source,f.output);
 assert.equal(r.candidateOnly,true);assert.equal(r.candidates.length,1);
 assert.equal(r.candidates[0].missingSpan,f.tail);
});
test('confirmed tail is restored without duplicating the rewritten first arm',()=>{
 const r=restoreConfirmedSemanticOmissions({source:f.source,outputText:f.output,semanticReport:{violations:[confirmed(f.left+f.tail)]}});
 assert.equal(r.text,[f.intro,f.rewritten,f.tail,f.conclusion].join(' '));
 assert.equal(r.restoredCount,1);assert.equal(r.remainingViolations.length,1);
 assert.equal(restoreConfirmedSemanticOmissions({source:f.source,outputText:r.text,semanticReport:{violations:[confirmed(f.tail)]}}).applied,false);
});
test('hints, ungrounded and uncertain verdicts do not authorize insertion',()=>{
 for(const semanticReport of [null,{violations:[{type:'omission',span:f.tail}]},{uncertain:true,violations:[confirmed(f.tail)]}]) {
  assert.equal(restoreConfirmedSemanticOmissions({source:f.source,outputText:f.output,semanticReport}).text,f.output);
 }
});
test('the other arm survives as a separate sentence or paragraph',()=>{
 for(const gap of [' ','\n\n'])assert.equal(auditClauseCoverage(f.source,[f.intro,f.rewritten+gap+f.tail,f.conclusion].join(' ')).semanticRequired,false);
});
test('unchanged source, protected quotation and fenced code are not missing claims',()=>{
 assert.equal(auditClauseCoverage(f.source,f.source).semanticRequired,false);
 for(const wrap of [s=>'“'+s+'”',s=>'```\n'+s+'\n```'])assert.equal(auditClauseCoverage(wrap(f.source),wrap(f.output)).semanticRequired,false);
});
test('concessive relation is judged and model-repaired, not silently changed to addition',()=>{
 const source=f.source.replace('길었으며,','길었지만,');
 const r=restoreConfirmedClauseOmissions(source,f.output,[confirmed(f.tail)]);
 assert.equal(r.candidates.length,1);assert.equal(r.text,f.output);
});
test('one output anchor cannot authorize restorations from two source claims',()=>{
  assert.equal(auditClauseCoverage(f.source+' '+f.source,f.output).semanticRequired,false);
});

test('a retained contrast arm can be rephrased inside the same sentence',()=>{
 const source=f.source.replace('길었으며,','길었지만,');
 const output=[f.intro,f.rewritten.replace('길었다.','길었지만,')+' '+f.tail.replace('이동 동선이 줄어드는 결과가 나타났다.','이동 동선이 줄었다.'),f.conclusion].join(' ');
 assert.equal(auditClauseCoverage(source,output).semanticRequired,false);
});

test('partly retained multi-claim tail is left to model repair instead of duplicated',()=>{
 const tail='촬영 담당자는 영상 구성을, 편집 담당자는 자막 배열을 담당했다.';
 const source=[f.intro,f.left+tail,f.conclusion].join(' ');
 const output=[f.intro,f.rewritten.replace('길었다.','길었고,')+' 촬영 담당자는 영상 구성을 맡았다.',f.conclusion].join(' ');
 const r=restoreConfirmedClauseOmissions(source,output,[confirmed(tail)]);
 assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].partialTailPresent,true);
 assert.equal(r.text,output);
});
