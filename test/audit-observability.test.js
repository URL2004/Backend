'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { historyEvidence } = require('../lib/detectEvidenceHistory');
const { buildDetectInputDocument } = require('../lib/detectInputDocument');
const { createRefinementAudit, sanitizeRefinementAudit } = require('../lib/refinementAudit');

test('outline headings do not override a lived personal narrative or erase a real report purpose', () => {
  const profile = require('../engine-gpt-prod/documentProfile').detectDocumentProfile;
  const narrative = '서론\n나는 지난 주말에 동네 공원에 갔다. 처음에는 길을 몰라 오래 기다렸다.\n\n본론 1\n그날 친구를 만났고 함께 걸었다. 공원에 도착하자 마음이 가벼워졌다.\n\n본론 2\n저녁에는 집으로 돌아와 하루를 떠올렸다. 급하게 걷지 않아도 된다는 생각이 들었다.\n\n결론\n그때 나는 천천히 주변을 살피는 시간이 필요하다는 것을 느꼈다.';
  assert.equal(profile(narrative).profile, 'personal_essay');
  const report = narrative + '\n\n본 탐구는 공원의 이동 동선을 비교 분석한다. 조사 방법은 설문 조사와 문헌 검토이다. 수집한 자료를 분석하여 조사 결과를 보고서에 제시한다.';
  assert.equal(profile(report).signals.livedExperienceFrame, false);
  assert.equal(profile(report).profile, 'report_assignment');
  const application = narrative + '\n이 경험이 귀사에 지원하게 된 계기입니다. 입사 후 포부는 직무 역량을 발휘하는 것입니다.';
  assert.equal(profile(application).signals.livedExperienceFrame, false);
  const jobReport='1. 서론\n본 보고서는 직업윤리의 기준과 주요 역량을 분석한다. 직업윤리는 특정 개인이 아니라 조직의 책임을 다룬다.\n2. 직업윤리\n업무 담당자는 자신의 행동을 점검해야 한다. 본 조사에서는 직업윤리를 평가할 자료를 수집하여 분석한다.\n3. 결론\n직업윤리와 자격요건을 비교 분석한 결과를 제시한다.';
  assert.equal(profile(jobReport).profile,'report_assignment');
});

test('history stores bounded verified canonical evidence without source excerpts', () => {
  const text = '  첫 번째 관찰을 기록했다.\r\n\r\n두 번째 결과를 살펴보았다.';
  const document = buildDetectInputDocument(text), s = document.sentences[1];
  const item = { category: 'ending_repetition', strength: 'moderate', scope: 'recurring',
    description: text, locationStatus: 'source_range_verified', locations: [
      { sentenceIndex: 9, canonicalSentenceIndex: 1, start: s.start, end: s.end },
      { sentenceIndex: 10, canonicalSentenceIndex: 1, start: s.start + 1, end: s.end },
      { sentenceIndex: 0, start: 0, end: 99 }, { sentenceIndex: 999, start: 0, end: 1 }] };
  const result = historyEvidence([item], text);
  assert.equal(result.evidence[0].locations.length, 1);
  assert.equal(result.evidence[0].locations[0].sentenceIndex, 1);
  assert.equal(result.provenance.locationCount, 1);
  assert.equal(result.provenance.inputHash.length, 64);
  assert.equal(JSON.stringify(result).includes('관찰'), false);
  assert.equal(historyEvidence([{...item, locationStatus:'unlocated'}], text).provenance.locationCount, 0);
});

test('protected quotations and stale coordinates cannot become historical evidence', () => {
  const text = '원문에 따르면 “인용한 문장이다. 그대로 보존한다.”라고 설명한다.';
  const quote = buildDetectInputDocument(text).sentences.find(s=>s.spanType === 'quote');
  const result = historyEvidence([{category:'generic_abstraction', strength:'strong', scope:'isolated',
    locationStatus:'source_range_verified', locations:[{sentenceIndex:quote.index,start:quote.start,end:quote.end}]}],text);
  assert.equal(result.provenance.locationCount, 0);
});

test('refinement keeps parent/candidate provenance without claiming whole-document verification', () => {
  const args = { parent: '전체 이전 글', output:'전체 새 글', source:'원래 문단', candidate:'수정한 문단',
    memo:'기억을 정리한 메모', paragraphIndex:2, parentEngineVersion:'gpt-prod-v-test', generationModel:'gpt-test',
    validation:{pass:true,preservesMeaning:true,integratesMemo:true,model:'judge-test',version:'refinement-review-v1'} };
  const result = createRefinementAudit(args, 'a'.repeat(32));
  assert.equal(result.wholeDocumentVerified,false);
  assert.equal(result.scope,'refined_paragraph');
  assert.notEqual(result.parentHash,result.outputHash);
  assert.equal(result.memoReference.length,64);
  assert.equal(JSON.stringify(result).includes(args.memo),false);
  assert.equal(sanitizeRefinementAudit({...result,wholeDocumentVerified:true}),null);
  assert.equal(createRefinementAudit({...args,validation:{pass:false}},'a'.repeat(32)),null);
  assert.equal(createRefinementAudit(args,'').memoReference,null);
  assert.equal(Object.hasOwn(sanitizeRefinementAudit({...result,rawMemo:args.memo}),'rawMemo'),false);
});

test('refinement provenance uses the returned judge model without changing its pass gate', async () => {
  const {validateRefinement}=require('../lib/refinementValidation');
  const args={source:'자료를 함께 정리했다.',candidate:'발표 자료를 함께 정리하면서 동료의 설명을 들었다.',
    memo:'발표 자료 정리 중 동료의 설명을 들었다.',config:{models:{judge:'requested-test'}}};
  const result=await validateRefinement(args,async()=>({model:'resolved-test',json:{preservesMeaning:true,integratesMemo:true}}));
  assert.equal(result.pass,true);assert.equal(result.model,'resolved-test');
  const failed=await validateRefinement(args,async()=>({model:'resolved-test',json:{preservesMeaning:false,integratesMemo:true}}));
  assert.equal(failed.pass,false);
});
