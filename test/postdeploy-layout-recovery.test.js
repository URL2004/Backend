'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const physical = require('../engine-gpt-prod/physicalProseLines');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const delivered = require('../engine-gpt-prod/deliveredLayoutAudit');
const { ordinalMarkers } = require('../engine-gpt-prod/koreanOrdinal');
const bare = s => s.replace(/\s/gu, '');
const physicalSource = '1. 관찰 기록\n' + Array.from({length: 9}, (_, i) =>
  `연구팀은 여러 지역의 자료를 비교하면서 각 시설의 운영 조건을 자세하게 확인하고 있\n다. 담당자는 ${i + 1}차 관찰에서 얻은 자료를 검토하고 다음 측정의 절차를 다시 준비하였다.`).join('\n')
  + '\n2. 다음 조사\n연구팀은 지역마다 사용하는 기술과 지원 내용을 비교하면서 이후 비용을 줄이고\n효율을 높일 수 있는 방법과 발전 과정을 살펴보고자 한다.\n'
  + '연구팀은 여러 지역에서 사용하는 장비의 특성과 새로운 작업 방식에 필요한 기\n술이다. 관련 내용을 살펴보고 다시 비교한다.\n'
  + '연구팀은 모든 지역의 차이를 검토하면서 필요한 자원을 효율적으로 줄\n이기 위해 안내 내용을 정리하였다.\n'
  + '연구팀은 여러 지역에서 사용하는 기술과 필요한 자원을 비교하여 조사하\n고자 한다. 담당자는 다음 검토의 절차를 설명하였다.';
function options(source, outputText = source, extra = {}) {
  return { source, outputText, mode:'assignment', requestStrength:'advanced',
    documentProfile:{profile:'report_assignment',confidence:.96},
    chunks:structure.splitChunksForGpt(source,{coalesceEditable:true}).chunks,
    normalizeVisualGaps:true, ...extra };
}

test('PDF endings, attested inflections and bound purpose endings canonicalize before chunk ownership', () => {
  const source = preflight.auditAndSanitizeSource(physicalSource).text;
  assert.equal(bare(source), bare(physicalSource));
  assert.match(source,/확인하고 있다\./u);
  assert.match(source,/필요한 기술이다\./u);
  assert.match(source,/줄이기 위해/u);
  assert.match(source,/조사하고자 한다/u);
  assert.doesNotMatch(source, /있\n다\.|조사하 고자|기 술이다|줄 이기/u);
  assert.equal(structure.splitChunksForGpt(source).chunks.some(c=>c.locked && /^다\./u.test(c.text)),false);
  assert.equal(preflight.auditAndSanitizeSource(source).text,source);
});

test('replaying proved source seams fixes copied whitespace without guessing other words or changing quotes', () => {
  const output = '연구팀은 필요한 기술을 확인하고 있\n다. 연구팀은 조사하 고자 한다. 일 수는 그대로 둔다. “조사하 고자”라는 표기를 인용한다. `조사하 고자`';
  const repaired = physical.restoreSourceWordSeams(physicalSource,output);
  assert.match(repaired.text,/확인하고 있다/u);
  assert.match(repaired.text,/연구팀은 조사하고자 한다/u);
  assert.match(repaired.text,/일 수는/u);
  assert.match(repaired.text,/“조사하 고자”/u);
  assert.match(repaired.text,/`조사하 고자`/u);
  assert.equal(bare(output),bare(repaired.text));
  assert.equal(physical.restoreSourceWordSeams(physicalSource,repaired.text).text,repaired.text);
  assert.equal(physical.restoreSourceWordSeams('일수는 알 수 없다.','일 수를 기록한다.').repairCount,0);
});

test('real Hangul enumerations survive inside a qualified physical document', () => {
  const list = '가. 자료 수집\n나. 자료 비교\n다. 자료 검토';
  assert.ok(preflight.auditAndSanitizeSource(physicalSource+'\n\n'+list).text.endsWith(list));
});

test('restoring Hangul list anchors never takes 다. from an ordinary predicate', () => {
  const source='가. 자료 확인\n담당자는 각 자료의 차이를 자세하게 검토한다.\n나. 조사 목적\n이 절차는 필요한 자료의 차이를 조사하여 기록한다.\n다. 후속 계획\n다음 관찰에서 같은 조건을 비교한다.';
  const edited=source.replace('차이를 조사하여 기록한다.', '차이를 조사하는 것을 목표로 한다. 내용을 기록한다.');
  const out=structure.restoreFinalDocumentLayout(options(source,edited));
  assert.equal(out.structuralPass,true);
  assert.match(out.text,/목표로 한다\./u);
  assert.doesNotMatch(out.text,/한\s+다\./u);
  assert.equal((out.text.match(/^다\./gmu)||[]).length,1);
  assert.equal(structure.restoreFinalDocumentLayout(options(source,out.text)).text,out.text);
});

test('bibliography internal lines stay exact while its outside boundary separates from prose', () => {
  const refs='참고자료\n자료집 A.\n자료집 B.\n자료집 C.';
  const source='이 연구는 자료를 검토하였다. 각 관찰의 차이를 설명하며 다음 연구에서 비교할 사항을 기록하였다.\n'+refs;
  const out=structure.restoreFinalDocumentLayout(options(source));
  assert.equal(out.structuralPass,true);
  assert.ok(out.text.includes('\n\n'+refs));
  assert.equal(bare(out.text),bare(source));
});

test('generated ending breaks require both a source verb and an extra Hangul marker', () => {
  const source='가. 자료 확인\n담당자는 여러 지역의 관찰 자료를 비교하며 조건에 맞게 장비의 속도를 조절하고 기록을 남긴다.\n나. 다음 절차\n이 절차는 필요한 자료를 자세하게 정리하는 것을 목표로 한다.\n다. 검토 방법';
  const broken=source.replace('조절하고 기록을 남긴다.', '조절한\n\n다. 기록을 남긴다.')
    .replace('목표로 한다.', '목표로 한\n다.');
  const out=physical.restoreSourceWordSeams(source,broken);
  assert.equal(out.repairCount,2);
  assert.match(out.text,/조절한다\./u);
  assert.match(out.text,/목표로 한다\./u);
  assert.ok(out.text.endsWith('다. 검토 방법'));
  assert.equal(physical.restoreSourceWordSeams(source,source).text,source);
  assert.equal(bare(out.text),bare(broken));
});

test('enumeration introductions stay with their list and nominal labels start a new section', () => {
  const refine=require('../engine-gpt-prod/paragraphRelations').refineParagraphRelations;
  const intro='자료를 여러 조건으로 비교했다. 조사 방법을 정리하며 각 조건의 차이를 설명했다. 장점은 세 가지입니다.\n\n첫째, 여러 자료를 비교할 수 있다. 둘째는 차이를 알아보는 능력이다.';
  const out=refine(intro);
  assert.match(out.text,/설명했다\.\n\n장점은 세 가지입니다\.\n\n첫째/u);
  assert.equal(refine(out.text).text,out.text);
  const body='연구팀은 여러 지역의 자료를 비교하고 차이를 기록하였다. 담당자는 같은 자료를 다른 관점으로 확인하면서 다음 검토에서 살펴볼 항목과 조건을 자세히 정리하였다. ';
  const labels=body+'\n연구 배경: 지역별 관찰의 차이\n'+body.repeat(2);
  assert.match(refine(labels).text,/정리하였다\.\s*\n\n연구 배경:/u);
});

test('ordinary headings are not displaced by demonstrative body openings', () => {
  const source='기술의 변화와 의의\n이 연구는 지역마다 다른 시설의 운영 방식을 비교하고 개선 방향을 자세하게 분석한다.';
  assert.ok(['title','heading'].includes(layout.buildLineRecords(source)[0].role));
});

test('topic enumerators and a subject before a reason retain their source ordinal identity', () => {
  const before='장점은 세 가지이다. 첫째, 자료를 비교하는 능력이다. 둘째, 차이를 알아보는 태도이다. 셋째, 결과를 정리하는 능력이다.';
  const after=before.replace('둘째,','둘째는').replace('셋째,','셋째는');
  assert.deepEqual(ordinalMarkers(after).map(x=>x.number),[1,2,3]);
  assert.equal(structure.buildStructureAudit({source:before,outputText:after,chunks:structure.splitChunksForGpt(before).chunks}).pass,true);
  const reason='두 번째 이유는 기록을 오래 보존할 수 있다는 점이다.';
  assert.deepEqual(ordinalMarkers('자료가 중요한 '+reason).map(x=>x.number),[2]);
  assert.equal(structure.buildStructureAudit({source:reason,outputText:'자료가 중요한 '+reason}).pass,true);
  assert.equal(ordinalMarkers('첫째는 대학생이다. 둘째는 학교에 갔다.').length,0);
  assert.equal(structure.buildStructureAudit({source:before,outputText:after.replace('셋째는 결과를 정리하는 능력이다.','')}).pass,false);
});

test('tabular number ranges and complete display equations form protected blocks', () => {
  const table='구간\t값\t코드\n0–31\t0\t00\n32–63\t1\t01\n64–95\t2\t10\n96–127\t3\t11';
  const formula='\\[\nQ=\\left\\lfloor\\frac{I}{32}\\right\\rfloor.\n\\]';
  const source='1. 양자화 방법\n구간을 나누어 다음 식으로 계산한다.\n'+formula+'\n'+table+'\n계산 결과를 표의 값과 비교한다.';
  const records=layout.buildLineRecords(source);
  assert.ok(records.filter(r=>r.text.includes('\t')).every(r=>r.role==='table'));
  assert.equal(records.find(r=>r.text.startsWith('Q=')).role,'code');
  const damaged=source.replace(formula,formula.replaceAll('\n','\n\n')).replace('64–95','\n64–95').replace('96–127','\n96–127');
  const out=structure.restoreFinalDocumentLayout(options(source,damaged));
  assert.equal(out.structuralPass,true,JSON.stringify(out.returnedStructureAudit));
  assert.ok(out.text.includes(table));
  assert.ok(out.text.includes(formula));
  assert.equal(bare(out.text),bare(source));
  assert.equal(structure.restoreFinalDocumentLayout(options(source,out.text)).text,out.text);
});

test('readability limits apply to every paragraph after aggregate target counts are met', () => {
  const source=Array.from({length:15},(_,i)=>`연구팀은 ${i+1}차 관찰에서 기록한 자료를 검토하고 각 조건의 차이를 확인하였다.`).join(' ');
  const out=structure.restoreFinalDocumentLayout(options(source));
  assert.equal(out.structuralPass,true);
  assert.equal(out.readabilityPass,true);
  assert.ok(layout.measureParagraphReadability(out.text,{documentProfile:'report_assignment'}).maxSentences<=7);
  assert.equal(bare(out.text),bare(source));
  assert.equal(structure.restoreFinalDocumentLayout(options(source,out.text)).text,out.text);
});

test('delivery settling repairs the selected candidate before final observation', async () => {
  const source=preflight.auditAndSanitizeSource(physicalSource).text;
  const repair={paragraphs:{afterCount:91,targetCount:91}};
  const args={...options(source,source.replace('확인하고 있다.','확인하고 있\n다.')),
    submittedSource:physicalSource,layoutRepair:repair};
  const out=await delivered.settleDeliveredLayout(args);
  assert.equal(out.accepted,true);
  assert.doesNotMatch(out.text,/있\n다\./u);
  delivered.refreshDeliveredLayoutAudit({...args,outputText:out.text});
  assert.equal(repair.finalDelivered.structuralPass,true);
  assert.equal(repair.finalDelivered.readabilityPass,true);
  assert.equal(repair.paragraphs.afterCount,layout.splitReadableParagraphs(out.text).length);
  assert.equal(repair.finalDelivered.explicitParagraphCount,layout.splitExplicitParagraphs(out.text).length);
  assert.equal((await delivered.settleDeliveredLayout({...args,outputText:out.text})).text,out.text);
});

test('delivery settling does not invent missing headings or overwrite creative layouts', async () => {
  const source='1. 준비\n자료를 검토했다.\n2. 실행\n방법을 적용했다.';
  const missing=source.replace('2. 실행\n','');
  const out=await delivered.settleDeliveredLayout(options(source,missing));
  assert.equal(out.accepted,false);
  assert.equal(out.text,missing);
  const poem='밤길을 걸으며\n너를 생각하고\n작은 창 앞에 섰다.';
  assert.equal((await delivered.settleDeliveredLayout(options(poem,poem,{documentProfile:'creative',normalizeVisualGaps:false}))).text,poem);
});

test('final semantic fallback cannot reuse a verdict for a changed token or relation projection', async () => {
  const provenance=require('../engine-gpt-prod/semanticProvenance');
  const source=Array.from({length:15},(_,i)=>`연구팀은 ${i+1}차 자료를 자세하게 검토하고 조건의 차이를 확인하였다.`).join(' ');
  const report=provenance.bindSemanticValidation({ran:true,pass:true},source,source);
  const acceptCandidate=candidate=>provenance.verifySemanticValidation(report,{source,candidate,requireDigest:true}).status==='pass';
  const out=await delivered.settleDeliveredLayout({...options(source),acceptCandidate});
  assert.equal(out.accepted,true);
  assert.equal(acceptCandidate(out.text),true);
  const denied=await delivered.settleDeliveredLayout({...options(source),acceptCandidate:()=>false});
  assert.equal(denied.accepted,false);
  assert.equal(denied.text,source);
});
