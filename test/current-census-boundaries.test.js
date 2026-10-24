'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {groundViolation}=require('../engine-gpt-prod/judge');
const {bindSemanticValidation}=require('../engine-gpt-prod/semanticProvenance');
const {restoreConfirmedRelations}=require('../engine-gpt-prod/confirmedRelationRestore');
const {confirmedRelationDefects}=require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const korean=require('../engine-gpt-prod/koreanRefinement');
const preflight=require('../engine-gpt-prod/sourcePreflight');
const tail=Array.from({length:12},(_,i)=>`자료 ${i+1}번은 별도 보관함에 넣었으며 검토가 끝난 뒤 담당자에게 확인을 요청했다.`).join(' ');
function verdict(source,output,a,b,type='distortion',relation='actor_action_target'){
 const finding=groundViolation({type,relation,origin:'introduced',sourceSpan:a,candidateSpan:b,span:b},source,output);
 return bindSemanticValidation({ran:true,pass:false,verificationCompleted:true,violations:[finding]},source,output);
}
test('confirmed added actions get bounded restoration and cannot bypass the delivery gate',()=>{
 const a='실험실에서는 서로 다른 측정 방법에 관한 여러 의견이 존재했다.';
 const b='실험실에서는 서로 다른 측정 방법을 두고 연구원들이 격하게 대립했다.';
 const source=a+' '+tail,output=b+' '+tail,r=verdict(source,output,a,b,'added_claim');
 assert.equal(restoreConfirmedRelations(source,output,r).text,source);
 assert.equal(restoreConfirmedRelations(source,output,r).pass,undefined,'proposal still requires a fresh whole verdict');
 assert.equal(confirmedRelationDefects(source,output,r).length,1);
 for(const patch of [{uncertain:true},{verificationCompleted:false},{nominationOnly:true},{pass:true},
  {violations:[{...r.violations[0],origin:'source_existing'}]},
  {violations:[{...r.violations[0],spanVerified:false}]},
  {violations:[{...r.violations[0],relation:'other'}]}]){
  assert.equal(confirmedRelationDefects(source,output,{...r,...patch}).length,0);
 }
 assert.equal(confirmedRelationDefects(source,output+' 추가 문장이다.',r).length,0);
});
test('an unchanged inline label and uniquely anchored answer survive blank-line tokenization',()=>{
 const a='관찰 능력: 말로 의견을 표현하기 어려운 참여자의 몸짓을 살피는 관찰력을 갖추고 있습니다.';
 const b='관찰 능력: 참여자는 말로 의견을 표현하기 어려워서 몸짓을 살피는 관찰력을 갖추고 있습니다.';
 const anchor='2. 자신의 역량을 구체적인 근거와 함께 설명하시오.';
 const source='[답변]\n'+tail+'\n'+anchor+'\n[답변]\n'+a+' '+tail;
 const output='[답변]\n'+tail+'\n\n'+anchor+'\n\n[답변]\n\n'+b+' '+tail;
 const r=verdict(source,output,a,b,'distortion','genre_naturalness');
 assert.equal(restoreConfirmedRelations(source,output,r).text,output.replace(b,a));
 for(const changed of [output.replace(anchor,'3. 다른 활동에 대해서 구체적으로 설명하시오.'),output.replace('관찰 능력:','다른 역량:'),output+'\n'+anchor]){
  const changedB=changed.includes(b)?b:b.replace('관찰 능력:','다른 역량:');
  assert.equal(restoreConfirmedRelations(source,changed,verdict(source,changed,a,changedB,'distortion','genre_naturalness')).applied,false);
 }
});
test('right-hand quote openers stay unchanged across both repair stages and issue detection',()=>{
 for(const text of ['작가의 ’여름’입니다.','작가의 ”가을”입니다.','제목은 ’ 여름’입니다.','그는 “끝났다.”라고 말했다.','Let’s Grow라는 문구를 읽었다.']){
  const formatting=korean.applySafeFormattingRepairs({source:text,outputText:text}).text;
  assert.equal(formatting,text);
  const repaired=korean.applySafeDeterministicRepairs({source:text,outputText:formatting}).text;
  assert.equal(repaired,text);
  assert.equal(korean.detectTextIssues(text).some(x=>x.code==='closed_quote_spacing'),false);
 }
 const bad='작품은 ’여름’다음에 소개한다.';
 const repaired=korean.applySafeFormattingRepairs({source:bad,outputText:bad}).text;
 assert.equal(repaired,'작품은 ’여름’ 다음에 소개한다.');
 assert.equal(korean.applySafeFormattingRepairs({source:bad,outputText:repaired}).text,repaired);
});
test('balanced parenthetical PDF wrap remains a complete editable sentence',()=>{
 const a='현행 개선 대책. 담당자의 부담을 줄이기 위해 기록 분량을 축소(관찰 기록 및';
 const b='종합 기록 600자에서 400자로)하고, 새 안내서를 보급한다.';
 const input=a+'\n'+b;
 const result=preflight.repairForcedProseWraps(input);
 assert.equal(result.text,a+' '+b);
 assert.equal(result.text.replace(/\s/gu,''),input.replace(/\s/gu,''));
 assert.equal(preflight.repairForcedProseWraps(result.text).text,result.text);
 for(const text of [a+'\n\n'+b,a+'\n2. 별도 항목\n'+b,'```\n'+input+'\n```',a+'\n| 항목 | 설명 |']){
  assert.equal(preflight.repairForcedProseWraps(text).text,text);
 }
});
