'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const structure = require('../engine-gpt-prod/structureChunk');

const reference = '교재 참고: p.21~22 준비 과정과 필요한 자료, p.35~36 7.3.2. 교수-학습에서의 교사 역할, p.37~38 일과 구성';
const body = Array.from({ length: 9 }, (_, i) =>
  `${i + 1}번째 활동에서 학습자는 관찰한 결과를 기록하고 서로 다른 의견의 근거를 비교하며 탐구 내용을 구체적으로 정리한다.`).join(' ');
const source = [
  '1. 수업의 강점', `${body} ${reference}`, reference,
  '', '2) 현실적 제약', `${body} ${reference}`, reference,
  '', '3. 수업 운영', '결과를 확인하고 다음 수업의 준비 방법을 함께 검토한다.'
].join('\n');
function run(source, outputText) {
  const { chunks } = structure.splitChunksForGpt(source, { preserveLineBoundaries: 'structural' });
  return structure.restoreFinalDocumentLayout({ source, outputText, chunks, mode: 'assignment',
    requestStrength: 'basic', documentProfile: { profile: 'report_assignment' }, normalizeVisualGaps: true });
}

test('a mock prose rewriter trimming chunk edges cannot fuse citations or edit literal gaps', () => {
  const input = `1. 활동 기록\n작성자는 수업에서 관찰한 여러 활동을 차례대로 검토하고 학생들의 참여 과정을 기록한다. 서로 다른 의견이 제시되면 구체적인 관찰 기록을 비교하여 결과를 설명한다. ${reference}\n\n2. 다음 활동\n관찰을 계속한다.`;
  const plan = structure.splitChunksForGpt(input, { coalesceEditable: true });
  for (const chunk of plan.chunks) {
    if (chunk.locked) continue;
    assert.ok(chunk.text.trim());
    chunk.outputText = chunk.text.trim().replace('설명한다', '정리한다');
  }
  const output = structure.mergeChunks(plan.chunks);
  assert.ok(output.includes(`정리한다. ${reference}`));
  const final = run(input, output);
  assert.equal(final.pass, true);
  assert.ok(final.text.includes(`정리한다. ${reference}`));
});

test('whole document layout preserves repeated citation row ownership and reaches a fixed point', () => {
  const damaged = source.replaceAll(` ${reference}`, `\n\n${reference}`)
    .replaceAll('7.3.2. 교수', '7.3.2.\n\n교수')
    .replace('\n\n2) 현실적 제약\n', ' 2) 현실적 제약 ');
  const result = run(source, damaged);
  assert.equal(result.converged, true);
  assert.equal(result.text.replace(/\s/gu, ''), damaged.replace(/\s/gu, ''));
  assert.match(result.text, /\n2\) 현실적 제약\n/u);
  assert.equal(result.text.split('\n').filter(line => line.startsWith('교재 참고:')).length, 2);
  assert.doesNotMatch(result.text, /7\.3\.2\.\s*\n/u);
  assert.equal(run(source, result.text).text, result.text);
  assert.equal(run(source, result.text).iterationCount, 1);
});

test('source replay preserves citation literals while prose can acquire readable paragraphs', () => {
  const result = run(source, source);
  assert.equal(result.converged, true);
  assert.equal(result.text.split('\n').filter(line => line.startsWith('교재 참고:')).length, 2);
  assert.doesNotMatch(result.text, /7\.3\.2\.\s*\n/u);
  assert.equal(run(source, result.text).text, result.text);
});

test('citation and its attributed direct quote stay out of editable model chunks', () => {
  const quote = '“관찰자는 결과를 기록하고 다음 활동에 필요한 자료를 정리한다.”';
  const input = `1. 관찰 결과\r\n설명을 시작한다. ${quote} ${reference}\r\n${reference}\r\n\r\n다음 활동은 별도로 논의한다.`;
  const plan = structure.splitChunksForGpt(input, { coalesceEditable: true });
  assert.equal(structure.mergeChunks(plan.chunks), input);
  assert.ok(plan.chunks.some(c => c.lockType === 'quote' && c.text === quote));
  assert.ok(plan.chunks.some(c => c.lockType === 'reference_item'));
  assert.ok(plan.chunks.filter(c => !c.locked).every(c => !c.text.includes('p.21') && !c.text.includes('관찰자는')));
  assert.ok(plan.chunks.some(c => !c.locked && c.text.includes('다음 활동')));
  const final = run(input, input);
  assert.equal(final.pass, true);
  assert.ok(final.text.includes(`설명을 시작한다. ${quote} ${reference}`));
});
