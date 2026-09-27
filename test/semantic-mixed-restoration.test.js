'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { restoreConfirmedRelations } = require('../engine-gpt-prod/confirmedRelationRestore');
const a = '설비의 가동 결과는 현장의 조건에 따라 달라질 수 있다.';
const b = '설비의 가동 결과는 현장의 조건에 따라 달라진다.';
const tail = '담당자는 점검 항목을 기록했다. 자료는 다음 조사에 활용했다. 별도의 기록은 유지했다. 연구팀은 시설의 이용 현황을 따로 집계했다. 분석 결과는 다음 달 회의에서 공유했다. 조사는 정해진 일정에 따라 진행했다.';
const source = `${a} ${tail}`, output = `${b} ${tail}`;
const finding = () => groundViolation({type:'distortion', span:b, sourceSpan:a, candidateSpan:b,
  relation:'modality_negation_causality', origin:'introduced', detail:'가능성을 단정으로 변경했다.'}, source, output);

test('a mixed uncertain report may propose only its individually grounded error for fresh verification', () => {
  const unresolved = { type:'omission', origin:'unconfirmed', span:'확인 불가', repairable:false, relationGrounded:false };
  const report = { pass:false, uncertain:true, verificationCompleted:true, violations:[unresolved, finding()] };
  const snapshot = JSON.stringify(report);
  const restored = restoreConfirmedRelations(source, output, report);
  assert.equal(restored.applied, true);
  assert.equal(restored.restoredCount, 1);
  assert.equal(restored.text, source);
  assert.equal(JSON.stringify(report), snapshot); // never certify or clear uncertainty
});

test('incomplete, ungrounded, source-owned and ambiguous findings cannot use mixed-report restoration', () => {
  assert.equal(restoreConfirmedRelations(source,output,{pass:false,uncertain:true,verificationCompleted:false,violations:[finding()]}).applied,false);
  for (const change of [{origin:'source_issue'}, {relationGrounded:false}, {repairable:false}, {candidateSpan:'실제 문서에는 없는 잘못된 대응 문장이다.'}]) {
    assert.equal(restoreConfirmedRelations(source,output,{pass:false,uncertain:true,violations:[{...finding(),...change}]}).applied,false);
  }
});

test('confirmed new awkwardness uses exact original context, never generated corrections', () => {
  const original = '나는 담당 연구자로서 기록에 적힌 내용을 꼼꼼히 확인했다.';
  const candidate = '나는 담당 연구자로서로서 기록에 적힌 내용을 꼼꼼히 확인했다.';
  const s = `${original} ${tail}`, c = `${candidate} ${tail}`;
  const v = groundViolation({type:'distortion',span:candidate,sourceSpan:original,candidateSpan:candidate,
    relation:'genre_naturalness',origin:'introduced',detail:'조사를 새로 중복했다.'},s,c);
  assert.equal(restoreConfirmedRelations(s,c,{pass:false,violations:[v]}).text,s);
});
