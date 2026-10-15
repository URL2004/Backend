'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const review = require('../engine-gpt-prod/referenceRelationReview');
const operator = require('../engine-gpt-prod/semanticOperatorReview');
const delivery = require('../lib/humanizeDeliveryPolicy');
const source = '사례 1과 사례 2는 실험 장비의 반복 사용을 줄였다는 공통점이 있으나, 사례 1에서는 비용이 늘었고 사례 2에서는 비용을 통제했다. 사례 3은 장비 추가 없이 절차를 바꾸었다.';
const output = '세 가지 사례는 실험 장비의 반복 사용을 줄였다는 점에서 공통되지만 접근 방법은 달랐다. 사례 1에서는 비용이 늘었고 사례 2에서는 비용을 통제했다. 사례 3은 장비 추가 없이 절차를 바꾸었다.';

test('explicit subset broadening is a judge question even when later distinctions survive', () => {
  const rows = review.candidates(source, output);
  assert.equal(rows.filter(row => row.code === review.CODES[0]).length, 1);
  const targets = operator.targets(source, output).filter(row => row.codes.includes(review.CODES[0]));
  assert.equal(targets.length, 1);
  assert(source.includes(targets[0].sourceSpan)); assert(output.includes(targets[0].candidateSpan));
  assert.match(operator.instructionsFor(targets), /원문 전체/);
  const pending = operator.assess(targets, [], [], source, output);
  assert.equal(pending.pending.length, 1); assert.equal(pending.pending[0].repairable, false);
  const preserved = targets.map(row => ({ id: row.id, status: 'preserved', sourceSpan: '', candidateSpan: '', detail: '전체 문맥에 동일한 세 사례 공통점이 별도로 명시되어 있다.' }));
  assert.equal(operator.assess(targets, preserved, [], source, output).pending.length, 0);
});

test('unchanged scope, unrelated commonality, ambiguous ownership and protected syntax are not nominated', () => {
  assert.equal(review.candidates(source, source).length, 0);
  assert.equal(review.candidates(source, output.replace('세 가지 사례는', '사례 1과 사례 2는')).length, 0);
  assert.equal(review.candidates(source, '세 가지 사례는 색상이 밝다는 공통점이 있었다.').length, 0);
  assert.equal(review.candidates(source + ' ' + source, output).length, 0);
  assert.equal(review.candidates('“' + source + '”', output).length, 0);
  assert.equal(review.candidates(source, '```\n' + output + '\n```').length, 0);
});

const left = '새 규정이 시행된 뒤에도 현장의 관행은 오래 유지되었다.';
const missing = '규정과 현장 관행 사이에는 큰 시차가 존재하며, 그 틈이 업무 충돌의 원인이라는 점을 깨달았다.';
const right = '또한 규정의 실제 적용 과정을 자세히 확인할 필요성을 느꼈다.';
test('one missing relation between unique unchanged anchors is nominated without a loss verdict', () => {
  const source = [left, missing, right].join(' '), output = left + '\n\n' + right;
  const rows = review.candidates(source, output);
  assert.deepEqual(rows.map(row => row.code), [review.CODES[1]]);
  assert.equal(rows[0].sourceSpan, missing); assert.equal(rows[0].outputSpan, output);
  assert.equal(operator.targets(source, output).some(row => row.codes.includes(review.CODES[1])), true);
  assert.equal(review.candidates(source, [left, missing, right].join('\n\n')).length, 0);
  assert.equal(review.candidates(source, [missing, left, right].join(' ')).length, 0);
  assert.equal(review.candidates(source, left + ' 규정과 실제 관행은 서로 다른 속도로 바뀌었다. ' + right).length, 0);
  assert.equal(review.candidates(source, left.replace('유지되었다', '유지되어 시차가 생겼다') + ' ' + right).length, 0);
  assert.equal(review.candidates(source + ' ' + left, output).length, 0);
  // A distant paraphrase cannot be excluded by lexical rules. This remains a
  // question for the full-context judge, never a deterministic omission claim.
  const moved = output + ' 제도가 바뀌는 속도와 현장의 변화 속도는 달랐고 그 차이가 마찰을 빚었다.';
  const targets = operator.targets(source, moved).filter(row => row.codes.includes(review.CODES[1]));
  assert.equal(targets.length, 1);
  const answers = targets.map(row => ({ id: row.id, status: 'preserved', sourceSpan: '', candidateSpan: '',
    detail: '뒤 문장에 제도와 관행의 변화 속도 차이 및 마찰이라는 동일한 해석이 유지되어 있다.' }));
  assert.equal(operator.assess(targets, answers, [], source, moved).pending.length, 0);
});

test('skipped or uncertain review remains visible while a verified current pass clears only the review notice', () => {
  const rows = review.candidates(source, output);
  for (const state of ['not_run', 'incomplete', 'uncertain', 'verified_fail', 'stale']) {
    const warnings = review.unresolvedWarnings(rows, state);
    assert.equal(warnings.length, 1);
    assert.equal(delivery.reconcileFinalDelivery({ qualityWarnings: warnings }).decision, 'deliver_review');
    assert(!JSON.stringify(warnings).includes('실험 장비'));
  }
  assert.deepEqual(review.unresolvedWarnings(rows, 'verified_pass'), []);
});
