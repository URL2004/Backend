'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {detectSemanticRelationShifts:audit}=require('../engine-gpt-prod/fingerprintAudit');
const intro=['자료를 수집했다','표본을 분류했다','온도를 확인했다','온도가 상승하면 용매 손실 속도가 증가한다','실험실을 청소했다','장비를 점검했다','용액을 혼합했다','결과를 기록했다','시간을 측정했다'];
const claim='온도가 상승하면서 용매 손실 속도가 증가했기 때문으로 해석할 수 있다.';
const tail=['후속 실험에서는 다른 측정 장비를 사용했다.','연구의 제한점은 표본 규모가 작다는 것이다.','자료의 출처는 부록에 제시했다.'];
const source=[intro.join(', ')+'.',claim,...tail].join(' ');
test('sentence expansion does not turn a retained possibility into a false certainty warning',()=>{
  const output=[...intro.map(s=>s+'.'),claim,...tail].join(' ');
  assert.equal(audit(source,output).shifts.some(x=>x.family==='possibility_hardened_to_certainty'),false);
});
test('a genuine change to certainty remains visible after alignment refinement',()=>{
  const output=[...intro.map(s=>s+'.'),'온도가 상승하면서 용매 손실 속도가 증가했기 때문이다.',...tail].join(' ');
  assert.equal(audit(source,output).shifts.some(x=>x.family==='possibility_hardened_to_certainty'),true);
});
