'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {detectDocumentProfile}=require('../engine-gpt-prod/documentProfile');
const korean=require('../engine-gpt-prod/koreanRefinement');
const {auditNaturalnessRegression}=require('../engine-gpt-prod/naturalnessRegression');
const {refineParagraphRelations}=require('../engine-gpt-prod/paragraphRelations');
const {separateCitedQuoteCommentary}=require('../engine-gpt-prod/citedQuoteParagraphs');
const st=require('../engine-gpt-prod/structureChunk');
const {dependentBoundary}=require('../engine-gpt-prod/paragraphDependency');
const bare=s=>s.replace(/\s/gu,'');

test('contracted strength plus experience and future contribution is an application',()=>{
 const text='제 강점은 예상하지 못한 문제를 찾아 팀원과 협력하는 것입니다. 대회에서 센서 장치를 구현했습니다. 초기 테스트를 마쳤습니다. 팀원들과 회로를 점검했습니다. 그 결과 장치를 완성했습니다. 다음 업무에서도 문제를 공유하겠습니다. 동료와 협력해 안정적인 환경을 만들겠습니다.';
 assert.equal(detectDocumentProfile(text).profile,'resume_application');
});
test('strength statement without a career plan is not forced into an application',()=>{
 assert.notEqual(detectDocumentProfile('제 강점은 호기심이다. 어제는 창밖의 새를 오래 보았다. 그림자를 따라가며 하루를 보냈다.').profile,'resume_application');
});
test('school fit and future admission plan support application genre',()=>{
 const text='저는 오랫동안 영상 제작을 배우며 작품을 기획해 왔습니다. 새봄대학교의 교육 방향이 제가 앞으로 갖추고 싶은 능력과 잘 맞는다고 느꼈습니다. 실습 과목을 통해 다양한 표현 방식을 배우고 싶습니다. 입학 후에는 현장 역량을 쌓아 영상 교육자로 성장하고 싶습니다.';
 assert.equal(detectDocumentProfile(text).profile,'resume_application');
});
test('school facts alone do not imply the author is applying',()=>{
 assert.notEqual(detectDocumentProfile('새봄대학교의 교육 방향은 실습 중심이다. 입학 후 학생들은 기초 수업을 듣는다. 학교는 교육 과정을 안내하고 있다.').profile,'resume_application');
});
test('concept definitions about self expression are not personal memories',()=>{
 const text='의사소통에는 여러 방법이 있다. 경청은 상대방의 말을 이해하고 확인하는 방법이다. 질문은 필요한 정보를 구체적으로 얻는 방법이다. 자기표현은 자신의 생각을 다른 사람에게 전하는 행위이다. 설명은 내용을 분명하게 전달하는 과정이다. 결국 나의 생각도 정확하게 전하는 것이 중요하다고 생각한다.';
 assert.equal(detectDocumentProfile(text).profile,'long_explainer');
});
test('definition evidence cannot displace explicit research or report purpose',()=>{
 const source='1. 조사 결과\n본 연구는 세 가지 개념을 구분하였다. 관찰은 대상을 직접 확인하는 방법이다. 질문은 필요한 정보를 얻는 방법이다. 설명은 내용을 구체적으로 전하는 행위이다. 본 연구의 결과는 집단 간 차이를 보여 준다. 후속 연구에서는 표본을 확대해야 한다.';
 const profile=detectDocumentProfile(source);
 assert.equal(profile.signals.definitionSummaryFrame,false);
 assert.notEqual(profile.profile,'personal_essay');
});
test('a developed definition and its subtype stay together before another concept',()=>{
 const text='기록에는 여러 방법이 있다. 관찰 기록은 대상을 직접 확인하는 방법이다. 참여 관찰 기록은 현장의 활동에 함께 참여하는 방식이다. 질문은 필요한 정보를 얻는 방법이다. 설명은 내용을 전달하는 행위이다.\n\n피드백은 다른 사람의 이해를 확인하는 과정이다. 마지막으로 기록을 다시 확인한다.';
 const options={documentProfile:{profile:'long_explainer',signals:{definitionSummaryFrame:true}}};
 const result=refineParagraphRelations(text,options);
 assert.match(result.text,/참여하는 방식이다\.\n\n질문은/u);
 assert.equal(bare(result.text),bare(text));
 assert.equal(refineParagraphRelations(result.text,options).text,result.text);
});
for(const verb of ['원하는','선택하는','포기하는'])test('source-backed recursive reason repair '+verb,()=>{
 const source=`나는 아직 내가 ${verb} 것의 이유를 정확하게 알지 못한다.`;
 const outputText=`나는 여전히 내가 ${verb} 것이 왜 ${verb} 것인지 정확하게 알지 못한다.`;
 const audit=korean.analyzeKoreanRefinement({source,outputText});
 assert.ok(audit.repairableCodes.includes('introduced_recursive_reason_frame'));
 const result=korean.restoreIntroducedIntegritySentences({source,outputText,audit});
 assert.equal(result.text,source.replace('아직','여전히'));
 assert.equal(auditNaturalnessRegression(source,result.text).length,0);
});
test('reason repairs never guess missing evidence or rewrite protected quotes',()=>{
 const bad='내가 선택하는 것이 왜 선택하는 것인지 분명히 알지 못한다.';
 assert.equal(auditNaturalnessRegression('나는 그 이유를 생각했다.',bad).length,0);
 assert.equal(auditNaturalnessRegression('“내가 선택하는 것의 이유를 알지 못한다.”',`“${bad}”`).length,0);
 assert.equal(auditNaturalnessRegression(bad,bad).length,0);
});
test('unique source cardinality notation is restored without changing its values',()=>{
 const source='한 창고와 물품의 관계는 1:N으로 표현한다.';
 const outputText='창고와 물품의 관계는 1: N으로 나타낸다.';
 const result=korean.restoreIntroducedIntegritySentences({source,outputText});
 assert.equal(result.text,'창고와 물품의 관계는 1:N으로 나타낸다.');
 assert.equal(korean.restoreIntroducedIntegritySentences({source,outputText:result.text}).text,result.text);
 assert.equal(auditNaturalnessRegression(source,'관계는 1: M으로 나타낸다.').length,0);
 assert.equal(auditNaturalnessRegression('`1:N`','`1: N`').length,0);
});
test('claim and dependent example are rebalanced without changing words',()=>{
 const text='책에는 여러 관점이 등장한다. 나는 그 관점을 비교했다. 신뢰는 협력의 원천이다.\n\n서로 신뢰하는 만큼 함께 문제를 풀 수 있다. 여러 경험이 그 사실을 보여 준다. 다음 주에는 다른 관점도 살펴보려고 한다.';
 const result=refineParagraphRelations(text);
 assert.match(result.text,/비교했다\.\n\n신뢰는 협력의 원천이다\. 서로 신뢰하는 만큼/u);
 assert.equal(bare(result.text),bare(text));
 assert.equal(refineParagraphRelations(result.text).text,result.text);
});
test('paired referent stays with its two antecedents',()=>{
 const text='나는 두 관점을 비교했다. 자료마다 해석이 달랐다. 이론과 실천은 서로 다른 곳에 있지 않았다.\n\n둘은 같은 문제를 설명하는 두 관점이었다. 다음 분석에서는 그 관계를 살펴보았다.';
 const result=refineParagraphRelations(text);
 assert.match(result.text,/달랐다\.\n\n이론과 실천은[^\n]+둘은/u);
 assert.equal(bare(result.text),bare(text));
});
test('syllables inside a word do not establish a paired antecedent',()=>{
 assert.equal(dependentBoundary('이 과정은 길었다.','둘은 새롭게 대화를 시작했다.'),'');
});
test('uncertain paraphrases are not restored merely for dropping a thought frame',()=>{
 const source='어쩌면 낯선 냄새는 내 마음에서 나고 있었는지도 모른다는 생각이 들었다.';
 const outputText='낯선 냄새도 어쩌면 내 마음에서 나고 있었을지 모른다.';
 assert.equal(korean.restoreIntroducedIntegritySentences({source,outputText}).text,outputText);
});
const excerpt='“우리는 여러 자료를 함께 읽었다. 서로 다른 관점을 비교했다. 대답이 다른 이유를 확인했다.” (23p)';
test('source-backed cited quote is separated from author commentary, keeping page ownership',()=>{
 const source=excerpt+'\n이 구절을 읽고 내 경험을 다시 살펴보았다.';
 const result=separateCitedQuoteCommentary(source,source);
 assert.equal(result.text,excerpt+'\n\n이 구절을 읽고 내 경험을 다시 살펴보았다.');
 assert.equal(bare(result.text),bare(source));
 assert.equal(separateCitedQuoteCommentary(source,result.text).text,result.text);
});
test('inline quotations, changed references and code do not acquire guessed breaks',()=>{
 for(const source of ['나는 '+excerpt+'\n라고 적었다.',excerpt+'\n라고 적었다.','```\n'+excerpt+'\n메모\n```'])
   assert.equal(separateCitedQuoteCommentary(source,source).text,source);
 assert.equal(separateCitedQuoteCommentary(excerpt+'\n해설이다.',excerpt.replace('23p','24p')+'\n해설이다.').repairCount,0);
});
test('final layout preserves quote/commentary gaps at a fixed point',()=>{
 const source='1. 독서 기록\n'+excerpt+'\n나는 이 대목을 다시 읽었다. 내 경험을 기록과 비교했다. 서로 다른 해석을 구분하려고 했다.';
 const options={source,outputText:source,chunks:st.splitChunksForGpt(source).chunks,mode:'blog',documentProfile:'personal_essay',normalizeVisualGaps:true};
 const result=st.restoreFinalDocumentLayout(options);
 assert.equal(result.structuralPass,true);
 assert.match(result.text,/\(23p\)\n\n나는/u);
 assert.equal(st.restoreFinalDocumentLayout({...options,outputText:result.text}).text,result.text);
});
