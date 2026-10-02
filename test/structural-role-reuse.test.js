'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const relations = require('../engine-gpt-prod/layoutRelations');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const structure = require('../engine-gpt-prod/structureChunk');
const prefix = '내가 정리한 흐름도는 업무가 시작되는 시점부터 모든 작업이 끝나는 시점까지의 순서를 자세하게 보여 주었다.';
const body = '내가 그린 도표에는 담당자와 분기 조건이 충분히 표현되지 않아 다른 사람이 실제 업무의 책임 관계를 이해하기 어려웠다.';
function verify(before, after) {
  const report = provenance.bindSemanticValidation({ ran: true, pass: true }, before, before);
  return provenance.verifySemanticValidation(report, { source: before, candidate: after, requireDigest: true });
}

test('unnumbered relative-nominal headings use surrounding complete body units, not a suffix whitelist', () => {
  for (const heading of ['내가 놓쳤던 항목', '우리가 발견한 차이', '다시 살펴볼 질문']) {
    const source = [prefix, heading, body].join('\n');
    assert.equal(layout.buildLineRecords(source)[1].role, 'heading', heading);
    const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
    assert(plan.chunks.some(c => c.locked && c.text.includes(heading)));
    assert.equal(structure.mergeChunks(plan.chunks), source);
    const fused = source.replace(/\n/gu, ' ');
    assert.equal(verify(source, fused).status, 'stale');
    const fixed = structure.restoreFinalDocumentLayout({ source, outputText: fused, chunks: plan.chunks,
      mode: 'blog', documentProfile: { profile: 'report_assignment' } });
    assert(fixed.text.includes('\n' + heading + '\n'), fixed.text);
    assert.equal(fixed.text.replace(/\s/gu, ''), source.replace(/\s/gu, ''));
  }
});

test('pointing catalogue instructions preserve long proper-name item boundaries', () => {
  const items = ['Northern Exploration Society의 Azure Harbour Observation Station',
    'Northern Exploration Society의 Meridian Hydroelectric Facility',
    'Principality of Westmarch의 Pine Hill, Highland Island'];
  const source = ['아래에 제시된 장소를 먼저 방문하는 것이 좋겠습니다.', ...items,
    '위 장소들은 관찰 연습에 사용할 수 있는 시설입니다.'].join('\n');
  const records = layout.buildLineRecords(source);
  assert.deepEqual(records.slice(1, 4).map(r => r.role), ['list', 'list', 'list']);
  const fused = source.replace(items.join('\n'), items.join(' '));
  assert.equal(verify(source, fused).status, 'stale');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  assert.equal(structure.mergeChunks(plan.chunks), source);
});

test('new mid-sentence paragraphs invalidate whitespace-only verdict reuse in both directions', () => {
  for (const [left, right] of [
    ['도시의 교통 환경이 바뀌면서 이미', '지역사회에서는 여러 문제가 나타나기 시작했다.'],
    ['소설의 주인공은 평소와 다름없던 어느 날', '아침에 자신에게 일어난 변화를 알아차렸다.'],
    ['관찰 기록을 비교한 결과 연구자는 새로운', '관계가 형성되었다는 사실을 확인했다.']
  ]) {
    const text = left + ' ' + right;
    const split = left + '\n\n' + right;
    assert.equal(verify(text, split).status, 'stale');
    assert.equal(verify(split, text).status, 'stale');
    assert.notEqual(relations.preparationRelationDigest(text), relations.preparationRelationDigest(split));
  }
});

test('unclassified short rows retain uncertainty instead of authorizing flattened reuse', () => {
  const source = [prefix, '현장의 새로운 관점', body].join('\n');
  assert.equal(verify(source, source.replace(/\n/gu, ' ')).status, 'stale');
});

test('introduced paragraph seams repair only with unique adjacent source-prose anchors', () => {
  const left = '새로운 환경을 조사하던 연구자는 평소와 다름없던 어느 날';
  const right = '아침에 주변 사람들의 행동에 변화가 있다는 사실을 알아차렸다.';
  const source = '## 관찰 기록\n\n' + left + '\n' + right;
  const candidate = source.replace('날\n아침', '날\n\n아침');
  const fixed = relations.restoreAttestedProseGaps(source, candidate);
  assert.equal(fixed.repairedCount, 1);
  assert.equal(fixed.text, source.replace('날\n아침', '날 아침'));
  assert.equal(relations.restoreAttestedProseGaps(source, fixed.text).repairedCount, 0);
  for (const retained of [candidate, '```\n' + source + '\n```', source + '\n\n' + source]) {
    assert.equal(relations.restoreAttestedProseGaps(retained, candidate).repairedCount, 0);
  }
  assert.equal(relations.restoreAttestedProseGaps(source.replace('아침에 주변', '저녁에 주변'), candidate).repairedCount, 0);
  assert.equal(relations.restoreAttestedProseGaps(source.replace('알아차렸다', '몰랐다'), candidate).repairedCount, 1);
});

test('complete prose, harmless wraps, and negative heading/catalogue cases stay editable', () => {
  const source = '첫 번째 관찰을 마쳤다. 다음 단계의 결과도 기록했다.';
  assert.equal(verify(source, source.replace('. 다음', '.\n\n다음')).status, 'pass');
  assert.equal(verify(source, source.replace('단계의 결과', '단계의\n결과')).status, 'pass');
  for (const fragment of ['조사를 진행하기 위한', '우리가 살펴본 자료를', '관찰한 결과에 대해서는']) {
    const records = layout.buildLineRecords([prefix, fragment, body].join('\n'));
    assert.equal(records[1].role, 'prose', fragment);
  }
  const ordinary = ['아래에 제시된 내용을 참고하여 글을 작성했다.',
    '협회의 연구원은 오늘 조사를 마쳤다.', '도시의 시설은 정기 검사를 받았다.',
    '학교의 학생은 수업에 참여했다.'].join('\n');
  assert(!layout.buildLineRecords(ordinary).some(r => r.role === 'list'));
});
