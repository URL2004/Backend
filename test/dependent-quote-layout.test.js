'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {dependentQuoteLayout,canRepairDependentQuoteLayout}=require('../engine-gpt-prod/dependentQuoteLayout');
const q=require('../engine-gpt-prod/koreanRefinement');
const structure=require('../engine-gpt-prod/structureChunk');
const layout=require('../engine-gpt-prod/layoutStructure');
const {syntaxSpans}=require('../engine/textSyntax');
const fragment='처음의 질문이었던\n\n“자료를 어떻게 분류할까?”\n\n는 조사를 진행하면서\n\n“분류 기준은 어떤 차이를 만드는가?”\n\n라는 질문으로 구체화되었다.';
const joined='처음의 질문이었던 “자료를 어떻게 분류할까?”는 조사를 진행하면서 “분류 기준은 어떤 차이를 만드는가?”라는 질문으로 구체화되었다.';

test('pre-existing five-fragment sentence is prose, not a title and two locked blocks',()=>{
 const result=dependentQuoteLayout(fragment);
 assert.equal(result.text,joined);assert.equal(result.repairCount,4);
 assert.equal(dependentQuoteLayout(result.text).applied,false);
 assert.ok(layout.buildLineRecords(fragment).filter(r=>!r.blank).every(r=>r.role==='prose'));
 assert.equal(structure.splitChunksForGpt(fragment).chunks.filter(c=>c.locked).length,0);
 for(const fn of ['compareLineAnchorLayout','compareStructuralRoleSignatures','compareOriginalStructuralMarkers']) assert.equal(structure[fn](fragment,joined).pass,true,fn);
});
test('broken prose quote fragments do not create a false creative exact-line contract',()=>{
 const profile=require('../engine-gpt-prod/documentProfile').detectDocumentProfile(fragment);
 assert.notEqual(profile.profile,'creative');
 assert.equal(profile.formatProfile.flags.includes('line_sensitive'),false);
});
for(const [open,close] of [['“','”'],['‘','’'],['「','」'],['『','』'],['《','》'],['〈','〉'],['"','"'],["'","'"]]) {
 test(`literal ${open}${close} content survives surrounding whitespace repair`,()=>{
  const text=`조사에서 다룬 질문은\n\n${open}두 조건은 같은가?${close}\n\n라는 물음과 연결된다.`;
  const fixed=dependentQuoteLayout(text).text;
  assert.equal(fixed,`조사에서 다룬 질문은 ${open}두 조건은 같은가?${close}라는 물음과 연결된다.`);
  const quotes=v=>syntaxSpans(v).filter(s=>s.spanType==='quote').map(s=>v.slice(s.start,s.end));
  assert.deepEqual(quotes(fixed),quotes(text));
 });
}
test('nested literal punctuation remains byte-identical',()=>{
 const text='다음에 확인할 질문은\n\n“‘A. B.’는 이름인가?”\n\n라는 물음이었다.';
 assert.equal(dependentQuoteLayout(text).text,'다음에 확인할 질문은 “‘A. B.’는 이름인가?”라는 물음이었다.');
});
test('copula sentences and a following connective share the same quote ownership',()=>{
 for(const copula of ['이다.','였다.','이었다.','입니다.','였습니다.','이었습니다.']) {
  const text=`처음의 질문은\n\n“같은가?”\n\n${copula} 조사를 진행하면서\n\n“기준은 무엇인가?”\n\n라는 질문으로 바뀌었다.`;
  assert.equal(dependentQuoteLayout(text).text,`처음의 질문은 “같은가?”${copula} 조사를 진행하면서 “기준은 무엇인가?”라는 질문으로 바뀌었다.`);
 }
 const single='처음의 질문은\n\n“같은가?”\n\n였다.';
 assert.equal(dependentQuoteLayout(single).text,'처음의 질문은 “같은가?”였다.');
});
for(const [name,text] of [
 ['standalone epigraph','“자료를 분류하라.”\n\n다음 장에서는 그 방법을 살펴본다.'],
 ['demonstrative','“자료를 분류하라.”\n\n이 문장은 인용문이다.'],
 ['byline','“자료를 분류하라.”\n\n— 작성자'],
 ['markdown quote','> “자료를 분류하라.”\n\n라는 문장을 검토한다.'],
 ['code','```txt\n'+fragment+'\n```'],
 ['reference','참고문헌\n'+fragment],
 ['table','| “자료를 분류하라.” |\n\n라는 문장을 검토한다.'],
 ['unmatched','처음에 다룬 질문은\n\n“자료를 분류하라.\n\n라는 문장이었다.'],
 ['quote-internal poem','“첫 줄\n둘째 줄”\n\n라는 문장이었다.'],
 ['explicit heading','1. 조사 목적\n\n“자료를 분류하라.”\n\n다음 절의 내용이다.']
]) test(`preserves ${name}`,()=>assert.equal(dependentQuoteLayout(text).text,text));
test('creative, exact-line and unknown contracts do not enable automatic envelope repair',()=>{
 for(const profile of ['creative','legal_contract','clinical_record','unknown']) assert.equal(canRepairDependentQuoteLayout(profile),false);
 assert.equal(canRepairDependentQuoteLayout('report_assignment',{lineSensitive:true}),false);
 assert.equal(q.applySafeFormattingRepairs({source:fragment,outputText:fragment,documentProfile:'creative'}).text,fragment);
});
test('prose profile aliases share one quote boundary policy',()=>{
 for(const profile of ['general','general_essay','review_blog','blog_review','academic_paper','report_assignment']) {
  assert.equal(canRepairDependentQuoteLayout(profile),true);
  assert.equal(q.applySafeFormattingRepairs({source:fragment,outputText:fragment,documentProfile:profile}).text,joined);
 }
});
test('complete preceding sentence and following paragraph stay independent',()=>{
 const text='먼저 자료를 정리했다.\n\n“같은가?”\n\n라는 질문이 생겼다.\n\n다음에는 기준을 만들었다.';
 assert.equal(dependentQuoteLayout(text).text,'먼저 자료를 정리했다.\n\n“같은가?”라는 질문이 생겼다.\n\n다음에는 기준을 만들었다.');
});
test('content deletion or independent title collapse is still rejected',()=>{
 const bad='조사 목적\n\n'+fragment;
 assert.equal(structure.compareLineAnchorLayout(bad,'조사 목적 '+joined).pass,false);
 const standalone='“중요한 독립 인용문이다.”\n\n다른 본문이다.';
 assert.equal(structure.compareStructuralRoleSignatures(standalone,'다른 본문이다.').pass,false);
 const audit=require('../engine-gpt-prod/voiceProfile').auditDirectQuoteIntegrity;
 assert.equal(audit(fragment,joined).pass,true);
 assert.equal(audit(fragment,joined.replace('분류 기준','분류 결과')).pass,false);
});
test('whitespace variants retain exact literal contents and reach a fixed point',()=>{
 for(const newline of ['\n','\r\n'])for(const count of [1,2,3])for(const gap of ['','  ','\t']) {
  const input=fragment.replace(/\n\n/g,gap+newline.repeat(count)+gap);
  const out=dependentQuoteLayout(input).text;
  assert.equal(out,gap==='\t'?input:joined); // tab-bearing rows stay protected
  assert.equal(out.replace(/\s/gu,''),input.replace(/\s/gu,''));
  assert.equal(dependentQuoteLayout(out).applied,false);
 }
});
test('deterministic repair, formatting, layout restore converge without reintroducing fragments',()=>{
 const documentProfile={profile:'report_assignment',confidence:.99};
 let text=q.applySafeDeterministicRepairs({source:fragment,outputText:fragment,documentProfile}).text;
 assert.equal(text,joined);
 const chunks=structure.splitChunksForGpt(fragment).chunks;
 for(let i=0;i<3;i++) {
  text=structure.restoreFinalDocumentLayout({source:fragment,outputText:text,chunks,mode:'assignment',requestStrength:'advanced',documentProfile}).text;
  text=q.applySafeFormattingRepairs({source:fragment,outputText:text,documentProfile}).text;
  assert.equal(text,joined);
 }
});
