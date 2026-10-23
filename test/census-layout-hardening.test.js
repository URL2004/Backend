'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const { restoreSourceConnectiveBoundary: restore } = require('../engine-gpt-prod/sourceConnectiveBoundary');
test('a title after draft instructions and parallel application headings remain separate from prose', () => {
  const body = '관찰한 내용을 여러 날짜에 걸쳐 기록했다. 담당자와 함께 결과를 비교하고 의견을 나눴다. 현장에서 직접 확인한 변화와 관련 자료를 정리하여 다음 활동에 활용했다.';
  const source = `역경 극복\n${body}\n장거리달리기\n${body.repeat(2)}\n직무 적합성\n${body.repeat(2)}`;
  for (const label of ['역경 극복', '장거리달리기', '직무 적합성']) {
    assert.ok(['title','heading'].includes(layout.buildLineRecords(source).find(r => r.text === label).role));
  }
  const title = '협력 활동이 보여 준 새로운 가능성';
  const draft = '아래 글은 내가 쓴 초안이야, 글을 다듬어 줘\n' + title + '\n' + body.repeat(2);
  assert.equal(layout.buildLineRecords(draft).find(r => r.text === title).role, 'title');
  const plan = structure.splitChunksForGpt(draft, { coalesceEditable: true, preserveLineBoundaries: 'structural' });
  assert.ok(plan.chunks.some(c => c.locked && c.text.includes(title)));
  const merged = draft.replace(title + '\n', title + ' ');
  const repaired = structure.restoreLockedHeadingLayout(draft, merged, plan.chunks);
  assert.ok(repaired.text.includes(title + '\n'));
  assert.equal(repaired.text.replace(/\s/gu, ''), merged.replace(/\s/gu, ''));
});
test('analysis labels are protected, but full prose and hanging clauses remain editable', () => {
  for (const label of ['세부 과제', '양적 분석', '질적 분석']) assert.equal(layout.classifyLine(label), 'heading');
  for (const text of ['양적 분석 결과를 비교했다.', '새로운 조건이 성립한다면']) {
    assert.equal(layout.classifyLine(text, { next: { text: '이후에는 결과를 다시 검토한다.' } }), 'prose');
  }
});
test('a connective before a parenthetical keeps its attested comma, without altering quoted or existing punctuation', () => {
  const source = '신청은 사전에 가능하며 (제4항), 지원 대상과 처리 방법을 담당자에게 확인해야 한다.';
  const broken = source.replace('하며 (제4항),', '하며(제4항).');
  assert.equal(restore(source, broken).text, source.replace('하며 (', '하며('));
  assert.equal(restore(broken, broken).applied, false);
  assert.equal(restore(source, '“' + broken + '”').applied, false);
  assert.equal(restore(source.replace('가능하며', '허용되며'), broken).applied, false);
});
