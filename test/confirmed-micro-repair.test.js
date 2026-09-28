'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {groundViolation}=require('../engine-gpt-prod/judge');
const {confirmedMicroRepair:micro}=require('../engine-gpt-prod/confirmedMicroRepair');
const {restoreConfirmedRelations:restore}=require('../engine-gpt-prod/confirmedRelationRestore');
const {auditRelationCandidates:audit}=require('../engine-gpt-prod/relationAudit');
const finding=(a,b,type='distortion',span=b)=>groundViolation({type,sourceSpan:a,candidateSpan:b,span,
  origin:'introduced',relation:'modality_negation_causality'},a,b);
const tail=' 별도의 기록은 자료실에 보관한다. 담당자는 내일 측정 장비를 점검할 예정이다.'.repeat(12);

test('confirmed intensity removes only introduced adverb, preserving the rewrite',()=>{
  const a='우리가 함께 새로운 측정 기구를 설계하는 과정은 흥미로웠다.';
  const b='새로운 측정 기구를 함께 설계하는 과정이 무척 흥미로웠다.';
  const f=finding(a,b,'intensity_amplification','무척 흥미로웠다');
  assert.equal(micro(a,b,f),b.replace('무척 ',''));
  const out=restore(a+tail,b+tail,{pass:false,violations:[f]});
  assert.equal(out.text,b.replace('무척 ','')+tail);assert.equal(out.restoredCount,1);
  assert.ok(audit(a,b).codes.includes('claim_strength_candidate'));
});

test('embedded ability is restored as an operator, not a whole sentence reset',()=>{
  const a='연구실은 참여자가 여러 실험을 자유롭게 시도할 수 있는 환경이었다.';
  const b='그 연구실은 참여자들이 여러 실험을 자유롭게 시도하는 환경이었다.';
  assert.equal(micro(a,b,finding(a,b)),b.replace('시도하는','시도할 수 있는'));
  assert.ok(audit(a,b).codes.includes('certainty_scope_candidate'));
});

test('four-sentence confirmed connective movement restores ownership and keeps paragraph breaks',()=>{
  const a='기초 이론을 익히는 일은 중요하다. 시험 점수만으로 배움의 의미를 평가할 수는 없다. 매일 꾸준히 관찰하고 기록하는 과정에서도 얻을 수 있는 것이 있다. 다만 적성을 발견하는 데에는 이와 다른 경험도 필요하다.';
  const b='기초 이론을 익히는 것은 중요하다.\n\n다만 시험 점수만으로 배움의 의미를 평가할 수는 없다. 매일 꾸준히 관찰하고 기록하는 과정에서도 배울 점이 있다. 적성을 발견하는 데에는 이와 다른 경험도 필요하다.';
  const expected=b.replace('다만 시험','시험').replace('적성을','다만 적성을');
  assert.equal(micro(a,b,finding(a,b)),expected);
  const out=restore(a+tail,b+tail,{pass:false,violations:[finding(a,b)]});
  assert.equal(out.text,expected+tail);assert.equal(out.restoredCount,1);
  assert.ok(audit(a,b).codes.includes('connective_ownership_candidate'));
});

test('heuristics, source issues, unlocated findings, multiple operators and quotes do not authorize micro repair',()=>{
  const a='함께 수행한 실험은 흥미로웠다.',b='함께 수행한 실험은 무척 흥미로웠다.';
  const f=finding(a,b,'intensity_amplification');
  for(const x of [{...f,origin:'source_issue'},{...f,spanVerified:false},{...f,repairable:false},{...f,relationGrounded:false}])
    assert.equal(micro(a,b,x),'');
  assert.equal(micro('무척 재미있었다. '+a,b,f),'');
  const quoted='그는 “무척 흥미로웠다.”라고 말했다.';
  assert.equal(micro(a,quoted,finding(a,quoted,'intensity_amplification')),'');
  const multiple='무척 흥미로웠고 매우 만족스러웠다.';
  assert.equal(micro(a,multiple,finding(a,multiple,'intensity_amplification')),'');
});

test('split/merged or ambiguous discourse windows require a model patch rather than guessed connector movement',()=>{
  const a='측정값은 일정했다. 다만 변화를 확인하려면 반복 실험이 필요하다.';
  const b='다만 측정값은 일정했고 변화를 확인하려면 반복 실험이 필요하다.';
  assert.equal(micro(a,b,finding(a,b)),'');
  assert.equal(micro(a,a,finding(a,a)),'');
});

test('confirmed purpose is not actual execution; preserve other wording and require fresh audit',()=>{
 const a='이 교육은 장비를 안전하게 조작하기 위한 과정이기도 하다.';
 const b='해당 교육은 장비를 안전하게 조작하는 과정이기도 하다.';
 assert.equal(micro(a,b,finding(a,b)),b.replace('조작하는 과정','조작하기 위한 과정'));
 assert.ok(audit(a,b).codes.includes('purpose_action_candidate'));
 assert.equal(micro(a,b,{...finding(a,b),origin:'unconfirmed'}),'');
});

test('same-owner connective synonyms and simple omissions do not nominate ownership movement',()=>{
 const a='측정 장비는 잘 작동했다. 그러나 자료를 분석하기에는 표본이 부족했다.';
 for(const b of ['측정 장비는 잘 작동했다. 하지만 자료를 분석하기에는 표본이 부족했다.',
   '측정 장비는 잘 작동했다. 자료를 분석하기에는 표본이 부족했다.'])
  assert.equal(audit(a,b).codes.includes('connective_ownership_candidate'),false);
 assert.equal(audit(a,a.replace('그러나','따라서')).codes.includes('connective_ownership_candidate'),true);
});
