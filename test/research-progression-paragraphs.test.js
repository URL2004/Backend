'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../engine-gpt-prod/structureChunk');
const {isResearchProgression} = require('../engine-gpt-prod/proseParagraphs');
const {buildHumanizeContract} = require('../engine-gpt-prod/humanizeContract');
const rows = [
  '기록 전문가가 수행하는 자료 보존을 더 자세히 알아보고 싶어 이 자료를 선정했다.',
  '손상된 자료를 복구한 뒤 오래 활용할 수 있도록 보존 처리를 실시한다.',
  '다만 나는 처리 자체보다 적절한 시기에 꾸준히 관리하는 점도 중요하다고 생각했다.',
  '자료 보존을 먼저 알아본 뒤, 이번에는 보존이 이루어지는 기관도 살펴보고 싶어 선정했다.',
  '자료 보존 기관에서는 여러 분야의 전문가가 협력하여 다양한 보존 작업을 수행한다는 것을 알게 되었다.',
  '하나의 기록을 보존하기 위해 여러 직종이 각자의 역할을 맡고 협력한다는 점을 이해하게 되었다.',
  '자료 보존의 정의와 담당 기관을 살펴본 데 이어, 국가가 기관을 지정하는 기준을 확인하고자 이 자료를 골랐다.',
  '국가 차원의 기록 관리 체계가 작동하는 방식과 세부적인 절차도 이해할 수 있었다.',
  '과거에는 적절한 기관을 찾지 못해 자료를 방치하는 경우가 많았지만 국가가 기준을 마련하면서 체계적으로 기록을 관리할 수 있게 되었다.'
];
const source = rows.join(' ');
const output = rows.slice(0,2).join(' ')+'\n\n'+rows.slice(2).join(' ');
const profile = {profile:'report_assignment', confidence:.96};
function run(mode, outputText=output, approved=false) {
  const humanizeContract=buildHumanizeContract({mode,documentProfile:profile,approvedStructure:approved});
  return st.restoreFinalDocumentLayout({source,outputText,mode,requestStrength:humanizeContract.strength,
    documentProfile:profile,humanizeContract,chunks:st.splitChunksForGpt(source,{coalesceEditable:true}).chunks,
    normalizeVisualGaps:true});
}
test('basic and advanced separate three research topics, retaining preceding qualification',()=>{
  const expected=[rows.slice(0,3),rows.slice(3,6),rows.slice(6)].map(g=>g.join(' ')).join('\n\n');
  for(const mode of ['blog','formal']) {
    const result=run(mode);
    assert.equal(result.text,expected,mode);
    assert.equal(result.structuralPass,true);
    assert.equal(result.text.replace(/\s/gu,''),output.replace(/\s/gu,''));
    assert.equal(run(mode,result.text).text,result.text);
  }
});
test('an unsplit output acquires the same content-based topic boundaries',()=>{
  assert.equal(run('formal',source).text,run('formal').text);
});
test('single procedures, quoted plans and plain chronology are not research topic changes',()=>{
  for(const text of [
    '자료를 검토한 뒤 오류를 확인하고 필요한 부분을 수정했다.',
    '자료를 알아본 뒤 내용을 정리했다.',
    '그는 “기관을 알아본 뒤 다른 곳도 살펴보고 싶어 선정했다.”라고 말했다.'
  ]) assert.equal(isResearchProgression(text),false);
});
