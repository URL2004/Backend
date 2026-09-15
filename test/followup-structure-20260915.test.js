'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.FOLLOWUP_TEST_REPO||path.resolve(__dirname,'..');
const sp=require(root+'/engine-gpt-prod/sourcePreflight');
const ls=require(root+'/engine-gpt-prod/layoutStructure');
const dp=require(root+'/engine-gpt-prod/documentProfile');
const sc=require(root+'/engine-gpt-prod/structureChunk');
const vp=require(root+'/engine-gpt-prod/voiceProfile');
const body='이 문단은 검토한 자료를 바탕으로 연구의 내용을 설명한다. 자료를 해석할 때에는 확인한 사실과 아직 검증하지 못한 가능성을 구분해야 한다. 서로 다른 조건에서 얻은 결과를 단순히 동일한 값으로 취급하지 않는다.';

test('contextual nominal titles are not fused merely because their nouns end in a particle character',()=>{
 for(const heading of ['연구의 의의','정책의 효과','조사의 결과']){
  const source=`2. 자료 검토\n${heading}\n${body}`;
  const result=sp.auditAndSanitizeSource(source);
  assert.ok(result.text.includes(`\n${heading}\n`),heading);
  assert.equal(result.text.replace(/\s/g,''),source.replace(/\s/g,''));
 }
});
test('about-complement followed by a predicate is restored without changing words',()=>{
 const source='저는 오늘 기술 변화가 생활에 미치는 영향에 대해서\n발표하겠습니다\n'+body;
 const r=sp.auditAndSanitizeSource(source);
 assert.match(r.text,/영향에 대해서 발표하겠습니다/);
 assert.equal(r.text.replace(/\s/g,''),source.replace(/\s/g,''));
 assert.equal(sp.auditAndSanitizeSource(r.text).text,r.text);
});
test('short opening lines cannot freeze a document whose character mass is ordinary prose',()=>{
 const source='안녕하세요.\n저는 발표자입니다.\n발표를 시작하겠습니다\n'+body.repeat(3)+' 이만 발표를 마치겠습니다. 감사합니다.';
 const p=dp.detectDocumentProfile(source);
 assert.notEqual(p.profile,'mail_notice');
 assert.ok(!p.formatProfile.flags.includes('line_sensitive'));
 assert.notEqual(vp.buildVoiceProfile(source,{documentProfile:p}).lineBoundaryPolicy,'all');
});
test('genuine verse and recipient-request mail keep their existing protection',()=>{
 const verse='바람의 노래\n오래된 창가\n하얀 달빛\n조용한 숲\n낮은 속삭임';
 const p=dp.detectDocumentProfile(verse);
 assert.ok(p.formatProfile.flags.includes('line_sensitive'));
 const mail='교수님 안녕하세요.\n발표 자료를 보내 드립니다.\n내일 발표하겠습니다. 확인 후 회신 부탁드립니다.\n감사합니다. 학생 드림';
 assert.equal(dp.detectDocumentProfile(mail).profile,'mail_notice');
});
const prompts=[
 '1. 협업에서 중요한 태도를 고르세요. 그 이유와 실제 행동을 설명해주세요. (교내 활동 제외)',
 '2. 어려움을 해결한 경험은 무엇인가요? 그 과정을 작성해 주세요.',
 '3. 업무 환경은 계속 달라지고 있습니다. 장점과 한계를 비교해 주십시오.'
];
test('multi-sentence polite prompts are classified and locked by one shared rule',()=>{
 const source=prompts.map((q,i)=>q+'\n= 저는 주어진 자료를 확인하고 동료들과 대안을 비교했습니다. '+body).join('\n\n');
 const p=dp.detectDocumentProfile(source);
 assert.ok(p.formatProfile.flags.includes('questionnaire'));
 const plan=sc.splitChunksForGpt(source,{formatProfile:p.formatProfile,coalesceEditable:true});
 const locked=plan.chunks.filter(c=>c.locked&&c.lockType==='questionnaire_question');
 assert.equal(locked.length,3);
 for(const q of prompts) assert.ok(locked.some(c=>c.text===q),q);
 assert.ok(plan.chunks.some(c=>!c.locked&&c.text.includes('저는')));
 const damaged=source.replace(prompts[2],'3.');
 assert.equal(sc.buildStructureAudit({source,outputText:damaged,chunks:plan.chunks,plan}).pass,false);
});
test('narrative references to questions do not become protected questionnaire prompts',()=>{
 for(const line of ['학생에게 설명해 주세요라고 부탁했다.','담당자는 결과를 작성했습니다.','1. 자료를 정리하고 결과를 비교했다.']){
  assert.equal(ls.isQuestionPromptLine(line),false,line);
 }
});
test('code, quotes and explicit headings remain untouched by forced wrap recovery',()=>{
 for(const source of ['# 연구의 의의\n'+body,'「연구의 의의」\n'+body,'```text\n연구의 의의\n'+body+'\n```']){
  assert.equal(sp.repairForcedProseWraps(source).text,source);
 }
});
test('a lecture about resumes is classified by retrospective purpose, not career keywords',()=>{
 const reflection='이번 특강에서 채용 담당자의 강의를 들었다. 강의에서는 자기소개서를 쓰는 방법과 직무 역량을 설명했다. 특강을 통해 면접에서 근거를 말해야 하는 이유를 배웠다. 강의를 듣고 지원 동기와 실제 경험의 관계를 생각해 볼 수 있었다. 특강에서는 경험을 과장하지 말라고 강조했다. 강의를 통해 취업 준비의 방향을 이해할 수 있었다.';
 const p=dp.detectDocumentProfile(reflection);
 assert.equal(p.signals.attendedLectureReflection,true);
 assert.notEqual(p.profile,'resume_application');
 const application=reflection+' 귀사에 지원했습니다. 저의 강점은 문제를 분석하는 역량입니다. 입사 후에는 맡은 업무에 기여하겠습니다.';
 assert.equal(dp.detectDocumentProfile(application).signals.attendedLectureReflection,false);
});
