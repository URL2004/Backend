'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {splitProseParagraphs:split}=require('../engine-gpt-prod/proseParagraphs');
const layout=require('../engine-gpt-prod/layoutStructure');
const structure=require('../engine-gpt-prod/structureChunk');
const preflight=require('../engine-gpt-prod/sourcePreflight');
const profile={profile:'report_assignment',formatProfile:{flags:['sectioned']}};
const policy='지역의 안전을 개선하려면 여러 제도적 장치가 뒷받침되어야 한다. 먼저 시설의 안전 기준을 정비하고 실제로 적용되는지 주기적으로 확인하는 것이 중요하다. 기업이 사고 발생 현황을 공시하도록 의무화하여 이용자가 충분한 정보를 얻을 수 있도록 해야 한다. 무엇보다 어릴 때부터 위험을 인식하고 대응하는 교육을 제공해야 하며, 미디어에서도 다양한 안전 실천 방법을 꾸준히 소개하여 생활 속 문화 변화를 도와야 한다.';
const response='참가자는 학습에 적극적으로 참여하며 스스로 계획한 목표를 이루려고 노력했다. 그러나 반복된 실패 때문에 자신감을 잃고 과제를 포기하려고 생각했다. 이때 지도자는 참가자에게 자신의 능력에 적합한 과제를 제시하고 실천할 방법을 구체적으로 설명해야 한다. 단계별로 충분히 연습할 기회를 제공하고 필요한 도움을 받을 수 있도록 지원해야 한다. 이러한 지도는 참가자가 작은 성공 경험을 쌓고 학습에 다시 참여하도록 도움을 줄 수 있다. 이는 학습 과정에서 자신감을 회복하고 장기적으로 꾸준히 참여하도록 돕는 데 의미가 있다.';
test('creates new semantic boundaries when the source has none, including sectioned body',()=>{
 for(const text of [response,'1. 실천 계획\n\n'+response]){
  const out=structure.restoreParagraphLayout({source:text,outputText:text,mode:'blog',requestStrength:'basic',documentProfile:profile});
  assert.match(out.text,/\n\n이때 지도자는/);assert.match(out.text,/\n\n이러한 지도는/);
  assert.equal(out.text.replace(/\s/gu,''),text.replace(/\s/gu,''));
  assert.equal(structure.restoreParagraphLayout({source:text,outputText:out.text,mode:'blog',requestStrength:'basic',documentProfile:profile}).text,out.text);
 }
});
test('separates a developed policy block from a cultural intervention below the length cap',()=>{
 const out=split('1. 방법\n\n'+policy);
 assert.equal(out.splitCount,1);assert.match(out.text,/\n\n무엇보다/);
 assert.equal(split(out.text).text,out.text);
});
test('protects standalone quotes, code, lists, and table blocks',()=>{
 for(const text of ['“'+response+'”','```\n\n'+response+'\n\n```','> '+response,'- '+response,'| 본문 |\n|---|\n| '+response+' |']) assert.equal(split(text).text,text);
});
test('does not split on an isolated connector or short adjacent sentences',()=>{
 for(const text of ['설명을 들었다. 내용을 이해했다. 반면 어려움도 있었다. 다시 확인했다.',policy.replace('무엇보다','그 과정에서')])assert.equal(split(text).text,text);
});
test('polish and creative do not acquire new body paragraphs',()=>{
 for(const opts of [{mode:'polish',documentProfile:profile},{mode:'blog',documentProfile:{profile:'creative'}}]) {
 const out=structure.restoreParagraphLayout({source:response,outputText:response,requestStrength:'basic',...opts});
 assert.equal(out.text,response);
 }
});
test('purpose plus unfinished modifier remains editable prose under a heading',()=>{
 const fragment='참가자의 학습을 돕기 위해서는 지도자의 지속적인';
 const source='3. 피드백\n\n'+fragment+'\n피드백을 제공하는 것이 중요하다. 수행 과정에서 구체적인 개선 방향을 확인할 수 있도록 충분한 설명을 제공한다.';
 assert.equal(layout.buildLineRecords(source).find(r=>r.text===fragment).role,'prose');
 assert.match(preflight.repairSourceLayoutArtifacts(source).text,/지속적인 피드백/);
 assert.equal(layout.isKnownHeadingLine('3. 지속적인 피드백'),true);
});
test('locked headings and final fixed-point restoration keep new prose splits',()=>{
 const source='1. 실천 계획\n\n'+response+'\n\n2. 문화 변화\n\n'+policy;
 const chunks=structure.splitChunksForGpt(source,{coalesceEditable:true}).chunks;
 const options={source,outputText:source,chunks,mode:'blog',requestStrength:'basic',documentProfile:profile,normalizeVisualGaps:true};
 const a=structure.restoreFinalDocumentLayout(options);
 assert(a.contentPreserved);assert(a.converged);assert(a.structuralPass);
 assert.match(a.text,/\n\n이때 지도자는/);assert.match(a.text,/\n\n무엇보다/);
 assert.equal(structure.restoreFinalDocumentLayout({...options,outputText:a.text}).text,a.text);
});
test('a personal reflection lead belongs with its following reflection, not the summary',()=>{
 const text='강연에서는 지역의 변화에 관해 설명했다. 여러 사례를 들어 사람들이 경험을 공유하는 과정을 살폈다. 이러한 통찰 앞에서 나는 그동안 성급하게 판단했던 내 모습을 돌아보게 됐다.\n\n특히 강연자의 설명은 새로운 깨달음으로 남았다. 나만의 관점을 다시 생각하고 앞으로의 방향을 정리했다.';
 const a=split(text);
 assert.equal(a.boundaryMoveCount,1);assert.match(a.text,/\n\n이러한 통찰/);
 assert.match(a.text,/됐다\. 특히/);assert.equal(split(a.text).text,a.text);
 assert.equal(a.text.replace(/\s/gu,''),text.replace(/\s/gu,''));
});
