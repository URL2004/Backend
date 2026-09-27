'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreConfirmedRelations: restore } = require('../engine-gpt-prod/confirmedRelationRestore');
const { hasAdjacentRelationCoverage } = require('../engine-gpt-prod/relationAudit');
const a = '참가자들은 관찰표나 실험 기록을 참고해 특징을 정리하면서, 이 과정에서 서로의 판단 방식과 참여 목표를 충분히 이해할 수 있었다.';
const b = '참가자들은 관찰표와 실험 기록을 참고해 특징을 정리했다.';
const continuation = '이 과정에서 서로의 판단 방식과 참여 목표를 충분히 이해할 수 있었다.';
const tail = Array.from({length:8},(_,i)=>`별도 항목 ${i+1}에서는 실험 도구를 점검하고 측정 결과를 보관했다.`).join(' ');
const source = a+' '+tail, output = b+' '+continuation+' '+tail;
const v = {type:'distortion',origin:'introduced',relation:'modality_negation_causality',
  sourceSpan:a,candidateSpan:b,span:'관찰표와 실험 기록을 참고해',spanVerified:true,
  relationGrounded:true,repairable:true,grounding:'unique_exact_span'};
const report = finding => ({pass:false,uncertain:false,verificationCompleted:true,violations:[finding]});
test('confirmed connective restores locally without duplicating an adjacent split continuation',()=>{
  assert.equal(hasAdjacentRelationCoverage(a,b,output),true);
  const r=restore(source,output,report(v));
  assert.equal(r.restoredCount,1);
  assert.equal(r.text,output.replace('관찰표와 실험 기록','관찰표나 실험 기록'));
  assert.equal(r.text.split(continuation).length-1,1);
});
test('a hint, ambiguous occurrence, quotation or unrelated finding cannot authorize connective restoration',()=>{
  for(const change of [{origin:'unconfirmed'},{relationGrounded:false},{spanVerified:false},
    {span:'참가자들은'},{relation:'actor_action_target'},{repairable:false}])
    assert.equal(restore(source,output,report({...v,...change})).applied,false);
  assert.equal(restore(source,output,null).applied,false);
  assert.equal(restore(source,output+' '+b,report(v)).applied,false);
  const qa='“관찰표나 실험 기록을 참고한다.”',qb='“관찰표와 실험 기록을 참고한다.”';
  assert.equal(restore(qa+' '+tail,qb+' '+tail,report({...v,sourceSpan:qa,candidateSpan:qb,span:'관찰표와 실험 기록을 참고한다'})).applied,false);
});
