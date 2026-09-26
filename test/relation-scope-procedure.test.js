'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreRelationScopes } = require('../engine-gpt-prod/relationScopeRestore');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const layout = require('../engine-gpt-prod/layoutStructure');

test('restore only attested comparison and concession frames, preserving rewritten words', () => {
  const a = '성장은 특별한 행동보다 반복되는 연습을 통해 이루어진다. 기술이 있어도 낯선 환경에서는 어려움을 겪는다.';
  const b = '성장은 특별한 행동이 아니라 반복되는 연습을 통해 이루어진다. 기술만으로는 낯선 환경에서는 어려움을 겪는다.';
  const r = restoreRelationScopes(a,b);
  assert.equal(r.text,a); assert.equal(r.restoredCount,2);
  assert.equal(restoreRelationScopes(a,r.text).applied,false);
});

test('do not restore unrelated, ambiguous, quoted or legitimately excluded relations', () => {
  for (const [a,b] of [
    ['무엇보다 반복이 중요하다.', '무엇이 아니라 반복이 중요하다.'],
    ['교육보다 훈련이 중요하다.', '교육이 아니라 훈련이 중요하다. 교육이 아니라 훈련이 중요하다.'],
    ['교육보다 훈련이 중요하다.', '그는 “교육이 아니라 훈련이 중요하다.”라고 말했다.'],
    ['“교육보다 훈련이 중요하다.”라고 말했다.', '교육이 아니라 훈련이 중요하다.'],
    ['교육보다 훈련이 중요하다. 교육이 아니라 훈련이 필요한 곳도 있다.', '교육이 아니라 훈련이 필요한 곳도 있다.'],
    ['교육보다 훈련이 중요하다.', '교육이 아니라 부동산 매매와 세금에 관해 토론하고 싶다.']
  ]) assert.equal(restoreRelationScopes(a,b).applied,false, b);
});

test('nominate preparation/performance inversion even when every sentence survives', () => {
  const a = '장비를 점검한 뒤 연결 상태를 확인했다. 신중하게 기계를 작동시도한 결과 한 번에 가동했다.';
  const b = '신중하게 기계를 작동시도한 결과 한 번에 가동했다. 장비를 점검한 뒤 연결 상태를 확인했다.';
  assert.ok(auditRelationCandidates(a,b).codes.includes('procedure_order_candidate'));
  assert.ok(!auditRelationCandidates(a,a).codes.includes('procedure_order_candidate'));
  assert.ok(!auditRelationCandidates(a,b.replace('장비를','앞서 장비를')).codes.includes('procedure_order_candidate'));
  assert.ok(auditRelationCandidates('기술이 있어도 낯선 환경에서는 어려움을 겪는다.',
    '기술만으로는 낯선 환경에서는 어려움을 겪는다.').codes.includes('concession_scope_candidate'));
});

test('explicit form consent rows are protected but the following essay stays editable', () => {
  const lines = ['참가신청서', '이름\t가상인', '상기 본인은 공모전 응모작의',
    '개인정보 수집과 정보 활용에 동의합니다.', '■동의 □동의하지 않음', '',
    '2. 체험 수기', '실습에서는 준비 절차와 확인의 중요성을 배웠다.'];
  const rows = layout.buildLineRecords(lines.join('\n'));
  assert.equal(rows[2].role,'signature'); assert.equal(rows[3].role,'signature');
  assert.equal(rows[7].role,'prose');
  assert.notEqual(layout.buildLineRecords('본인은 개인정보 보호에 관심이 많다.')[0].role,'signature');
});

test('procedure alignment covers a preparation sentence split into two rewritten sentences', () => {
  const a = '작은 실수가 결과에 영향을 줄 수 있다는 생각에 긴장했지만, 마음을 가다듬고 필요한 물품을 확인한 뒤 장비 상태를 천천히 살폈다. 신중하게 장비를 작동시킨 결과 한 번에 가동했다.';
  const b = '신중하게 장비를 작동시킨 결과 한 번에 가동했다. 작은 실수가 결과에 영향을 줄 수 있다고 생각하니 긴장되었다. 마음을 가다듬은 뒤 필요한 물품을 확인하고 장비 상태를 천천히 살폈다.';
  assert.ok(auditRelationCandidates(a,b).codes.includes('procedure_order_candidate'));
  const repaired = '작은 실수가 결과에 영향을 줄 수 있다고 생각하니 긴장되었다. 마음을 가다듬은 뒤 필요한 물품을 확인하고 장비 상태를 천천히 살폈다. 신중하게 장비를 작동시킨 결과 한 번에 가동했다.';
  assert.ok(!auditRelationCandidates(a,repaired).codes.includes('procedure_order_candidate'));
});

test('a split source clause retains its comparative scope without undoing the rewrite', () => {
  const a='다양한 활동에 참여한다는 점에서, 성장은 특별한 한 번의 행동보다 반복되는 행동을 통해 만들어진다.';
  const b='성장은 특별한 한 번의 행동이 아니라 이런 반복적인 실천을 통해 형성된다.';
  assert.equal(restoreRelationScopes(a,b).text,'성장은 특별한 한 번의 행동보다 이런 반복적인 실천을 통해 형성된다.');
});
