'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../engine-gpt-prod/semanticOperatorReview');
const source = '마틴 로웰(Martin Lowell)과 사라 로웰(Sarah Lowell)은 서로 다른 연구를 담당했다.';
const output = '사라 로웰(Martin Lowell)과 마틴 로웰(Sarah Lowell)은 서로 다른 연구를 담당했다.';

test('alias owner swap requires an explicit grounded answer, not an empty pass', () => {
  const targets = review.targets(source, output).filter(t => t.codes.includes('alias_owner_binding_candidate'));
  assert.equal(targets.length, 1);
  const pending = review.assess(targets, [], [], source, output);
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].origin, 'unconfirmed');
  assert.equal(pending.pending[0].repairable, false);
  assert.equal(pending.pending[0].relation, 'actor_action_target');
  assert.equal(review.assess(targets, [{id:targets[0].id,status:'preserved',sourceSpan:'',candidateSpan:'',detail:'The same paired identity was established in context.'}], [], source, output).pending.length, 0);
  assert.equal(review.assess(targets, [{id:targets[0].id,status:'changed',sourceSpan:'',candidateSpan:'',detail:'The two named owners have traded their parenthetical aliases.'}], [], source, output).pending.length, 1);
});

test('alias review preserves closed-world and nonverdict contracts', () => {
  assert.match(review.instruction, /원문 자체의 모호한 연결/);
  assert.match(review.instruction, /외부 지식으로 이름을 수정하지 않는다/);
  const same = '사라 로웰(Sarah Lowell)과 마틴 로웰(Martin Lowell)은 서로 다른 연구를 담당했다.';
  assert.equal(review.targets(source, same).filter(t => t.codes.includes('alias_owner_binding_candidate')).length, 0);
});

test('cross-section name swaps reach explicit review only with current exact pair evidence', () => {
  const part = '초기 설계는 마틴 로웰(Martin Lowell)이 맡아 구조를 잡았다.';
  const candidate = '초기 설계는 사라 로웰(Martin Lowell)이 맡아 구조를 잡았다.';
  const document = part + ' 이후 검증 절차는 사라 로웰(Sarah Lowell)이 이어받아 정리했다.';
  const hints = require('../engine-gpt-prod/relationAudit').auditRelationCandidates(part, candidate, { documentSource: document }).candidates.filter(c => c.code === 'alias_owner_binding_candidate').map(JSON.stringify);
  assert.equal(hints.length, 1);
  assert.equal(review.targets(part, candidate).filter(t => t.codes.includes('alias_owner_binding_candidate')).length, 0);
  assert.equal(review.targets(part, candidate, hints).filter(t => t.codes.includes('alias_owner_binding_candidate')).length, 1);
  assert.equal(review.targets(part, part, hints).filter(t => t.codes.includes('alias_owner_binding_candidate')).length, 0);
});
