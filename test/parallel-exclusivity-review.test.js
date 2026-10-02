'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const review = require('../engine-gpt-prod/semanticOperatorReview');
const pairs = [
  ['연구자만이 이 현상을 구별할 수 있다.', '연구자는 이 현상을 구별할 수 있다.', 'subject_exclusivity_candidate'],
  ['학교의 자율적인 대응과 필요한 경우 공적 지원을 함께 활용해야 한다.', '학교의 자율적인 대응에 필요한 공적 지원도 함께 활용해야 한다.', 'parallel_dependency_candidate'],
  ['정비가 쉽고 내구성이 좋으며 즉시 사용할 수 있다.', '정비가 간편하고 내구성도 좋아 즉시 사용할 수 있다.', 'coordination_causal_candidate'],
  ['비용이 적으며 누구나 신청할 수 있다.', '비용이 적어 누구나 신청할 수 있다.', 'coordination_causal_candidate']
];
const codes = (a,b) => auditRelationCandidates(a,b,{includeAllCandidates:true}).codes;
test('anchored scope and coordination changes enter explicit contextual review', () => {
  for (const [a,b,code] of pairs) {
    assert.ok(codes(a,b).includes(code),code);
    const target=review.targets(a,b).find(t=>t.codes.includes(code));
    assert.ok(target,code);
    assert.equal(review.assess([target],[],[],a,b).pending.length,1);
    assert.equal(review.assess([target],[{...target,status:'preserved',detail:'The surrounding context preserves the same relationship.'}],[],a,b).pending.length,0);
    assert.equal(review.assess([target],[{...target,status:'changed',detail:'A changed relationship needs its own grounded finding.'}],[],a,b).pending.length,1);
  }
});
test('unchanged forms, different owners and protected operators abstain', () => {
  for (const [a,b,code] of pairs) {
    assert.equal(codes(a,a).includes(code),false);
    for (const wrap of [s=>'“'+s+'”',s=>'`'+s+'`']) assert.equal(codes(wrap(a),wrap(b)).includes(code),false);
  }
  assert.equal(codes(pairs[0][0],pairs[0][1].replace('연구자는','참가자는')).includes(pairs[0][2]),false);
  assert.equal(codes(pairs[1][0],pairs[1][1].replace('대응에','교육에')).includes(pairs[1][2]),false);
  assert.ok(codes(pairs[0][1],pairs[0][0]).includes(pairs[0][2]));
});
