'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CODE, terminalSyllableCandidates: review } = require('../engine-gpt-prod/terminalSyllableReview');
const korean = require('../engine-gpt-prod/koreanRefinement');

test('source-attested duplicated terminal syllable becomes a review question, never a deletion', () => {
  const source = '담당자는 확률분포 모형을 먼저 비교했다.';
  const outputText = '담당자는 확률분포포 모형을 먼저 비교했다.';
  assert.deepEqual(review(source, outputText), [{code:CODE,ordinal:1}]);
  const audit = korean.analyzeKoreanRefinement({ source, outputText });
  const issue = audit.repairableIssues.find(i => i.code === CODE);
  assert.ok(issue);
  assert.equal(issue.deterministicSafe, false);
  assert.equal(korean.applySafeDeterministicRepairs({source,outputText}).text, outputText);
});

test('particles, endings, existing reduplication, changed context and protected literals are not nominated', () => {
  for (const [source, output] of [
    ['관련전문가 의견을 확인했다.', '관련전문가가 의견을 확인했다.'],
    ['작업이 이어지 않을 경우 중단했다.', '작업이 이어지지 않을 경우 중단했다.'],
    ['확률분포포 모형을 비교했다.', '확률분포포 모형을 대조했다.'],
    ['확률분포 모형을 비교했다.', '확률분포포 방식으로 비교했다.'],
    ['확률분포 모형을 비교했다.', '“확률분포포 모형을 비교했다.”'],
    ['확률분포 모형을 비교했다.', '`확률분포포 모형`을 비교했다.']
  ]) {
    assert.deepEqual(review(source, output), [], output);
  }
});

test('possessive and topic particle changes preserve lexical evidence but authorize no restoration', () => {
  const source = '확률분포의 모형을 비교했다. 확률분포의 모형은 자료로 확인했다.';
  const output = '확률분포포 모형은 자료로 비교했다.';
  assert.equal(review(source, output).length, 1);
  assert.equal(korean.applySafeDeterministicRepairs({source,outputText:output}).text, output);
});
