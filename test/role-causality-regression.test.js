'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {auditNaturalnessRegression}=require('../engine-gpt-prod/naturalnessRegression');
const {applySafeDeterministicRepairs}=require('../engine-gpt-prod/koreanRefinement');
const source='이 문서는 팀이 직접 만든 참고 자료로서 별도의 외부 검증은 실시하지 않았다.';
const output='이 문서는 팀이 직접 만든 참고 자료이므로 별도의 외부 검증은 실시하지 않았다.';
test('a description cannot become an unsupported reason for the unchanged proposition',()=>{
  const a=auditNaturalnessRegression(source,output);
  assert.ok(a.some(x=>x.code==='introduced_role_causality'));
  const fixed=applySafeDeterministicRepairs({source,outputText:output}).text;
  assert.equal(fixed,source);
  assert.equal(applySafeDeterministicRepairs({source,outputText:fixed}).text,fixed);
});
test('role causality restores consonant connectors and preserves other approved edits',()=>{
  const s='이번 기록은 담당자가 작성한 문서로서 현장의 상황을 상세하게 전달하였다.';
  const o='이번 기록은 담당자가 작성한 문서이기 때문에 현장의 상황을 상세하게 전달하였다.';
  assert.equal(applySafeDeterministicRepairs({source:s,outputText:o}).text,s);
  const s2='그는 현장 책임자로서 조사 결과를 관련 부서에 전달하였다.';
  assert.equal(applySafeDeterministicRepairs({source:s2,outputText:s2.replace('책임자로서','책임자이기에')}).text,s2);
});
test('existing reasons, changed propositions and ambiguous source matches are not rewritten',()=>{
  for(const [s,o]of [[output,output],[source+' '+output,output],[source,output.replace('실시하지 않았다','추후 실시하기로 했다')],[source+' '+source,output]])
    assert.equal(auditNaturalnessRegression(s,o).some(x=>x.code==='introduced_role_causality'),false);
});
test('quoted and code roles cannot license causal connector restoration',()=>{
  for(const wrap of [x=>'“'+x+'”',x=>'`'+x+'`',x=>'```text\n'+x+'\n```'])
    assert.equal(auditNaturalnessRegression(wrap(source),wrap(output)).some(x=>x.code==='introduced_role_causality'),false);
});
test('particle plus copula after a quote is attached and remains a fixed point',()=>{
  for(const suffix of ['까지이며','까지입니다','까지다','부터이다','만이었다']) {
    const source=`범위는 ‘높음’${suffix}.`;
    const fixed=applySafeDeterministicRepairs({source,outputText:source.replace('’','’ ')}).text;
    assert.equal(fixed,source);
    assert.equal(applySafeDeterministicRepairs({source,outputText:fixed}).text,fixed);
  }
});
test('quote spacing does not absorb an independent word after a bound-looking prefix',()=>{
  const source='‘선물’ 까치가 날아갔다. “좋다.” 하고 말했다.';
  assert.equal(applySafeDeterministicRepairs({source,outputText:source}).text,source);
});
