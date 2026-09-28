'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {retainAttestedRestorationSpacing:repair}=require('../engine-gpt-prod/restorationSpacing');
test('restored meaning retains current uniquely attested word spacing only',()=>{
 const source='사회가 급변 하는 과정에서 자기효능 감을 회복해야 한다.';
 const current='사회가 급변하는 과정에서 자기효능감을 회복할 수도 있다.';
 assert.equal(repair(source,current),'사회가 급변하는 과정에서 자기효능감을 회복해야 한다.');
});
test('spacing restoration never guesses missing words, collapses lines, or rewrites literals',()=>{
 const samples=[
  ['급변 하는 사회이다.','빠르게 변하는 사회이다.'],
  ['자기효능\n감을 회복해야 한다.','자기효능감을 회복한다.'],
  ['자기효능\t감을 회복해야 한다.','자기효능감을 회복한다.'],
  ['“자기효능 감”이라는 인용을 사용했다.','“자기효능감”이라는 인용을 사용했다.'],
  ['`자기효능 감`을 출력한다.','자기효능감을 출력한다.'],
  ['자기효능 감을 설명했다.','자기효능감을 말하고 자기효능감을 설명했다.'],
  ['자기효능 감을 보고 자기효능 감을 썼다.','자기효능감을 설명했다.'],
  ['한 개인의 사례다.','한개인의 사례다.']
 ];for(const[a,b]of samples)assert.equal(repair(a,b),a);
});

test('ordinal meaning restoration does not reintroduce attested PDF word gaps',()=>{
 const {restoreSourceSentenceOrdinals}=require('../engine-gpt-prod/sourceSentenceRestore');
 const source='자기효능 감을 회복하려면 두 경험의 공통점을 이해해야 한다.';
 const current='자기효능감을 회복하려면 두 경험의 차이를 이해해야 한다.';
 const result=restoreSourceSentenceOrdinals(source,current,[1]);
 assert.equal(result.applied,true);
 assert.equal(result.text,'자기효능감을 회복하려면 두 경험의 공통점을 이해해야 한다.');
});
test('restoration spacing is idempotent and preserves all nonhorizontal-whitespace characters',()=>{
 const a='진로개 발을 통해 자기효능 감을 높여야 한다.',b='진로개발을 통한 자기효능감을 강조했다.';
 const r=repair(a,b);assert.equal(r.replace(/[ \t]/g,''),a.replace(/[ \t]/g,''));assert.equal(repair(r,b),r);
});
