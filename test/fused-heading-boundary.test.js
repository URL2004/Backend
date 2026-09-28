'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const preflight=require('../engine-gpt-prod/sourcePreflight');
const bare=s=>s.replace(/\s/gu,'');

test('compound heading suffix remains with the heading before a fused label',()=>{
 const source='4. 운영 시 유의사항 및 한계점장시간 사용 시 점검 절차: 장비를 오래 사용하면 부품이 느슨해질 수 있으므로 정해진 절차에 따라 계속 확인해야 한다.';
 const result=preflight.auditAndSanitizeSource(source);
 assert.match(result.text,/한계점\n장시간/u);
 assert.doesNotMatch(result.text,/한계\s+점/u);
 assert.equal(bare(result.text),bare(source));
 assert.equal(preflight.auditAndSanitizeSource(result.text).text,result.text);
});

test('heading nouns inside ordinary numbered prose cannot cut compounds',()=>{
 for(const word of ['한계점','영향력','결과적으로','구조물','가능성']) {
  const source=`2. 현장의 ${word} 때문에 여러 상황을 검토하면서 관련 자료를 수집했다. 이를 토대로 다음 계획을 구체적으로 마련했다.`;
  const result=preflight.repairInlineHeadingBoundaries(source);
  assert.equal(result.text,source,word);
 }
});

test('collapsed labels are not swallowed as one inferred section title',()=>{
 const source='5. 운영 문제점 및 대안분석 항목지역 특수성 및 현장의 문제점실질적 보완책기상 및 접근성갑작스러운 강풍으로 장비 가동이 중단되어 많은 시간이 소요됨. 대응 방안을 추가로 점검하였다.';
 const result=preflight.repairInlineHeadingBoundaries(source);
 assert.equal(result.text,source);
});

test('unambiguous numbered heading and prose continue to split',()=>{
 const source='3. 지역 운영 특성새로운 장비는 주변 환경에 따라 작동 조건이 달라지므로 사용자는 절차를 확인해야 한다.';
 const result=preflight.repairInlineHeadingBoundaries(source);
 assert.match(result.text,/특성\n새로운/u);
 assert.equal(bare(result.text),bare(source));
});

test('council counterexamples: assessment compound and inspection tail are not prose',()=>{
 for(const source of [
  '5. 영향평가 기준을 적용한 뒤 관련 자료를 살피며 이번 조사의 결과를 여러 관점에서 충분히 비교하였다.',
  '4. 시스템 한계점검 절차: 장비를 오래 사용하면 부품이 느슨해질 수 있으므로 정해진 순서에 따라 계속 확인해야 한다.'
 ])assert.equal(preflight.repairInlineHeadingBoundaries(source).text,source);
});
