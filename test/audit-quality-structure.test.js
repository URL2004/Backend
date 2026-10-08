'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const { splitChunksForGpt } = require('../engine-gpt-prod/structureChunk');

// Synthetic records: production user text must stay outside the repository.
const table = ['영역', '점검할 위험요인', '개선 과제',
  '설비', '부품 마모, 진동 증가, 좁은 통로', '부품 교체, 진동 측정 및 작업 동선 확보',
  '운영', '점검 지연, 담당자 변경', '책임자 지정, 인계 및 정기 점검 절차 마련',
  '환경', '온도 상승, 환기 불량', '환기 장치 점검 및 온도 관찰'].join('\n');

test('plain risk/action cells survive preflight and cannot reuse a merged-cell receipt', () => {
  const source = '장비 운영 검토\n\n각 영역의 문제를 확인하고 다음 점검에 반영한다.\n\n' + table;
  const changed = source.replace('좁은 통로\n부품 교체', '좁은 통로 부품 교체');
  assert.equal(preflight.repairForcedProseWraps(source).text, source);
  assert.ok(preflight.auditAndSanitizeSource(source).text.includes(table));
  assert.equal(layout.analyzeLineStructure(source).tableLineCount, 12);
  const chunks = splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  for (const cell of table.split('\n')) assert.ok(chunks.some(c => c.locked && c.text.includes(cell)));
  const receipt = provenance.bindSemanticValidation({ ran: true, pass: true }, source, source);
  assert.equal(provenance.verifySemanticValidation(receipt, { source, candidate: changed, requireDigest: true }).status, 'stale');
  const partial = table.split('\n').slice(0, -1).join('\n');
  assert.equal(preflight.repairForcedProseWraps(partial).text, partial);
  assert.equal(layout.analyzeLineStructure(partial).tableLineCount, 11);
});

test('unfinished long prose ending is repaired without mistaking it for a Korean list', () => {
  for (const [left, right, joined] of [
    ['이번 관찰에서 가장 먼저 확인한 것은 참여자가 문제를 대하는 태도이', '다. 이후에는 질문을 함께 정리했다.', '태도이다.'],
    ['이 장치는 외부 조건에 따라 작동 시간이 달라질 수 있으', '며. 결과는 다음 점검 때 기록한다.', '있으며.'],
    ['처음 기록을 작성할 때에는 담당자에게 같은 내용을 확인했', '다. 다음에는 자료를 직접 비교했다.', '확인했다.']
  ]) {
    const source = left + '\n' + right;
    const repaired = preflight.repairForcedProseWraps(source).text;
    assert.ok(repaired.includes(joined), repaired);
    assert.equal(repaired.replace(/\s/gu, ''), source.replace(/\s/gu, ''));
    assert.equal(preflight.repairForcedProseWraps(repaired).text, repaired);
  }
});

test('full and partially copied Korean lists, verse and literal blocks stay separated', () => {
  const left = '다음 절차를 진행하기 전에 관련 부서의 의견을 충분히 확인했';
  for (const source of [
    '가. 항목 확인\n나. 자료 수집\n다. 결과 정리',
    '나. 항목 확인\n' + left + '\n다. 결과 정리',
    '라. 자료 점검\n마. 결과 정리',
    '바람이\n다.\n아아\n작은 빛',
    '「실험의 기록:\n관찰과 질문」',
    '```text\n' + left + '\n다. 결과 정리\n```',
    '| 영역 | 기준 |\n| 설비 | 점검 |'
  ]) assert.equal(preflight.repairForcedProseWraps(source).text, source);
});

test('ordinary complete-sentence whitespace remains a reusable validation', () => {
  const source = '자료를 수집했다. 결과를 정리했다.';
  const report = provenance.bindSemanticValidation({ ran: true, pass: true }, source, source);
  assert.equal(provenance.verifySemanticValidation(report, {
    source, candidate: source.replace(' 결과', '\n\n결과'), requireDigest: true
  }).status, 'pass');
});
