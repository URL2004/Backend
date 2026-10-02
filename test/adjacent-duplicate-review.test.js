'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const review=require('../engine-gpt-prod/adjacentDuplicateReview');
const operators=require('../engine-gpt-prod/semanticOperatorReview');
const source='기록을 남기는 능력과 연구원에게 도움이 되는 정도가 한 사람의 가치와 완전히 같다고\n\n생각하지는 않는다.';
const candidate='기록을 남기는 능력과 연구원에게 도움이 되는 정도가 한 사람의 가치와 완전히 같은 것은 아니라고 생각한다.\n\n생각하지는 않는다.';
test('a unique forced source suffix behind its complete replacement nominates exact paired locations',()=>{
  const found=review.candidates(source,candidate);
  assert.equal(found.length,1);
  const t=found[0];
  assert.equal(source.slice(t.sourceStart,t.sourceEnd),t.sourceSpan);
  assert.equal(candidate.slice(t.outputStart,t.outputEnd),t.outputSpan);
  assert.equal(t.outputSpan,candidate);
  assert.equal(t.sourceSpan,source);
});
test('new replay questions require contextual adjudication, never automatic repair',()=>{
  const target=operators.targets(source,candidate).find(t=>t.codes.includes(review.CODE));
  assert.ok(target);
  const pending=operators.assess([target],[],[],source,candidate).pending;
  assert.equal(pending.length,1);
  assert.equal(pending[0].repairable,false);
  assert.equal(operators.assess([target],[{...target,status:'preserved',detail:'The two units have independent roles in the surrounding context.'}],[],source,candidate).pending.length,0);
  assert.equal(operators.assess([target],[{...target,status:'changed',detail:'A substantive duplication finding must be separately grounded.'}],[],source,candidate).pending.length,1);
});
test('inherited repetition, another source claim, changed participants or conditions abstain',()=>{
  for(const [a,b] of [[candidate,candidate],[source+' '+source,candidate],
    [source+' '+candidate.split('\n')[0],candidate],
    [source,candidate.replace('연구원에게','교수에게')],
    [source,candidate.replace('한 사람의','다른 조직의')],
    [source,candidate.replace('기록을','측정을')],
    [source,candidate.replace('기록을','조건이 달라진다면 기록을')],
    [source,candidate.replace('기록을','겨울철에만 기록을')],
    ['“'+source+'”','“'+candidate+'”'],['`'+source+'`','`'+candidate+'`'],
    [source.replace('\n\n',' '),candidate]]) {
    assert.equal(review.candidates(a,b).length,0,JSON.stringify([a,b]));
  }
});
test('normal sentence splitting and generic adjacent paraphrases do not nominate suffix replay',()=>{
  const ordinary='준비 과정이 가장 어려웠다. 준비하는 시간이 가장 힘들었다.';
  assert.equal(review.candidates('준비 과정이 가장 어려웠다.',ordinary).length,0);
  assert.equal(review.candidates(source,source.replace('\n\n',' ')).length,0);
  assert.equal(review.candidates(source,candidate.replace('생각한다.','생각하며')) .length,0);
});
