'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const st=require('../engine-gpt-prod/structureChunk');
const ds=require('../engine-gpt-prod/documentStructure');
const {buildHumanizeContract,paragraphPromptLine,validateTrustedPromptContract}=require('../engine-gpt-prod/humanizeContract');
const {buildVoiceProfile,auditVoice}=require('../engine-gpt-prod/voiceProfile');
const {activity}=require('./fixtures/mode-paragraphs');
const {activityEvidence}=require('../engine-gpt-prod/proseParagraphs');
const profile={profile:'report_assignment',confidence:.95,formatProfile:{flags:['sectioned']}};
function run(source,mode='blog',approved=false,output=source){
 const humanizeContract=buildHumanizeContract({mode,documentProfile:profile,approvedStructure:approved});
 const options={source,outputText:output,mode,requestStrength:humanizeContract.strength,documentProfile:profile,humanizeContract,
   chunks:st.splitChunksForGpt(source,{coalesceEditable:true}).chunks,normalizeVisualGaps:true};
 const result=st.restoreFinalDocumentLayout(options);
 assert.equal(result.text.replace(/\s/gu,''),output.replace(/\s/gu,''));
 assert.equal(result.structuralPass,true);
 assert.equal(st.restoreFinalDocumentLayout({...options,outputText:result.text}).text,result.text);
 return result;
}
test('basic improves body under a fixed heading without moving facts',()=>{
 const r=run('1. 지역 조사 활동\n\n자기평가의견\n\n'+activity);
 assert.ok(r.text.includes('표현했다.\n\n완성한'));
 assert.ok(!r.text.includes('세웠다.\n\n수집한'));
 assert.match(r.paragraphs.paragraphs.policy,/basic_block_roles/);
 assert.ok(r.paragraphs.paragraphs.roleBoundaryCount>0);
});
test('advanced also separates selection and implementation, even with sectioned flag',()=>{
 const r=run('1. 지역 조사 활동\n\n자기평가의견\n\n'+activity,'formal');
 assert.ok(r.text.includes('세웠다.\n\n수집한'));
 assert.ok(r.text.includes('표현했다.\n\n완성한'));
 assert.match(r.paragraphs.paragraphs.policy,/advanced_block_roles/);
});
test('approved structure cannot be silently subdivided by the generic layout pass',()=>{
 const doc=ds.buildDocument(activity),p=ds.identityPlan(doc);
 p.groups[0].breakAfterSentences=[2];
 const approved=ds.applyPlan(doc,p).text;
 const r=run(approved,'formal',true);
 assert.equal(r.text,approved);
 assert.equal(r.paragraphs.paragraphs.policy,'approved_structure');
 assert.equal(ds.auditDelivery(approved,r.text).pass,true);
});
test('body with inline quotation is editable in structure planning; quote remains exact',()=>{
 const text=activity.replace('지역 문화 소개','「마을의 기록」 소개');
 const doc=ds.buildDocument(text);assert.equal(doc.eligible,true);
 assert.equal(doc.blocks[0].kind,'paragraph');
 const p=ds.identityPlan(doc);p.groups[0].breakAfterSentences=[1,4];
 const r=ds.applyPlan(doc,p);assert.ok(r.applied);assert.ok(r.text.includes('「마을의 기록」'));
});
test('polish remains local correction, not basic/advanced paragraph rewriting',()=>{
 assert.equal(run(activity,'polish').text,activity);
});
test('single coherent procedure is not split merely by action verbs',()=>{
 const text='표의 열을 먼저 구성했다. 입력 순서에 맞춰 화면을 설계했다. 자료의 위치를 바꾸고 설명을 작성했다. 필요한 항목을 추가하고 배치를 조정했다.';
 assert.equal(run(text,'formal').text,text);
});

test('nested quoted roles do not leak into body evidence or consume following prose',()=>{
 const evidence=activityEvidence('“목표를 고민하고 ‘검증’을 배웠다.”라는 제목 뒤에서 기능을 제작했다.');
 assert.equal(evidence.orientation,false);
 assert.equal(evidence.validation,false);
 assert.equal(evidence.reflection,false);
 assert.equal(evidence.execution,true);
});
test('headings, date, quote and fenced code stay under their own items',()=>{
 const source='1. 첫 활동 (2026. 9. 1.)\n\n'+activity+'\n\n2. 코드\n\n```js\nif (a) {\n\n  run();\n}\n```';
 const r=run(source,'formal');assert.ok(r.text.includes('2. 코드\n\n```js\nif (a) {\n\n  run();\n}\n```'));
 assert.equal(r.text.split('2026. 9. 1.').length,2);
});
test('authorized layout policy suffix does not become a paragraph-count false alarm',()=>{
 const result=run(activity,'formal');const report=result.paragraphs.paragraphs;
 const voice=auditVoice(buildVoiceProfile(activity,{documentProfile:profile}),result.text,{documentProfile:profile,sourceText:activity,mode:'assignment',layoutPolicy:report.policy,layoutTargetCount:report.afterCount});
 assert.equal(voice.warnings.some(w=>w.code==='paragraph_structure_changed'),false);
});
test('trusted controls distinguish intermediate anchors from final prose structure',()=>{
 for(const mode of ['blog','formal']){
  const c=buildHumanizeContract({mode,documentProfile:profile}),system=paragraphPromptLine(c);
  assert.match(system,/최종 문단 수 보존 목표가 아니다/);
  assert.equal(validateTrustedPromptContract({system,humanizeContract:c}).pass,true);
 }
});
