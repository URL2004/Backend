'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {repairParentheticalParticles:repair} = require('../engine-gpt-prod/parentheticalParticles');
const {applySafeDeterministicRepairs,applySafeFormattingRepairs} = require('../engine-gpt-prod/koreanRefinement');
test('unchanged annotation does not determine the head noun particle', () => {
  for (const [head,good,bad] of [['자료','로','으로'],['기술','로','으로'],['설명','으로','로']]) {
    const source = `이 ${head}(예: 그림과 문장)${good} 문제를 설명했다.`;
    const output = source.replace(`)${good}`,`)${bad}`);
    assert.equal(repair(source,output).text,source);
    assert.equal(repair(source,source).repairCount,0);
  }
});
test('nested balanced annotations and multiple repairs are offset safe', () => {
  const source = '이 자료(추가 설명(예시))로 정리하고, 다른 설명（그림）으로 마무리했다.';
  assert.equal(repair(source,source.replace('))로','))으로').replace('）으로','）로')).text,source);
});
test('ambiguous changed annotations, unknown pronunciation and source errors are not guessed', () => {
  for(const [source,output] of [
    ['이 자료(예시)로 정리했다.','이 자료(다른 예시)으로 정리했다.'],
    ['이 자료(예시)으로 정리했다.','이 자료(예시)으로 정리했다.'],
    ['이 API(연결)로 처리했다.','이 API(연결)으로 처리했다.'],
    ['이 자료(예시)로 정리했다.','이 자료(예시으로 정리했다.']
  ]) assert.equal(repair(source,output).text,output);
});
test('quotes and fenced or inline code are immutable', () => {
  const source='이 자료(예시)로 정리했다.';
  const bad=source.replace(')로',')으로');
  for(const output of [`“${bad}”`,`“${bad}"`,`"${bad}”`,`\`${bad}\``,`\`\`\`text\n${bad}\n\`\`\``]) {
    assert.equal(repair(source,output).text,output);
  }
});
test('particle repair belongs to lexical phase, not post-verification whitespace phase', () => {
  const source='이 자료(예시)로 정리했다.', output=source.replace(')로',')으로');
  assert.equal(applySafeDeterministicRepairs({source,outputText:output}).text,source);
  assert.equal(applySafeFormattingRepairs({source,outputText:output}).text,output);
});
