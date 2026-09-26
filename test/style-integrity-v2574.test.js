'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const relations = require('../engine-gpt-prod/layoutRelations');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const judge = require('../engine-gpt-prod/judge');
const candidates = require('../engine-gpt-prod/relationAudit');
const input = require('../lib/detectInputDocument');
const calibration = require('../lib/detectCalibration');
const interpretation = require('../lib/detectInterpretation');
const profile = require('../engine-gpt-prod/documentProfile');
const { scorePresentation } = require('../lib/detectScorePresentation');

for (const equation of ['X(f) = ∫ x(t) exp(-i2πft) dt', 'a_n = 2/T ∫ f(t) cos(nωt) dt', '$$F(x) = x^2$$']) {
  test(`a literal formula cannot be a heading: ${equation}`, () => {
    assert.equal(layout.isFormulaLine(equation), true);
    assert.equal(layout.isKnownHeadingLine(equation), false);
    assert.equal(layout.classifyLine(equation), 'code');
  });
}
test('real afterword and question-section headings survive blank-line variations', () => {
  for (const gap of ['\n', '\n\n', '\n \n\n']) {
    const text = `후기${gap}현장에서 확인한 점을 다음 기록에 반영했다.`;
    assert.equal(layout.buildLineRecords(text)[0].role, 'heading');
  }
  assert.equal(layout.classifyLine('W① Why 작가는 왜 이 책을 썼을까?'), 'heading');
});
test('dependent introduction joins only its actual prose continuation', () => {
  const source = '안내문의 첫 부분에서는\n\n이용자가 필요한 정보를 찾는 과정을 다룬다.';
  const out = relations.repairDependentLeads(source);
  assert.equal(out.repairedCount, 1);
  assert.equal(out.text, source.replace('\n\n', ' '));
  for (const protectedText of ['안내문의 첫 부분에서는\n\n## 이용 과정', '안내문의 첫 부분에서는\n\n| 항목 | 근거 |', '## 안내문의 첫 부분에서는\n\n이용 순서를 다룬다.'])
    assert.equal(relations.repairDependentLeads(protectedText).text, protectedText);
});

test('attested pH/magnification conditions retain distinct explanation groups without changing words',()=>{
  const source='시료를 관찰했다. pH4 조건의 100배율에서는 큰 입자가 보였다. 동일한 pH4 조건의 200배율에서는 작은 입자가 보였다.\n\npH5 조건의 400배율에서는 입자가 응집했다. 이는 조건에 따른 관찰이다. pH6 조건을 1000배율로 관찰했을 때 막대 형태가 보였다.';
  const output=source.replace(/\s+/gu,' ');
  const r=relations.separateAttestedConditions(source,output);
  assert.equal(r.repairedCount,3);
  assert.equal(r.text.replace(/\s/gu,''),source.replace(/\s/gu,''));
  assert.equal(r.text.split(/\n\n/u).length,4);
  assert.equal(relations.separateAttestedConditions(source,r.text).repairedCount,0);
  assert.equal(relations.separateAttestedConditions(source,output.replace('pH5','pH7')).text,output.replace('pH5','pH7'));
  assert.equal(relations.separateAttestedConditions('## 관찰\n'+source,'## 관찰\n'+output).repairedCount,0);
  assert.equal(relations.separateAttestedConditions('pH4 조건에서는 pH5 조건보다 입자가 컸다.','pH4 조건에서는 pH5 조건보다 입자가 컸다.').repairedCount,0);
  const post=require('../engine-gpt-prod/structureChunk').restorePostSemanticLayout({source,outputText:output,mode:'assignment',documentProfile:{profile:'report_assignment'}});
  assert.match(post.text,/\n\npH5/u);assert.match(post.text,/\n\npH6/u);
  for(const s of ['실험군은 활동에 참여했다. 응답을 확인했다. 대조군은 일반 수업에 참여했다.',
    '온도 20°C 조건에서는 상태가 일정했다. 관찰값을 기록했다. 온도 30°C 조건에서는 색이 변했다.',
    '압력 10kPa 조건에서 입자를 관찰했다. 압력 20kPa 조건에서 변화를 기록했다.']){
    assert.equal(relations.separateAttestedConditions(s,s).repairedCount,1);
  }
});
test('layout-only provenance cannot bless collapsed rows, titles or condition groups', () => {
  for (const source of [
    '## 관찰 결과\n참여자의 응답을 정리했다.',
    '| 중재 | 근거 |\n| 관찰 | 상태 확인 |',
    '1. 관찰을 수행했다.\n2. 검토를 수행했다.',
    '실험군은 기준 조건을 유지했다.\n\n대조군은 다른 조건을 적용했다.'
  ]) {
    const report = provenance.bindSemanticValidation({ ran: true, pass: true }, source, source);
    const flattened = source.replace(/\s+/gu, ' ');
    assert.equal(provenance.verifySemanticValidation(report, { source, candidate: flattened, requireDigest: true }).status, 'stale', source);
  }
});
test('normal paragraph splitting remains eligible without an extra semantic call', () => {
  const source = '안내 내용을 확인했다. 이용자의 의견도 검토했다.';
  const report = provenance.bindSemanticValidation({ ran: true, pass: true }, source, source);
  const valid = provenance.verifySemanticValidation(report, { source, candidate: source.replace('. ', '.\n\n'), requireDigest: true });
  assert.equal(valid.status, 'pass'); assert.equal(valid.materialization, 'whitespace_layout');
});
test('uncertain, stale, skipped and failed judgments remain distinct', () => {
  const text = '자료를 점검했다.';
  const report = provenance.bindSemanticValidation({ ran: true, pass: false, uncertain: true }, text, text);
  assert.equal(provenance.verifySemanticValidation(report, { source: text, candidate: text }).status, 'uncertain');
  assert.equal(provenance.verifySemanticValidation(report, { source: text, candidate: text+' 새 주장.' }).status, 'stale');
  assert.equal(provenance.finalValidationWarnings(report, { status:'uncertain' })[0].code,'semantic_validation_unconfirmed');
  assert.equal(provenance.verifySemanticValidation({ ran:false }).status,'skipped');
});
test('paired evidence must contain the actual violation and be unique on both sides', () => {
  const source = '기준 범위 안에서 관찰값의 차이를 비교했다. 두 번째 측정은 별도로 기록했다.';
  const output = '기준 범위를 벗어난 정도를 비교했다. 두 번째 측정은 별도로 기록했다.';
  const finding = { type:'distortion', span:'기준 범위를 벗어난 정도를 비교했다.', sourceSpan:'기준 범위 안에서 관찰값의 차이를 비교했다.', candidateSpan:'기준 범위를 벗어난 정도를 비교했다.', relation:'condition_result', origin:'introduced' };
  assert.equal(judge.groundViolation(finding,source,output).repairable,true);
  assert.equal(judge.groundViolation({...finding,candidateSpan:'두 번째 측정은 별도로 기록했다.'},source,output).repairable,false);
  assert.equal(judge.groundViolation({...finding,sourceSpan:'원문에 없는 설명'},source,output).repairable,false);
  assert.equal(judge.groundViolation(finding,source+' '+source,output).repairable,false);
  assert.equal(judge.groundViolation({...finding,origin:'source_issue'},source,output).repairable,false);
  assert.equal(judge.groundViolation({...finding,origin:'unconfirmed'},source,output).repairable,false);
});

test('a preserved neighbouring clause cannot authorize duplicate omission restoration',()=>{
  const sourceSpan='측정값에는 일정한 간격이 있으므로 한 구간의 기록을 이용해 평균값을 구할 수 있으며, 그래프에는 각 구간의 평균값이 점으로 나타납니다.';
  const first='측정값에는 일정한 간격이 있으므로 한 구간의 기록을 이용해 평균값을 구할 수 있습니다.';
  const second='그래프에는 각 구간의 평균값이 점으로 나타납니다.';
  const tail='관찰자는 장비의 작동 상태를 별도로 점검했다. 자료를 공개하기 전에 참여자의 동의를 확인했다. 다음 조사에서는 표본을 확대할 계획이다. 결과를 비교할 때 조사 시점도 함께 고려해야 한다.';
  const source=sourceSpan+' '+tail, output=first+' '+second+' '+tail;
  const finding={type:'omission',span:sourceSpan,sourceSpan,candidateSpan:second,origin:'introduced',relation:'condition_result'};
  const grounded=judge.groundViolation(finding,source,output);
  assert.equal(grounded.repairable,false);
  assert.equal(grounded.relationContextStatus,'adjacent_overlap_requires_review');
  const restore=require('../engine-gpt-prod/confirmedRelationRestore').restoreConfirmedRelations;
  // Legacy findings made before this guard must not bypass the same check.
  const stale={...finding,repairable:true,relationGrounded:true,grounding:'unique_exact_span'};
  assert.equal(restore(source,output,{pass:false,violations:[stale]}).applied,false);
  assert.equal(judge.groundViolation(finding,source,second+' '+tail).repairable,true,'real missing clause remains reviewable');
});
for (const [source, output, code] of [
  ['정상 범위 안에서 관찰값의 차이를 비교했다.','정상 범위를 벗어난 관찰값의 정도를 비교했다.','condition_domain_candidate'],
  ['변수 a와 b는 측정값과 조건의 관계를 설명한다.','변수 a와 b는 각각 측정값과 조건의 관계를 설명한다.','explicit_mapping_candidate'],
  ['연구팀은 안정적인 실험 설계를 수행했다.','연구팀은 안정적인 실험 설계를 주장했다.','performed_role_candidate']
]) test(`relation trigger is advisory, not a delivery failure: ${code}`,()=>{
  const r=candidates.auditRelationCandidates(source,output);assert(r.codes.includes(code));assert.equal(r.candidateOnly,true);
});
test('complete sentence merges do not invent relation errors',()=>{
  const r=candidates.auditRelationCandidates('관찰값을 비교했다. 실험 조건은 일정하게 유지했다.','실험 조건을 일정하게 유지하면서 관찰값을 비교했다.');
  assert.equal(r.codes.length,0);
});
test('history floor 10 is monotone, never increases a score, and preserves the approved factor',()=>{
  const cfg=calibration.sanitizeConfig({enabled:true,floor:10,factor:.4,maxReduction:30});
  const values=Array.from({length:101},(_,n)=>calibration.calibratedProbability(n,cfg));
  for(let n=0;n<=100;n++){assert(values[n]<=n);if(n)assert(values[n]>=values[n-1]);}
  assert.equal(values[25],15);assert.equal(values[27],16);assert.equal(values[34],20);
  assert.deepEqual(values.slice(0,10),Array.from({length:10},(_,n)=>n));
});

test('near history cannot hide a changed core claim inside a long otherwise identical document',()=>{
  const base='연구팀은 지원자를 선정했다. 측정값은 정상 범위 안에 있었다. 값이 증가했다. 값은 30이었다. ‘사용자 동의’를 확인했다. 《동일 기준》을 적용했다. `allow=true`를 기록했다. '+
    '각 관찰의 조건과 기록 시점을 함께 확인했다. 결과를 해석할 때 해당 조건을 고려했다. '.repeat(20);
  for(const [a,b]of [['연구팀','지원자'],['안에','밖에'],['증가','감소'],['30','31'],['‘사용자 동의’','‘관리자 동의’'],['《동일 기준》','《다른 기준》'],['allow=true','allow=false']]){
    const r=calibration.approximateMatchMetrics(calibration.normalizeText(base),calibration.normalizeText(base.replace(a,b)),calibration.sanitizeConfig({}));
    assert.equal(r.matched,false,`${a} → ${b}`);
  }
  assert.equal(calibration.approximateMatchMetrics(calibration.normalizeText(base),calibration.normalizeText(base.replace('선정했다.','선정했다。')),calibration.sanitizeConfig({})).matched,true);
});
test('canonical quote/code sampling keeps public locations and scope aligned',()=>{
  const text='검토자는 “A. B. 연구자가 제시한 값은 2.5였다.”라는 기록을 확인했다. 이후 별도 자료도 비교했다.\n\n`const x = 3.5;`\n\n마지막으로 조건을 정리했다.';
  const doc=input.buildDetectInputDocument(text);
  assert.equal(doc.eligibleSentenceCount,3);
  const {groundSignals}=require('../lib/detectGrounding');
  const indices=doc.sentences.filter(s=>s.eligibleForDetection&&s.sampleUnitIndex===0).map(s=>s.index);
  const grounded=groundSignals([{category:'ending_repetition',strength:'strong',scope:'pervasive',evidenceSentences:indices}],text);
  const located=input.locatePublicEvidence(grounded,text);
  assert.equal(located[0].scope,'isolated');
  assert.equal(new Set(located[0].locations.map(x=>x.sampleUnitIndex)).size,1);
  for(const location of located[0].locations)assert.equal(text.slice(location.start,location.end),doc.sentences[location.sentenceIndex].text);
});
for(const scope of ['isolated','recurring','pervasive'])test(`server scope is preserved: ${scope}`,()=>{
  const r=interpretation.buildDetectInterpretation({probability:34,probSource:'llm',confidence:'high',textLength:1000,sentenceTotal:9,causeCoverageStatus:'aligned',signalEvidence:[{category:'ending_repetition',strength:'moderate',scope,locationStatus:'source_range_verified',locations:[{sentenceIndex:4,sampleUnitIndex:2,start:100,end:130},{sentenceIndex:5,sampleUnitIndex:2,start:140,end:170}]}]});
  assert.equal(r.pattern.scope,scope);assert.equal(r.pattern.locationCount,1);
});
test('low score with no evidence cannot claim complete evidence',()=>{
  const r=interpretation.buildDetectInterpretation({probability:5,probSource:'llm',confidence:'high',textLength:1000,sentenceTotal:12,causeCoverageStatus:'aligned'});
  assert.notEqual(r.evidence.level,'sufficient');assert.equal(r.evidenceDetails.locatedPatterns,0);
});
test('incomplete input limits explanation, never rescales the score',()=>{
  for(const text of ['관찰자는 주위에서 얻은 자료를 비교하다가','여러 사용자가 필요한 내용을 확인할 수 있도록'])assert.equal(input.buildDetectInputDocument(text).inputIncomplete,true);
  for(const text of ['결과를 확인했다','계획을 검토함','“여러 사용자가 필요한 내용을 확인할 수 있도록”','```js\nwhile (true) {\n```'])assert.equal(input.buildDetectInputDocument(text).inputIncomplete,false);
  const r=interpretation.buildDetectInterpretation({probability:12,probSource:'llm',confidence:'high',textLength:1000,sentenceTotal:12,causeCoverageStatus:'aligned',inputIncomplete:true});
  assert.equal(r.score,12);assert.equal(r.status,'limited');assert.equal(r.evidenceDetails.inputIncomplete,true);
});
test('calibration disclosure distinguishes a match with no score change from no match',()=>{
  const meta={reason:'own_humanized_history_match',version:calibration.VERSION};
  assert.deepEqual(scorePresentation({meta,rawProbability:25,probability:15}).scoreAdjustment,{matched:true,applied:true,before:25,after:15,delta:-10,basis:'service_history',version:calibration.VERSION});
  assert.equal(scorePresentation({meta,rawProbability:5,probability:5}).scoreAdjustment.matched,true);
  assert.equal(scorePresentation({meta,rawProbability:5,probability:5}).scoreAdjustment.applied,false);
  assert.equal(scorePresentation({rawProbability:25,probability:25}).scoreAdjustment.matched,false);
  assert.equal(scorePresentation({meta,rawProbability:5,probability:20}).scoreAdjustment.matched,false);
});

test('continuous sentence-per-line narrative groups phases rather than every line',()=>{
  const lines=['저는 현장 실습에서 안내 업무를 담당했습니다.','방문자가 자주 묻는 내용을 별도 기록에 남겼습니다.',
    '자격증 공부를 할 때 서로 다른 자료의 설명을 비교했습니다.','확인되지 않은 부분은 강사에게 질문했습니다.',
    '입사 후에는 기록을 바탕으로 안내 과정을 개선하겠습니다.','팀원과 확인한 정보를 공유하겠습니다.'];
  const source=lines.join('\n');
  for(const genre of ['resume_application','general','personal_essay']) {
    const out=require('../engine-gpt-prod/structureChunk').restorePostSemanticLayout({source,outputText:lines.join('\n\n'),mode:'blog',documentProfile:{profile:genre,confidence:.9,formatProfile:{primary:'plain',flags:[]}}});
    assert.equal(out.text.replace(/\s/gu,''),source.replace(/\s/gu,''));
    assert.deepEqual(out.text.split(/\n\s*\n/u),[lines.slice(0,2).join(' '),lines.slice(2,4).join(' '),lines.slice(4).join(' ')]);
  }
  assert.equal(relations.groupContinuousResumeLines(['1. 질문에 답했습니다.',...lines]),null);
  assert.equal(relations.groupContinuousResumeLines(['오늘은 첫 내용을 설명했습니다.','다음은 둘째 내용을 설명했습니다.',...lines.slice(-2)]),null);
});

test('an unchanged demonstrative sentence still needs its original antecedent',()=>{
  const first='이 실험은 시료의 두께를 일정하게 유지했다.', second='다른 실험은 실내 온도를 바꾸어 결과를 관찰했다.', ref='이 부분은 결과를 비교할 때 중요한 전제이다.';
  assert(candidates.auditRelationCandidates([first,ref,second].join(' '),[first,second,ref].join(' ')).codes.includes('antecedent_ownership_candidate'));
});

test('document purpose outranks greeting, quotations or a single application word',()=>{
  const qualitative='본 연구는 지역 주민의 공공시설 이용 경험을 살핀 질적 연구이다. 연구 참여자와 반구조화 심층 면담을 진행하고 자료를 수집했다. 면담 자료를 반복적으로 읽어 의미 단위를 코딩한 뒤 경험을 범주화하였다. 참여자는 처음 이용할 때 안내를 찾기 어려웠다고 진술했다. 다른 참여자는 직원과 대화하면서 필요한 정보를 얻었다고 회고했다. 이 진술을 분석하여 접근 과정과 도움 요청이라는 주제를 도출하였다. 결과를 해석할 때 참여자의 이용 기간과 시설의 지역적 조건을 함께 고려하였다. 면담은 개별 경험을 이해하기 위한 자료이며 전체 주민의 이용 빈도를 추정하기 위한 표본은 아니다.';
  assert.equal(profile.detectDocumentProfile(qualitative).profile,'academic_paper');
  const application='저는 지역 도서관에서 이용자 안내를 담당한 경험이 있습니다. 이용자가 자주 묻는 내용을 모아 팀과 공유했고, 필요한 자료를 찾는 과정을 정리했습니다. 이 경험을 바탕으로 고객 지원 직무에 지원했습니다. 입사 후에는 문의 내용을 정확히 기록하고 팀에 기여하겠습니다.';
  assert.equal(profile.detectDocumentProfile(application).profile,'resume_application');
  assert.notEqual(profile.detectDocumentProfile('안녕하세요. 저는 토론의 찬성 측 입론을 맡았습니다. 첫째, 공공시설 확대는 접근성을 높입니다. 둘째, 예산 배분의 근거를 공개해야 합니다. 따라서 지역별 이용 여건을 고려하여 정책을 검토해야 합니다.').profile,'mail_notice');
  assert.notEqual(profile.detectDocumentProfile('지원 사업의 예산과 집행 현황을 검토한다. 기관별 담당 업무와 조사 방법을 비교하고 결과의 한계를 설명한다.').profile,'resume_application');
});

test('independent statistics remain a disclosed reference rather than score evidence',()=>{
  const r=interpretation.buildDetectInterpretation({...{probability:12,probSource:'llm',confidence:'high',textLength:1000,sentenceTotal:12},statisticalReference:{basis:'independent_statistics',scoreApplied:false}});
  assert.equal(r.score,12);assert.equal(r.evidenceDetails.statisticalContribution,false);
  assert(r.limitations.some(s=>s.includes('점수에는 반영하지 않았어요')));
});

test('stored calibration metadata has a closed schema and matches its displayed score',()=>{
  const {sanitizeAdjustment}=require('../lib/detectScorePresentation');
  const value={matched:true,before:25,after:15,delta:-10,basis:'service_history',version:'v',uid:'not-to-store',source:'not-to-store'};
  assert.equal(sanitizeAdjustment(value,15).uid,undefined);
  assert.equal(sanitizeAdjustment(value,15).source,undefined);
  assert.equal(sanitizeAdjustment(value,20),null);
  assert.equal(sanitizeAdjustment({...value,delta:0},15),null);
});

test('paired subject-action findings permit bounded restoration without keyword heuristics',()=>{
  const {restoreConfirmedRelations}=require('../engine-gpt-prod/confirmedRelationRestore');
  const a='지난 절에서 설명한 행렬이 연산의 기본 틀이었다면, 다음 절에서는 그 구조를 살펴봅니다.';
  const b='지난 절에서 행렬이 연산의 기본 틀을 설명했다면, 다음 절에서는 그 구조를 살펴봅니다.';
  const tail='각 항목의 입력값은 별도의 표에 기록했습니다. 결과를 비교할 때 같은 계산 조건을 유지했습니다.';
  const v=judge.groundViolation({type:'distortion',span:b,sourceSpan:a,candidateSpan:b,origin:'introduced',relation:'actor_action_target'},a+' '+tail,b+' '+tail);
  const report={pass:false,violations:[v]};
  assert.equal(restoreConfirmedRelations(a+' '+tail,b+' '+tail,report).text,a+' '+tail);
  assert.equal(restoreConfirmedRelations(a+' '+tail,b+' '+tail,{...report,uncertain:true}).applied,false);
  assert.equal(restoreConfirmedRelations(a+' '+tail,b+' '+tail,{...report,violations:[{...v,sourceSpan:'다른 원문'}]}).applied,false);
});

test('fallback cannot resurrect an earlier pass contradicted by a later grounded finding',()=>{
  const {createCandidateLedger}=require('../engine-gpt-prod/candidateLedger');
  const source='원문 내용',bad='결과의 잘못된 관계.',good='원문과 같은 관계를 자연스럽게 표현했다.';
  const ledger=createCandidateLedger({source,assess:()=>({hardViolationCodes:[],minimumEffectPass:true,transformed:true})});
  ledger.record({stage:'old',text:bad,semanticReport:provenance.bindSemanticValidation({ran:true,pass:true},source,bad)});
  ledger.record({stage:'good',text:good,semanticReport:provenance.bindSemanticValidation({ran:true,pass:true},source,good)});
  const end=ledger.record({stage:'final',text:bad+' 새 문장.',semanticReport:provenance.bindSemanticValidation({ran:true,pass:false},source,bad+' 새 문장.')});
  const choice=ledger.chooseFinal(end.id,{knownViolations:[{type:'distortion',origin:'introduced',repairable:true,candidateSpan:bad}]});
  assert.equal(choice.entry.text,good);assert.equal(choice.applied,true);
});

test('confirmed antecedent restoration supports a bounded three-to-two sentence window',()=>{
  const {restoreConfirmedRelations}=require('../engine-gpt-prod/confirmedRelationRestore');
  const a='그 연구자는 비용만 중시하지 않았다. 이번 자료를 읽고 이 점을 새롭게 알았다. 그는 먼저 「현장 기록」을 썼다.';
  const b='그 연구자는 비용만 중시하지 않았다. 이번 자료를 읽고 그가 먼저 「현장 기록」을 썼다는 점을 새롭게 알았다.';
  const tail='조사 방식은 별도의 부록에 기록되어 있다. 각 지역의 자료는 조사 기간별로 나누어 보관했다. 기록을 비교할 때 조사 조건이 달랐던 점을 함께 고려해야 한다. 이후 연구에서는 자료 수집 과정을 자세하게 설명했다. 인접한 다른 연구의 결론을 이 연구에 그대로 적용할 수는 없다. 해석의 범위는 당시 조사에 참여한 대상자로 제한한다. 대상자의 추가 의견은 후속 면담에서 확인했다. 논의에서는 관찰 결과와 연구자의 해석을 구분했다.';
  const v=judge.groundViolation({type:'distortion',span:b,sourceSpan:a,candidateSpan:b,origin:'introduced',relation:'antecedent'},a+' '+tail,b+' '+tail);
  const restored=restoreConfirmedRelations(a+' '+tail,b+' '+tail,{pass:false,violations:[v]});
  assert.equal(restored.applied,true);assert.equal(restored.text,a+' '+tail);
  assert.equal(restoreConfirmedRelations(a,b,{pass:false,violations:[v]}).applied,false,'never replace the whole rewrite');
});
