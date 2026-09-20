'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');
const { auditNaturalnessRegression } = require('../engine-gpt-prod/naturalnessRegression');
const { buildHumanizationPromptBlock } = require('../engine-gpt-prod/humanizationDepth');
const profile = {profile:'resume_application'};
const pairs = [
  ['향후에는 교통 약자의 이동 문제를 깊이 탐구하고 싶습니다.',
    '향후에는 교통 약자의 이동 문제를 깊이 탐구하는 일을 이어가고 싶습니다.', 'introduced_action_nominalization'],
  ['첫 학기에는 자료 분석의 기초 개념부터 탄탄히 익히겠습니다.',
    '첫 학기에는 자료 분석의 기초 개념을 익히는 일부터 탄탄히 시작하겠습니다.', 'introduced_action_nominalization'],
  ['이 지원이 단기 행사로 끝나지 않도록 지역 교육에서 활용할 수 있는 체계로 발전시키고 싶습니다.',
    '단기 행사에 그치지 않게 하려면, 이 지원을 지역 교육에서 활용할 수 있는 체계로 발전시키고 싶습니다.', 'introduced_condition_wish_mismatch'],
  ['참여자의 신체 특성을 고려해, 이동 활동을 활용하는 교육 방법도 함께 검토하고 싶습니다.',
    '이동 활동을 활용하는 교육 방법도, 참여자의 신체 특성을 고려해 함께 검토하고 싶습니다.', 'introduced_modifier_dislocation']
];

for (const [source, outputText, code] of pairs) test(`source-relative regression: ${code} ${source.slice(0,4)}`,()=>{
  const audit=korean.analyzeKoreanRefinement({source,outputText,documentProfile:profile});
  assert.ok(audit.repairableCodes.includes(code));
  assert.ok(auditCandidateIntegrity({source,before:source,candidate:outputText,documentProfile:profile}).reasons.includes('korean_integrity_worsened'));
});

test('local action repair retains another valid edit and is idempotent',()=>{
  const [source, bad]=pairs[0], outputText=bad.replace('향후에는','앞으로는');
  const audit=korean.analyzeKoreanRefinement({source,outputText});
  const fixed=korean.restoreIntroducedIntegritySentences({source,outputText,audit});
  assert.equal(fixed.text,source.replace('향후에는','앞으로는'));
  assert.equal(auditNaturalnessRegression(source,fixed.text).length,0);
});

test('multiple inflation variants remain separately counted',()=>{
  const source=pairs.slice(0,2).map(p=>p[0]).join(' '), outputText=pairs.slice(0,2).map(p=>p[1]).join(' ');
  const audit=korean.analyzeKoreanRefinement({source,outputText});
  assert.equal(audit.issues.find(i=>i.code==='introduced_action_nominalization').afterCount,2);
});

test('starting nominalization repairs its particle scope only with exact source evidence',()=>{
  const [source,bad]=pairs[1], outputText=bad.replace('첫 학기에는','첫 학기 동안에는');
  const audit=korean.analyzeKoreanRefinement({source,outputText});
  const fixed=korean.restoreIntroducedIntegritySentences({source,outputText,audit});
  assert.equal(fixed.text,source.replace('첫 학기에는','첫 학기 동안에는'));
  assert.equal(auditNaturalnessRegression(source,fixed.text).length,0);
});

test('real continuation, a new beginning, and original phrasing are not new errors',()=>{
  const [source,output]=pairs[0];
  assert.equal(auditNaturalnessRegression(source.replace('탐구하고','계속 탐구하고'),output).length,0);
  assert.equal(auditNaturalnessRegression(source.replace('탐구하고','탐구하는 일을 시작하고'),output).length,0);
  for (const p of pairs)assert.equal(auditNaturalnessRegression(p[1],p[1],'resume_application').length,0);
});

test('protected quote, inline code and multi-line code remain excluded',()=>{
  for(const wrap of [s=>'“'+s+'”',s=>'「'+s+'」',s=>'`'+s+'`',s=>'```\n'+s+'\n```']) {
    assert.equal(auditNaturalnessRegression(wrap(pairs[0][0]),wrap(pairs[0][1])).length,0);
  }
});

test('valid requirement statements and existing conditions are not a condition/wish mismatch',()=>{
  const valid='지원 체계를 발전시키려면 어떤 준비가 필요한지 알아보고 싶습니다.';
  assert.equal(auditNaturalnessRegression('지원 체계 발전에 필요한 준비를 알아보고 싶습니다.',valid).length,0);
  const valid2='참여자가 도움을 얻으려면 필요한 자료를 어디서 찾아야 하는지 설명하고 싶습니다.';
  assert.equal(auditNaturalnessRegression('참여자에게 필요한 자료를 찾는 방법을 설명하고 싶습니다.',valid2).length,0);
});

test('creative emphasis and ordinary word-order changes are not rejected',()=>{
  assert.equal(auditNaturalnessRegression(pairs[3][0],pairs[3][1],'creative').length,0);
  const output='이동 활동을 활용하는 교육 방법도 참여자의 신체 특성을 고려해 함께 검토하고 싶습니다.';
  assert.equal(auditNaturalnessRegression(pairs[3][0],output,'resume_application').length,0);
});

test('repeated source anchors do not authorize local repair',()=>{
  assert.equal(auditNaturalnessRegression(pairs[0][0]+' '+pairs[0][0],pairs[0][1]).length,0);
});

test('normal and targeted depth contracts make counts review targets, not forced changes',()=>{
  for(const targetSentenceCount of [0,4]) {
    const block=buildHumanizationPromptBlock({applicable:true,sourceSentenceCount:8,targetSentenceCount,
      requiredChangedSentenceCount:4,requiredTargetChangedCount:3,requiredStructuralChangedSentenceCount:2,
      targetIndices:[0,1,2,3],requestStrength:'advanced'});
    assert.match(block,/변경량보다 자연스러움/u);
    assert.match(block,/검토가 수정 의무는 아니다/u);
    assert.doesNotMatch(block,/위험 표현이 적더라도|분명히 달라져야/u);
  }
});
