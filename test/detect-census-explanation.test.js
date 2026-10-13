'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildDetectInterpretation:build}=require('../lib/detectInterpretation');
const {buildDetectReportView}=require('../lib/detectReportView');
const standard={probability:20,probSource:'llm',confidence:'high',textLength:1200,sentenceTotal:12,causeCoverageStatus:'aligned',
 signalEvidence:[{category:'ending_repetition',strength:'strong',scope:'recurring',locationStatus:'source_range_verified',locations:[{sentenceIndex:1,start:50,end:90}]}]};
test('failed additional check is disclosed even when the selected primary result is consistent',()=>{
 const r=build({...standard,finalCandidateConsistency:{status:'consistent'},detectDiagnostics:{attempts:[{phase:'primary',failed:false},{phase:'recheck',failed:true}],recheckFailed:true}});
 assert.equal(r.score,20);assert.equal(r.status,'partial');assert.notEqual(r.evidence.level,'sufficient');assert.match(r.limitations.join(' '),/추가 검사를 완료하지 못해/);
 assert.match(r.description,/추가 검사를 끝내지 못했/);
 const good=build({...standard,detectDiagnostics:{attempts:[{phase:'primary'},{phase:'recheck'}]}});
 assert.equal(good.status,'ready');assert.doesNotMatch(good.limitations.join(' '),/완료하지 못해/);
});
test('statistics without located evidence do not point the user at nonexistent marked sentences',()=>{
 const r=build({...standard,probability:51,textLength:357,sentenceTotal:5,signalEvidence:[],
 statisticalSupport:{version:'statistical-assist-v5-whitespace-stable',modelVersion:'korean-style-statistics-v1',applied:true,originalScore:8,score:51,margin:.2,features:300,profile:'general',basis:'independent_statistics'}});
 assert.equal(r.score,51);assert.equal(r.pattern,null);assert.doesNotMatch(r.nextSteps.join(' '),/위치가 확인된 표현/);assert.match(r.nextSteps.join(' '),/근거는 확인되지 않았/);
});
test('cause coverage cannot advertise aligned while final consistency remains conflicted',()=>{
 const r=buildDetectReportView({...standard,probability:20,finalCandidateConsistency:{status:'conflict'},measurements:{genericness:{count:0,total:12},detail:[{sents:12,specific:4,lived:1}]}});
 assert.equal(r.causeAnalysis.status,'partial');assert.ok(r.causeAnalysis.codes.includes('final_candidate_consistency_conflict'));assert.equal(r.interpretation.score,20);
 const limited=buildDetectReportView({...standard,probability:20,textLength:100,confidence:'low',finalCandidateConsistency:{status:'conflict'}});
 assert.equal(limited.causeAnalysis.status,'partial');assert.match(limited.causeAnalysis.label,/일부만 확인/);
});
