'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreConfirmedRelations}=require('../engine-gpt-prod/confirmedRelationRestore');
const finding=(sourceSpan,candidateSpan,type='distortion')=>({type,sourceSpan,candidateSpan,
  span:candidateSpan,origin:'introduced',relation:'modality_negation_causality',
  spanVerified:true,repairable:true,relationGrounded:true,grounding:'unique_exact_span'});
const report=violations=>({pass:false,verificationCompleted:true,violations});
const prefix='수업 안내문을 읽고 재료와 도구를 마련했다. 준비한 작업은 모두 오후 실습 시간에 진행했다. ';
const tail=' 도예 수업에서도 재료를 다루는 방식이 내 성격과 잘 맞는지 고민했다. 다음 학기에는 조경 실습에 참여할 계획이다. '
  +'재료별 특성은 교재의 별도 표에 정리되어 있다. 담당자는 작업실 이용 규칙과 안전 지침을 자세히 설명했다. '
  +'첫날에는 도구를 하나씩 확인하고 보관 장소를 익혔다. 실습 기록에는 날짜와 장소 및 사용한 재료를 적었다. '
  +'완성한 작품은 수업이 끝난 뒤 보관함에 넣었다. 후속 모임에서는 각자 경험을 소개할 예정이다.';

test('an already nominated neighbour repair can ground a later low-overlap sentence without a second pass',()=>{
  const a='직접 실습하지 않았다면 제빵이 내게 맞는 분야라고 여전히 생각했을 것이다.';
  const b='실습할 기회가 없었다면 제빵이 나에게 어울리는 분야라고 계속 여겼을 것이다.';
  const c='내 예상과 다른 점을 알아보면서 다른 작업도 시도해보고 싶어졌다.';
  const d='예상 밖의 체험은 낯선 분야에 눈을 돌리게 했다.';
  const source=prefix+a+' '+c+tail,output=prefix+b+' '+d+tail;
  const result=restoreConfirmedRelations(source,output,report([finding(a,b),finding(c,d)]));
  assert.equal(result.restoredCount,2);
  assert.equal(result.text,source);
  assert.equal(Object.hasOwn(result,'pass'),false);
  assert.equal(restoreConfirmedRelations(source,output,report([finding(c,d)])).applied,false,
    'an unconfirmed bad neighbour cannot be used as an exact anchor');
});

test('new evaluation uses the same grounded local retrieval, not a blanket original reset',()=>{
  const a='당시에는 예상과 달랐던 실습도 지금 돌아보면 재료를 이해하는 데 필요한 경험이었다.';
  const b='당시에는 예상에 못 미쳤던 실습도 지금 돌아보면 재료를 이해하는 데 필요한 경험이었다.';
  const source=prefix+a+tail,output=prefix+b+tail;
  assert.equal(restoreConfirmedRelations(source,output,report([finding(a,b,'new_evaluation')])).text,source);
  for(const override of [{relationGrounded:false},{origin:'unconfirmed'},{repairable:false}])
    assert.equal(restoreConfirmedRelations(source,output,report([{...finding(a,b,'new_evaluation'),...override}])).applied,false);
  assert.equal(restoreConfirmedRelations(source,output+' '+b,report([finding(a,b,'new_evaluation')])).applied,false);
});

test('restoring an intensified predicate does not duplicate a lead already split into the previous sentence',()=>{
  const a='도구가 익숙해 잘 다룰 줄 알았는데, 실습하면서 어려울 수 있다는 걱정이 들었다.';
  const lead='도구가 익숙해서 잘 다룰 수 있을 것 같았다.';
  const b='하지만 실습하면서 어려울 수 있다는 걱정이 커졌다.';
  const source=prefix+a+tail,output=prefix+lead+'\n\n'+b+tail;
  const v=finding(a,b,'intensity_amplification');v.span='걱정이 커졌다';
  const result=restoreConfirmedRelations(source,output,report([v]));
  assert.equal(result.restoredCount,1);
  assert.equal(result.text,output.replace('걱정이 커졌다','걱정이 들었다'));
  assert.equal(result.text.split(lead).length,2);
  const micro=require('../engine-gpt-prod/confirmedMicroRepair').confirmedMicroRepair;
  assert.equal(micro(a,b,{...v,relationGrounded:false}),'');
  assert.equal(micro(a,'“걱정이 커졌다.”라고 말했다.',v),'');
});
