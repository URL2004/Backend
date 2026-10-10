'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const quality = require('../engine-gpt-prod/finalQualityV2');
const engine = require('../engine-gpt-prod');
const footnote = '가상연구자, 지역 조사 자료의 작성과 활용에 관한 기초 안내, 가상출판사.';
const clauses = [
 '조사에 참여한 주민은 골목에 쌓인 쓰레기 문제를 설명하면서 구청에 새로운 처리 방안을 제안하고',
 '산악 지역의 관리자는 비가 많이 내리는 여름철에 급격하게 불어나는 계곡물을 살펴보기 위해',
 '도서관에서는 어린 학생들이 매주 읽었던 동화책의 인물을 그림으로 표현하는 수업을 준비하며',
 '반도체 부품을 조립하는 공장에서는 온도와 습도가 제조 과정에 미치는 영향을 계산하기 위해',
 '농장의 수확 시기가 다가오자 작업자들은 감자와 당근을 담을 상자의 크기와 개수를 확인하고'
];
const submitted = clauses.map(s => s + '\n' + footnote).join('\n\n');
const normalized = clauses.map(s => s + ' ' + footnote).join('\n\n');
const output = submitted.replace('주민은', '주민들은');
const hasRepetition = items => items.some(x => ['repetition','generated_duplicate_block'].includes(x.code || x.gate || x.type));

test('submitted footnotes are not generated repetition after preprocessing joins their rows', () => {
 const old = quality.compareRepetitionDelta(normalized, output);
 assert.equal(old.increased, true);
 assert.equal(engine.isBlockingGeneratedRepetition(old), true);
 const fixed = quality.compareRepetitionDelta(normalized, output, {submittedSource:submitted});
 assert.equal(fixed.increased, false);
 assert.equal(engine.isBlockingGeneratedRepetition(fixed), false);
 const gate = engine.evaluateWholeDocumentGate({source:normalized,submittedSource:submitted,outputText:output,contract:{},mode:'polish'});
 assert.equal(hasRepetition(gate.violations), false);
 const audit = quality.buildDeterministicAudit({source:normalized,submittedSource:submitted,outputText:output,contract:{},mode:'polish'});
 assert.equal(audit.repetitionAudit.increased, false);
 assert.equal(hasRepetition(audit.warnings), false);
});

test('new repeated sentences still exceed both source layouts and block delivery', () => {
 const repeated = '관측 자료를 모두 확인한 뒤 다음 조사에서 적용할 기준과 실행 절차를 정리하였다.';
 const single = quality.compareRepetitionDelta(normalized, output+'\n'+Array(4).fill(repeated).join('\n'), {submittedSource:submitted});
 assert.equal(single.increased,true);
 const block = repeated+' 산악 지대에서는 빗물이 내려오는 속도를 주기적으로 측정하며 강수량과 비교한다. 제조 공장의 온도계를 교체한 뒤 부품별 냉각 시간을 다시 계산한다.';
 const value = output + '\n\n' + Array(4).fill(block).join('\n');
 const audit = quality.compareRepetitionDelta(normalized,value,{submittedSource:submitted});
 assert.equal(audit.increased,true);
 assert.equal(engine.isBlockingGeneratedRepetition(audit),true);
 assert.equal(engine.evaluateWholeDocumentGate({source:normalized,submittedSource:submitted,outputText:value,contract:{},mode:'polish'}).reason,'generated_duplicate_block');
});

test('line wrapping alone never creates chunk repetition and the next copy still does', () => {
 const fixed = quality.compareRepetitionDelta(normalized,submitted);
 assert.equal(fixed.increased,false);
 const gate = engine.evaluateChunkGate({original:normalized,outputText:submitted,contract:{},protectedTerms:[],mode:'polish'});
 assert.equal(hasRepetition(gate.violations),false);
 assert.equal(quality.compareRepetitionDelta(submitted, submitted+'\n'+footnote).increased,true);
});

test('repetition calibration removes only inherited repetition and preserves other review reasons', () => {
 const result = {floorReport:{status:'needs_review',criticals:[{gate:'repetition'},{gate:'number_multiset_changed'}],warnings:[{gate:'repetition'}],metrics:{}}};
 engine.calibrateV2RepetitionReport(result,normalized,output,submitted);
 assert.deepEqual(result.floorReport.criticals,[{gate:'number_multiset_changed'}]);
 assert.deepEqual(result.floorReport.warnings,[]);
 assert.equal(result.floorReport.status,'needs_review');
 const clean = {floorReport:{status:'needs_review',criticals:[{gate:'repetition'}],warnings:[],metrics:{}}};
 engine.calibrateV2RepetitionReport(clean,normalized,output,submitted);
 assert.equal(clean.floorReport.status,'clean');
});
