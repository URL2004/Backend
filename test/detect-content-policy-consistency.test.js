'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.FOLLOWUP_TEST_REPO||path.resolve(__dirname,'..');
const {buildDetectReportView}=require(root+'/lib/detectReportView');
function view(profile,overrides={}){
 return buildDetectReportView({probability:28,probSource:'llm',textLength:1200,
  signalEvidence:[{category:'sentence_uniformity',strength:'moderate',scope:'recurring',locationStatus:'source_range_verified',locations:[{start:0,end:50,sentenceIndex:0},{start:60,end:110,sentenceIndex:1}]}],
  documentProfile:{profile,confidence:.9,profileMargin:1},
  measurements:{genericness:{count:0,total:10},detail:[{sents:10,lived:0,specific:0,grounded:0}]},...overrides});
}
test('off, ambiguous and sparse axes never become a request for invented evidence in synthesis',()=>{
 for(const v of [view('general'),view('creative'),view('mail_notice'),view('report_assignment',{documentProfile:{profile:'report_assignment',confidence:.3}}),view('resume_application',{measurements:{genericness:{total:4},detail:[{sents:4,lived:0,specific:0}]}})]){
  assert.equal(v.contentEvidence.status,'not_assessed');
  assert.equal(v.styleSignal.score,28);
  assert.doesNotMatch(JSON.stringify(v.synthesis),/보강할 필요|경험.{0,12}추가|근거.{0,12}추가/);
  assert.ok(v.synthesis.headline.includes(v.measuredEvidence.axisPolicy.axes.anchor.reason));
 }
});
test('report synthesis uses the same 20% grounded target, not an unrelated 35% cutoff',()=>{
 const v=view('report_assignment',{measurements:{genericness:{total:10},detail:[{sents:10,lived:0,specific:2,grounded:2}]}});
 assert.equal(v.contentEvidence.status,'strong');assert.equal(v.contentEvidence.target,.2);
 assert.equal(v.contentEvidence.assessedRatio,.2);assert.match(v.synthesis.headline,/기준을 충족/);
 assert.equal(v.styleSignal.score,28);
});
test('resume evidence uses lived experience, not a count of dates or names',()=>{
 const v=view('resume_application',{measurements:{genericness:{total:10},detail:[{sents:10,lived:0,specific:10,grounded:10}]}});
 assert.equal(v.contentEvidence.metric,'lived');assert.equal(v.contentEvidence.status,'weak');
 assert.equal(v.contentEvidence.assessedRatio,0);assert.equal(v.contentEvidence.groundedRatio,1);
 assert.match(v.synthesis.headline,/경험 문장/);assert.doesNotMatch(v.synthesis.headline,/충분|기준을 충족/);
});
test('stale riskLevel cannot contradict the numeric score across report surfaces',()=>{
 const v=view('report_assignment',{probability:9,riskLevel:'high',signalEvidence:[]});
 assert.equal(v.styleSignal.band,'low');assert.equal(v.professorRadar.band,'low');
 assert.equal(v.interpretation.band,'low');assert.match(v.synthesis.headline,/점수는 낮은 구간이고/);
});
test('missing and two-sentence inputs still cannot trigger paid recommendations',()=>{
 for(const m of [{},{genericness:{total:2},detail:[{sents:2,lived:0,specific:0}]}]){
  const v=view('general',{measurements:m});assert.equal(v.status,'limited');assert.equal(v.conversion.access,false);
 }
});
