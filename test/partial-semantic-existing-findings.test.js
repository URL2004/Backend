'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canRetainPartialSemanticRepair: retain } = require('../engine-gpt-prod/partialSemanticRepair');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { bindSemanticValidation: bind } = require('../engine-gpt-prod/semanticProvenance');
const { obligationId } = require('../engine-gpt-prod/semanticObligations');

const unchanged = '검사자는 관측 결과를 조금씩 이해할 것 같다고 기록했다.';
const original = unchanged.replace('조금씩', '조금');
const repaired = '기록을 보관하기 위해 정리 방법을 배우고 싶다.';
const broken = '기록을 보관하며 정리 방법을 배우고 싶다.';
const middle = ['장비의 이름과 설치 위치는 별도의 문서에 기록되어 있었다.',
  '담당자는 보관실의 온도와 습도를 확인하고 점검 날짜를 적었다.',
  '종이 문서와 전자 문서는 서로 다른 서랍과 저장소에 보관했다.'];
function fixture() {
  const source = ['## 점검 기록', original, ...middle, repaired].join('\n\n');
  const before = source.replace(original, unchanged).replace(repaired, broken);
  const candidate = before.replace(broken, repaired);
  const ground = (a, b, text) => groundViolation({ type: 'distortion', relation: 'other', origin: 'introduced',
    sourceSpan: a, candidateSpan: b, span: b }, source, text);
  const old = ground(repaired, broken, before), discovered = ground(original, unchanged, candidate);
  const previous = { pass: false, violations: [old], initialViolations: [old] };
  const next = bind({ ran: true, verificationCompleted: true, pass: false, uncertain: false,
    violations: [discovered], obligationReviews: [{ id: obligationId(old), status: 'resolved',
      sourceSpan: repaired, candidateSpan: repaired, detail: 'The original purpose of learning is restored exactly.' }] }, source, candidate);
  return { source, before, candidate, previous, next, old, discovered, ground };
}

test('a freshly discovered unchanged error does not discard independently verified progress or become a pass', () => {
  const f = fixture(), snapshot = JSON.stringify(f);
  assert.equal(retain(f.source, f.before, f.candidate, f.previous, f.next), true);
  assert.equal(f.next.pass, false);
  assert.equal(f.next.violations.length, 1);
  assert.equal(JSON.stringify(f), snapshot);
});

test('new candidate text, stale provenance, uncertain judgment and forged grounding still reject', () => {
  for (const mutate of [
    f => f.next.uncertain = true,
    f => f.next.verificationCompleted = false,
    f => f.next.validation.candidateDigest = 'stale',
    f => f.next.violations[0].span = 'A problem span that is not in either text.',
    f => f.next.violations[0].sourceSpan = 'This source quotation is absent from the source document.',
    f => f.next.violations[0].repairable = false,
    f => { f.before = f.before.replace(unchanged, original); }
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(retain(f.source, f.before, f.candidate, f.previous, f.next), false);
  }
});

test('unreviewed previous initial evidence and invalid resolution cannot disappear behind a new finding', () => {
  for (const mutate of [
    f => f.next.obligationReviews = [],
    f => f.next.obligationReviews[0].candidateSpan = broken,
    f => f.next.obligationReviews[0].sourceSpan = original,
    f => f.next.obligationReviews[0].detail = '',
    f => f.previous.initialViolations.push(f.ground(middle[1], middle[1], f.before))
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(retain(f.source, f.before, f.candidate, f.previous, f.next), false);
  }
});

test('changed neighboring context, heading ownership, quotation scope, movement or duplicate text rejects new-evidence retention', () => {
  const mutations = [
    text => text.replace(middle[0], middle[0].replace('별도의', '같은')),
    text => text.replace('## 점검 기록', '## 다른 직원의 주장'),
    text => '“' + text + '”',
    text => text.replace(unchanged + '\n\n' + middle[0], middle[0] + '\n\n' + unchanged),
    text => text + '\n\n' + unchanged
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.candidate = mutate(f.candidate);
    f.next = bind(f.next, f.source, f.candidate);
    assert.equal(retain(f.source, f.before, f.candidate, f.previous, f.next), false);
  }
});

test('an unchanged omission can remain pending while an unrelated confirmed repair is retained', () => {
  const f = fixture();
  f.next.violations = [groundViolation({ ...f.discovered, type: 'omission', span: '조금' }, f.source, f.candidate)];
  assert.equal(retain(f.source, f.before, f.candidate, f.previous, f.next), true);
  assert.equal(f.next.pass, false);
});
