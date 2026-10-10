'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {countOrphanParticleLineBoundaries:count}=require('../engine-gpt-prod/structureChunk');
test('one-syllable demonstrative nouns keep their own particle after a heading',()=>{
 for(const body of ['이 책의 내용을 정리했다.','이 집의 구조를 분석했다.','이 표를 살펴보았다.','이 글은 실험 결과를 설명한다.']) assert.equal(count('연구 결과\n\n'+body),0,body);
});
test('detached particles, bare predicates and non-heading boundaries remain errors',()=>{
 for(const text of ['실험 조건\n\n이 바뀌었다.','실험 조건\n이 바뀌었다.','학생\n\n이 새로운 책을 읽었다.','연구 결과\n\n를 확인했다.']) assert.equal(count(text),1,text);
});

