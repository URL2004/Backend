'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../engine-gpt-prod/voiceProfile');
const structure = require('../engine-gpt-prod/structureChunk');

test('one missing section quote does not prevent a safely located quote in another section from being restored', () => {
  const source = '1. 첫 기록\n“첫 활동의 결과를 구체적으로 기록한다.”\n\n2. 둘째 기록\n“두 번째 활동의 결과를 검토한다.”';
  const output = '1. 첫 기록\n“첫 활동의 원인을 추측하여 기록한다.”\n\n2. 둘째 기록\n관련 기록이 없다.';
  const result = voice.restoreDirectQuoteContents(source, output);
  assert.equal(result.applied, true);
  assert.ok(result.text.includes('“첫 활동의 결과를 구체적으로 기록한다.”'));
  assert.ok(result.text.endsWith('관련 기록이 없다.'));
  assert.equal(result.auditAfter.pass, false);
  assert.equal(result.auditAfter.ownership.missingCount, 1);
});

test('public quote audit counts a multiline direct quote and restores its source contents', () => {
  const source = '기록에는 “관찰한 결과를 정리한다. 다음 활동의 준비 자료를 함께 확인한다.”고 적혀 있다.';
  const output = source.replace('다. 다음', '다.\n\n다음');
  const audit = voice.auditDirectQuoteIntegrity(source, output);
  assert.equal(audit.sourceCount, 1);
  assert.equal(audit.outputCount, 1);
  assert.equal(audit.contentChanged, true);
  const repaired = voice.restoreDirectQuoteContents(source, output);
  assert.equal(repaired.text, source);
  assert.equal(repaired.auditAfter.pass, true);
});

test('public quote restore vetoes ordinal overwrite when an existing quote shifts', () => {
  const source = '기록은 “첫 활동을 관찰한다.”와 “둘째 활동을 점검한다.”를 포함한다.';
  const output = '기록은 “둘째 활동을 점검한다.”와 “셋째 활동을 준비한다.”를 포함한다.';
  const repaired = voice.restoreDirectQuoteContents(source, output);
  assert.equal(repaired.applied, false);
  assert.equal(repaired.text, output);
  assert.equal(repaired.auditAfter.pass, false);
});

test('malformed attributed quote is never a vacuous zero-to-zero audit pass', () => {
  const source = '1. 관찰 기록\n“관찰자는 여러 활동의 결과를 기록한다.“ 교재 참고: p.21 관찰 방법';
  const output = source.replace('결과를 기록한다', '원인을 추측한다');
  assert.equal(voice.auditDirectQuoteIntegrity(source, output).pass, false);
  const repaired = voice.restoreDirectQuoteContents(source, output);
  assert.equal(repaired.text, source);
  assert.equal(repaired.auditAfter.pass, true);
  const plan = structure.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(c => c.lockType === 'quote' && c.text.includes('결과를 기록한다')));
  assert.equal(structure.mergeChunks(plan.chunks), source);
});
