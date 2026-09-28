'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');

test('missing terminal spaces keep canonical sentence offsets without splitting decimals, identifiers or quotes', () => {
  const split=require('../engine/koreanText').splitSentenceSpans;
  const text='값은 3.14이다.다음 결과도 확인했다.따라서 기록을 보관한다.';
  const spans=split(text); assert.equal(spans.length,3);
  assert.ok(spans.every(s=>text.slice(s.start,s.end)===s.text));
  for(const text of ['A. B. Kim의 기록이다.', '자료.목록이라는 파일을 열었다.', '“결과입니다.”라고 답했다.', '`sample.이다.확인` 코드를 읽었다.']) assert.equal(split(text).length,1,text);
  const d=require('../lib/detectInputDocument').buildDetectInputDocument(text);
  assert.equal(d.eligibleSentenceCount,3);
});

test('medium-long documents split only at verified unique headings; every character retains ownership', () => {
  const pairs=require('../engine-gpt-prod/finalQualityV2').buildReviewPairs;
  const section=n=>`${n}. 검토 절\n\n`+Array.from({length:25},(_,i)=>`해당 절의 관찰 ${i+1}은 조건에 따라 달라질 수 있으므로 담당자는 내용을 기록하고 이전 자료와 대조한다.`).join(' ');
  const source=[1,2,3,4,5].map(section).join('\n\n');
  assert.ok(source.length>6000&&source.length<12000);
  const output=source.replaceAll('내용을 기록하고','기록을 남기고');
  const grouped=pairs(source,output);
  assert.ok(grouped.length>1);assert.ok(grouped.every(p=>p.alignment==='shared_unique_heading'&&p.repairSafe));
  assert.equal(grouped.map(p=>p.sourceContext).join(''),source);assert.equal(grouped.map(p=>p.output).join(''),output);
  assert.equal(pairs(source,output.replace('3. 검토 절','바뀐 제목')).length,1);
  assert.equal(pairs(source.replaceAll(/\d\. 검토 절/gu,'같은 제목'),output.replaceAll(/\d\. 검토 절/gu,'같은 제목')).length,1);
});

test('interrupted confirming judge retains earlier cost and findings but cannot return pass', () => {
  const fs=require('node:fs'), vm=require('node:vm');
  const code=fs.readFileSync(require.resolve('../engine-gpt-prod/judge'),'utf8');
  const context={emptyUsage:()=>({estimatedUsd:0}),addUsage:(a,b)=>({estimatedUsd:(a?.estimatedUsd||0)+(b?.estimatedUsd||0)})};
  vm.createContext(context);
  vm.runInContext(code.slice(code.indexOf('function retainInterruptedReview('),code.indexOf('function summarizeJudge(')),context);
  const error=Object.assign(new Error('cancelled'),{usage:{estimatedUsd:.03}});
  const result=context.retainInterruptedReview(error,{pass:true,outputText:'verified old text',violations:[{type:'distortion'}],usage:{estimatedUsd:.01}});
  assert.equal(result.usage.estimatedUsd,.04);
  assert.equal(result.partialSemanticReport.pass,false);
  assert.equal(result.partialSemanticReport.verificationCompleted,false);
  assert.equal(result.partialSemanticReport.violations.length,1);
});

test('circled standalone labels retain exact section ownership without reclassifying prose lists', () => {
  const pair=require('../engine-gpt-prod/finalQualityV2').buildReviewPairs;
  const text=[1,2,3,4].map((n,i)=>`${String.fromCodePoint(0x2460+i)} 실험 ${n}의 관찰 기록\n`
    +Array.from({length:33},(_,j)=>`이 구간에서 확인한 측정 ${j+1}은 같은 조건을 적용한 결과이며 연구자는 앞선 관찰과 비교하고 기록을 남겼다.`).join(' ')).join('\n\n');
  const output=text.replaceAll('연구자는 앞선 관찰과 비교하고','담당자는 이전 관찰과 대조하고');
  const parts=pair(text,output);assert.ok(parts.length>1);
  assert.ok(parts.every(p=>p.alignment==='shared_unique_heading'&&p.repairSafe));
  assert.equal(parts.map(p=>p.sourceContext).join(''),text);assert.equal(parts.map(p=>p.output).join(''),output);
  assert.equal(pair(text,output.replace('③ 실험 3의 관찰 기록','③ 실험 4의 관찰 기록')).length,1);
  const dense='① 첫째 항목\n② 둘째 항목\n③ 셋째 항목\n④ 넷째 항목';
  assert.ok(require('../engine-gpt-prod/reviewAlignment').alignedReviewPairs(dense,dense,20).every(p=>p.alignment!=='shared_unique_heading'));
  const prose=text.replaceAll(/실험 (\d)의 관찰 기록/gu,'실험 $1의 내용을 확인했다.');
  assert.ok(require('../engine-gpt-prod/reviewAlignment').alignedReviewPairs(prose,prose,4500).every(p=>p.alignment!=='shared_unique_heading'));
});

test('relative clauses are not product names; quoted titles and real introduced categories remain checked', () => {
  const audit = require('../engine-gpt-prod/unsupportedSpecificityAudit').auditUnsupportedSpecificity;
  const source = '시민들의 삶을 묘사한 작품은 생산량 증가 선전과 실제 빈곤을 대비한다.';
  for (const modifier of ['살아가는', '살아오던', '등장하는', '나타나는', '다루는', '제공하는', '이어지는', '알려진']) {
    // 알려진 is not a productive exemption; the generic paraphrase remains
    // grounded when already present in the source world.
    const s = modifier === '알려진' ? source + ' 알려진 작품을 분석했다.' : source;
    assert.equal(audit(s, `시민들이 ${modifier} 작품 속 모습은 생산량 증가 선전과 실제 빈곤의 차이를 보여 준다.`).pass, true, modifier);
  }
  for (const name of ['퍼즐', '삼성과 같은', '드림온', '커피빈']) {
    assert.equal(audit('기존 작품의 매출을 검토했다.', `${name} 브랜드를 출시해 매출과 전환율을 높였다.`).pass, false, name);
  }
  assert.equal(audit('기존 작품의 매출을 검토했다.', '“살아가는” 작품을 출시해 매출과 전환율을 높였다.').pass, false);
});

test('short dense independent evidence is reviewed once, not boosted; insufficient and repeated categories are excluded', () => {
  const review = require('../lib/detectEvidenceReview').needsEvidenceReview;
  const ground = require('../lib/detectGrounding').groundSignals;
  for (const n of [2, 3, 4, 7]) {
    const text = Array.from({length:n},(_,i)=>`활동 ${i+1}의 체계적 발전이 매우 중요하다.`).join(' ');
    const signals = ['generic_abstraction','lexical_template'].map(category=>({category,strength:'strong',scope:'recurring',evidenceSentences:Array.from({length:n},(_,i)=>i)}));
    const out = { probability:32, signalEvidence:ground(signals,text) };
    assert.equal(review(out,text),true); assert.equal(out.probability,32);
    assert.equal(review({...out,signalEvidence:[out.signalEvidence[0],out.signalEvidence[0]]},text),false);
    assert.equal(review({...out,signalEvidence:out.signalEvidence.map(s=>({...s,strength:'moderate'}))},text),true);
    assert.equal(review({...out,signalEvidence:out.signalEvidence.map(s=>({...s,strength:'weak'}))},text),false);
    assert.equal(review({...out,signalEvidence:out.signalEvidence.map(s=>({...s,category:'ending_repetition'}))},text),false);
    assert.equal(review({...out,signalEvidence:out.signalEvidence.map(s=>({...s,locations:s.locations.slice(0,1)}))},text),false);
  }
  assert.equal(review({probability:0,signalEvidence:[]},'짧은 문장이다.'),false);
});
test('new contrast and lost comparison qualification are review candidates, never verdicts', () => {
  const source = '시민들은 변화를 바랐고 현재의 제도 안에서 해결 방법을 찾았다.';
  const changed = '시민들은 변화를 바라지만 현재의 제도 안에서 해결 방법을 찾았다.';
  const result = auditRelationCandidates(source,changed);
  assert.ok(result.codes.includes('coordination_contrast_candidate'));
  assert.equal(result.candidateOnly,true);
  assert.ok(!auditRelationCandidates(source,source.replace('바랐고','바라며')).codes.includes('coordination_contrast_candidate'));
  const limited = '두 활동은 목적과 배경에서 차이가 있지만 서로 협력하는 태도는 비슷하다.';
  assert.ok(auditRelationCandidates(limited,'두 활동은 서로 협력하는 태도가 비슷하다.').codes.includes('comparison_limitation_candidate'));
  assert.ok(!auditRelationCandidates(limited,'두 활동은 목적과 배경이 다르지만 서로 협력하는 태도는 비슷하다.').codes.includes('comparison_limitation_candidate'));
});

test('cancelled semantic audit retains completed usage and marks all unfinished sections', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../engine-gpt-prod/finalQualityV2'),'utf8');
  const start = source.indexOf('async function runSemanticDocumentAudit(');
  const end = source.indexOf('function restoreReviewPairBoundaryWhitespace',start);
  const controller = new AbortController(); let calls = 0;
  let secondStarted;
  const bothStarted = new Promise(resolve => { secondStarted = resolve; });
  const context = { AbortSignal,
    require: name => ['./concurrency','./callLedger','./semanticObligations','./semanticAuditSchedule'].includes(name) ? require('../engine-gpt-prod/'+name.slice(2)) : require(name),
    buildReviewPairs:()=>Array.from({length:6},(_,index)=>({index,output:String(index),sourceContext:'source'})),
    auditRelationCandidates:()=>({codes:[],candidates:[]}),
    discourse:{compareDiscourse:()=>({codes:[]})},
    bindSemanticValidation: report=>report, restoreReviewPairBoundaryWhitespace:(_a,b)=>b,
    safeMessage:e=>e.message, addUsageLocal:(a,b)=>({estimatedUsd:(a?.estimatedUsd||0)+(b?.estimatedUsd||0)}),
    judgeAndRepair:async(_s,output,options)=>{
      assert.ok(options.discourseSignals.includes('final_semantic_revalidation'));
      assert.ok(options.discourseSignals.includes('prior_failed_semantic_confirmation'));
      calls++;
      if(output==='0') {
        await bothStarted; controller.abort();
        return {pass:true,outputText:output,usage:{estimatedUsd:.01}};
      }
      secondStarted();
      await new Promise(resolve=>setImmediate(resolve));
      throw Object.assign(new Error('cancelled'),{usage:{estimatedUsd:.03},
        partialSemanticReport:{rounds:1,outputText:'private prior text',violations:[{span:'private'}],initialViolations:[{}]}});
    }
  };
  vm.createContext(context); vm.runInContext(source.slice(start,end),context);
  const result = await context.runSemanticDocumentAudit({source:'source',outputText:'012345',signal:controller.signal,allowRepair:false,
    discourseSignals:['final_semantic_revalidation','prior_failed_semantic_confirmation']});
  assert.equal(calls,2); assert.equal(result.outputText,'012345');
  assert.equal(result.pass,false); assert.equal(result.verificationCompleted,false);
  assert.equal(result.usage.estimatedUsd,.04);
  assert.equal(result.progress.expectedSections,6); assert.equal(result.progress.completedSections,1);
  assert.equal(result.progress.startedSections,2); assert.equal(result.progress.unfinishedSections.length,5);
  assert.equal(result.reports[1].partialProgress.priorFindingCount,1);
  assert.equal(result.reports[1].partialProgress.verificationCompleted,false);
  assert.equal(JSON.stringify(result.reports).includes('private'),false);
});
