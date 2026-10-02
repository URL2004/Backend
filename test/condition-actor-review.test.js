'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const review=require('../engine-gpt-prod/semanticOperatorReview');
const pairs=[
 ['자료를 확보해야 연구자는 가설을 검토할 수 있다.','자료를 확보하면 연구자는 가설을 검토할 수 있다.','necessity_condition_candidate'],
 ['장비가 연결되어야 작업자는 측정을 시작할 수 있다.','장비가 연결되면 작업자는 측정을 시작할 수 있다.','necessity_condition_candidate'],
 ['과거 위원회 시기에 자료를 수집한 사례가 있었다.','과거 위원회가 자료를 수집한 사례가 있었다.','temporal_actor_candidate']
];
test('same-owner condition and time-frame changes are explicitly reviewed, not auto-verdicts',()=>{
 for(const[a,b,code]of pairs){
  const target=review.targets(a,b).find(t=>t.codes.includes(code));assert.ok(target,code);
  assert.equal(review.assess([target],[],[],a,b).pending.length,1);
  assert.equal(review.assess([target],[{...target,status:'preserved',detail:'같은 문맥에 동일한 조건과 주체가 명시되어 있다.'}],[],a,b).pending.length,0);
  assert.equal(review.assess([target],[{...target,status:'changed',detail:'조건 관계가 바뀌었지만 별도 근거 판정이 필요하다.'}],[],a,b).pending.length,1);
  assert.equal(review.targets(a,a).some(t=>t.codes.includes(code)),false);
  for(const wrap of [s=>'“'+s+'”',s=>'`'+s+'`'])assert.equal(review.targets(wrap(a),wrap(b)).some(t=>t.codes.includes(code)),false);
 }
 assert.equal(review.targets(pairs[0][0],pairs[0][1].replace('확보하면','삭제하면')).some(t=>t.codes.includes(pairs[0][2])),false);
 assert.equal(review.targets(pairs[2][0],pairs[2][1].replace('위원회가','연구자가')).some(t=>t.codes.includes(pairs[2][2])),false);
});
test('necessity nomination works in both directions without treating ordinary conditions as errors',()=>{
 const[a,b,code]=pairs[1];assert.ok(review.targets(b,a).some(t=>t.codes.includes(code)));
 assert.equal(review.targets('재료를 확인하면 실험을 시작할 수 있다.','재료를 확인하면 바로 실험을 시작할 수 있다.').some(t=>t.codes.includes(code)),false);
});
