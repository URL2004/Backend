'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const body = '지역 도서관의 운영 기록을 검토하면서 각 프로그램의 목적과 참여자의 의견을 함께 정리했다. 기록만으로 효과를 단정하지 않고 다음 조사에서 확인해야 할 조건과 자료의 한계를 구분해 설명했다.';
const source = [1,2,3].map(n => `${n}. ${n===3?'‘운영 기록’에 관한 설명이다. ':''}${body}`).join('\n');
const bare = text => text.replace(/\s/gu, '');
for (const mode of ['blog','formal']) {
  test(`${mode}: developed numbered answers gain visual gaps through final fixed point`, () => {
    const plan = structure.splitChunksForGpt(source, {coalesceEditable:true});
    const options = {source, outputText:source, chunks:plan.chunks, mode, requestStrength:mode==='formal'?'advanced':'basic', normalizeVisualGaps:true};
    const result = structure.restoreFinalDocumentLayout(options);
    assert.equal(result.text.split(/\n\n/u).length,3);
    assert.equal(bare(result.text),bare(source));
    assert.equal(result.structuralPass,true);
    assert.equal(result.converged,true);
    assert.equal(structure.restoreFinalDocumentLayout({...options,outputText:result.text}).text,result.text);
    assert.equal(layout.measureParagraphReadability(result.text).overlongCount,0);
    assert.equal(structure.compareOriginalStructuralMarkers(source,result.text).pass,true);
  });
}
test('readability detects missing developed-answer gaps instead of exempting all lists', () => {
  assert.equal(layout.measureParagraphReadability(source).targetCount,3);
  assert.equal(layout.measureParagraphReadability(source).overlongCount,1);
});
for(const [name,text] of Object.entries({
  compact:'1. 준비물 확인\n2. 현장 점검\n3. 결과 제출',
  answerKey:'1. ①\n2. ③\n3. ②',
  code:'```text\n'+source+'\n```',
  quote:source.split('\n').map(x=>'> '+x).join('\n'),
  nested:`1. ${body}\n  2. ${body}`,
  numberingGap:`1. ${body}\n3. ${body}`,
  hierarchy:`1.1 ${body}\n1.2 ${body}`,
  table:`| 번호 | 내용 |\n| 1 | ${body} |\n| 2 | ${body} |`
})) test(`${name}: no developed-list gap candidate`,()=>{
  const records=layout.buildLineRecords(text);
  assert.equal(records.slice(1).some((r,i)=>layout.needsDevelopedListGap(records[i],r)),false);
});
test('existing blank lines are not doubled',()=>{
 const text=source.replace(/\n/g,'\n\n');
 assert.equal(layout.measureParagraphReadability(text).overlongCount,0);
 assert.equal(structure.restoreParagraphLayout({source:text,outputText:text,mode:'blog'}).text,text);
});
for(const mode of ['blog','formal']) test(`${mode}: sensitive profiles do not gain gaps`,()=>{
 for(const profile of ['creative','clinical_record','legal_contract']) {
  const options={source,outputText:source,mode,documentProfile:profile,normalizeVisualGaps:true};
  assert.equal(structure.restoreFinalDocumentLayout(options).text,source,profile);
 }
});
test('polish retains the original single-line separators',()=>{
 const plan=structure.splitChunksForGpt(source,{mode:'polish'});
 const r=structure.restoreFinalDocumentLayout({source,outputText:source,chunks:plan.chunks,mode:'polish',normalizeVisualGaps:true});
 assert.equal(r.text,source);
 assert.equal(layout.measureParagraphReadability(source,{mode:'polish'}).overlongCount,0);
});
test('CRLF and parenthesized sibling numbers preserve text and normalize gaps',()=>{
 const text=source.replace(/^(\d)\./gm,'$1)').replace(/\n/g,'\r\n');
 const r=structure.restoreFinalDocumentLayout({source:text,outputText:text,mode:'blog',normalizeVisualGaps:true});
 assert.equal(r.text.split('\n\n').length,3);
 assert.equal(bare(r.text),bare(text));
});
test('user-approved structure is not flagged for deliberately retained list spacing',()=>{
 const {buildHumanizeContract}=require('../engine-gpt-prod/humanizeContract');
 const humanizeContract=buildHumanizeContract({mode:'formal',requestStrength:'advanced',approvedStructure:true});
 const r=structure.restoreFinalDocumentLayout({source,outputText:source,mode:'formal',normalizeVisualGaps:true,humanizeContract});
 assert.equal(r.text,source);
 assert.equal(r.readabilityPass,true);
 assert.equal(layout.measureParagraphReadability(source,{mode:'formal',humanizeContract}).overlongCount,0);
});
