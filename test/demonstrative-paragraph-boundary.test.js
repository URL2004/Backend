'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {countOrphanParticleLineBoundaries:count}=require('../engine-gpt-prod/structureChunk');
test('demonstrative noun phrases after headings are not orphan particles',()=>{
  assert.equal(count('연구 결과\n\n이 분석을 바탕으로 새로운 방법을 제안한다.'),0);
  assert.equal(count('연구 방법\n\n이 자료는 실험을 통해 수집했다.'),0);
});
test('actual detached particles and unconfirmed prose boundaries still warn',()=>{
  assert.equal(count('실험 조건\n이 바뀌었다.'),1);
  assert.equal(count('연구 결과\n\n를 확인했다.'),1);
  assert.equal(count('학생\n\n이 새로운 책을 읽었다.'),1);
});
