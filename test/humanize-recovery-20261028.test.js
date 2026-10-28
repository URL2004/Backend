'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreConfirmedRelations}=require('../engine-gpt-prod/confirmedRelationRestore');
const {groundViolation}=require('../engine-gpt-prod/judge');
const fingerprint=require('../engine-gpt-prod/fingerprintAudit');
const tail='완성된 모형은 보관함에 넣는다. 관찰 기록은 별도 파일로 저장한다. 다음 시간에는 모형의 하중을 측정한다. 담당자는 모든 측정 장비를 확인한다. 참여자는 결과를 작성한다. 자료의 마지막 페이지에는 참고 도면을 첨부한다.';
const finding=(source,output,a,b)=>({pass:false,verificationCompleted:true,violations:[
  groundViolation({type:'distortion',origin:'introduced',relation:'actor_action_target',
    sourceSpan:a,candidateSpan:b,span:b},source,output)]});
for(const prefix of ['- 넷째, ','3. ','③ '])test(`confirmed complete list item restores target/instrument relation: ${prefix}`,()=>{
  const a=prefix+'나사 등의 연결 부품을 조립한다. 결합부가 단단한지도 살핀다.';
  const b=prefix+'나사 등으로 연결 부품을 조립한 뒤 결합부가 단단한지도 살핀다.';
  const source=a+'\n\n'+tail,output=b+'\n\n'+tail;
  const restored=restoreConfirmedRelations(source,output,finding(source,output,a,b));
  assert.equal(restored.text,source);assert.equal(restored.restoredCount,1);
  assert.equal(restored.restorationBudget.added,a.length);
});
test('list restoration refuses changed markers/ordinals, cross-item and ambiguous ownership',()=>{
  const a='- 셋째, 연결 부품을 조립한다. 결합부가 단단한지도 살핀다.';
  for(const b of ['* 셋째, 연결 부품으로 조립한다. 결합부가 단단한지도 살핀다.',
    '- 넷째, 연결 부품으로 조립한다. 결합부가 단단한지도 살핀다.',
    '- 셋째, 연결 부품으로 조립한다.\n- 넷째, 결합부가 단단한지도 살핀다.']){
    const source=a+'\n\n'+tail,output=b+'\n\n'+tail;
    assert.equal(restoreConfirmedRelations(source,output,finding(source,output,a,b)).applied,false);
  }
  const b=a.replace('부품을','부품으로'),source=a+'\n'+a+'\n'+tail,output=b+'\n'+tail;
  assert.equal(restoreConfirmedRelations(source,output,finding(source,output,a,b)).applied,false);
});

const intro='이번 실습에서는 수납장이 부족할 수 있다는 점을 문제로 삼고, 이를 보완하기 위한 이동형 보관함을 구상했다.';
const lesson='이 과정에서 작업 공간의 작은 불편도 이용자의 상황을 구체적으로 살펴보면 제품 설계의 출발점이 될 수 있다는 점을 확인할 수 있었다.';
const rewritten='이용자의 상황을 구체적으로 살피는 과정에서 작업 공간의 작은 불편도 제품 설계의 출발점이 될 수 있음을 확인했다.';
test('attested adjacent purpose cannot become a new purpose on the neighbouring sentence',()=>{
  const source='Ⅳ. 실습 결론\n'+intro+'\n'+lesson;
  const output='Ⅳ. 실습 결론\n\n'+intro+'\n\n'+rewritten;
  const audit=fingerprint.auditFingerprint(source,output,'report_assignment');
  assert(!audit.semanticRelations.shifts.some(s=>s.family==='neutral_link_hardened_to_remediation'));
});
test('an actual new purpose remains detected beside an attested purpose',()=>{
  const source=intro+'\n'+lesson;
  const output=intro+'\n'+'이 문제를 보완하기 위해 이용자의 상황을 구체적으로 살피며 작업 공간의 작은 불편도 제품 설계의 출발점이 될 수 있음을 확인했다.';
  assert(fingerprint.auditFingerprint(source,output,'report_assignment').semanticRelations.shifts
    .some(s=>s.family==='neutral_link_hardened_to_remediation'));
});
