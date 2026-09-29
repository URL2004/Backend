'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../engine-gpt-prod/semanticOperatorReview');
const pairs = [
  ['담당자는 여름 동안 새로운 장비의 작동 원리를 연구했다.', '담당자는 여름 동안 새로운 장비의 작동 원리를 연구만 했다.', 'action_exclusivity_candidate'],
  ['연구자는 여러 자료를 읽다 보니 새로운 질문이 떠올랐다.', '연구자는 여러 자료를 읽다 보면 새로운 질문이 떠오른다.', 'experienced_conditional_candidate'],
  ['참여자는 새로운 환경에 적응하기 위해 기술을 배워가고 싶다.', '참여자는 새로운 환경에 적응하며 기술을 배워가고 싶다.', 'purpose_simultaneity_candidate']
];
for (const [source,output,code] of pairs) {
  test(code+' requires an explicit contextual answer, not an automatic finding', () => {
    const t = review.targets(source,output).find(t=>t.codes.includes(code));
    assert.ok(t);
    assert.equal(review.assess([t],[],[],source,output).pending[0].repairable,false);
    assert.equal(review.assess([t],[{...t,status:'changed',detail:'A separate grounded finding must accompany the changed answer.'}],[],source,output).pending.length,1);
    assert.equal(review.assess([t],[{...t,status:'preserved',detail:'The surrounding context preserves the same event relationship.'}],[],source,output).pending.length,0);
  });
  test(code+' excludes quoted/code and ambiguous duplicate ownership', () => {
    for (const wrap of [s=>'“'+s+'”',s=>'`'+s+'`',s=>'```\n'+s+'\n```'])
      assert.equal(review.targets(wrap(source),wrap(output)).some(t=>t.codes.includes(code)),false);
    assert.equal(review.targets(source+' '+source,output).some(t=>t.codes.includes(code)),false);
  });
}
test('equivalent relation preservation and unrelated predicates are not nominated', () => {
  const cases = [
    [pairs[0][0],pairs[0][0].replace('연구했다','연구를 했다')],
    [pairs[0][1],pairs[0][1]],
    [pairs[1][0],pairs[1][0].replace('읽다 보니','읽다보니')],
    [pairs[2][0],pairs[2][0].replace('위해','위하여')],
    [pairs[2][0],pairs[2][0].replace('위해','위해서')],
    [pairs[2][0],pairs[2][0].replace('적응하기 위해','생활하며')]
  ];
  const codes=new Set(pairs.map(p=>p[2]));
  for(const [a,b] of cases) assert.equal(review.targets(a,b).some(t=>t.codes.some(c=>codes.has(c))),false);
});
test('normal rewrites remain allowed by shared generation instruction',()=>{
  const text=require('../engine-gpt-prod/humanizeContract').meaningPreservationLines().join('\n');
  assert.ok(text.includes(require('../engine-gpt-prod/eventRelationOperators').preservation));
  assert.ok(review.instruction.includes(require('../engine-gpt-prod/eventRelationOperators').instruction));
});
