'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { droppedSourceSentences } = require('../engine-gpt-prod/deliveryIntegrityWitnesses');
const { detectSemanticRelationShifts } = require('../engine-gpt-prod/fingerprintAudit');
const { jobRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');

test('a contrast sentence merged into its neighbour is not proof of a deletion', () => {
  const start = '두 접근 방식은 비슷해 보이지만 중심이 다르다. ';
  const missing = '전자는 연습이 먼저이고 기록이 뒤따른다. ';
  const next = '후자는 기록이 먼저 기준이 되고 연습이 그 기준에 맞춰질 수 있다. ';
  const end = '참가자들은 두 접근 방식의 특징을 살폈다.';
  const merged = '연습이 먼저라면 기록은 그 뒤를 따르지만, 기록이 먼저 기준이 되면 연습이 그 기준에 맞춰질 수 있다. ';
  assert.equal(droppedSourceSentences(start + missing + next + end, start + merged + end).length, 0);
  assert.equal(droppedSourceSentences(start + missing + next + end, start + next + end).length, 1);
});
test('importance restated with 일이 keeps its scope without borrowing a neighbours obligation', () => {
  const source = '기준을 변경한 뒤 자료가 어떻게 달라지는지 확인해야 다음 조사에도 활용할 수 있었다. 문제가 생긴 원인을 파악하고 되풀이하지 않는 것이 중요하다는 점을 배웠다.';
  const output = '기준을 바꾼 뒤 자료의 변화를 확인해야 다음 조사에도 활용할 수 있었다. 결국 원인을 살피고 재발을 막는 일이 중요했다.';
  const family = text => detectSemanticRelationShifts(source, text).shifts.some(item => item.family === 'importance_hardened_to_obligation');
  assert.equal(family(output), false);
  assert.equal(detectSemanticRelationShifts('아이의 의견을 존중하는 일이 중요하다.', '아이의 의견을 반드시 존중해야 한다.').shifts
    .some(item => item.family === 'importance_hardened_to_obligation'), true);
});
test('structural fallback shares optional limits and refreshes only the mandatory audit reserve', () => {
  let now = 0;
  const context = {}, options = { clock: () => now, maxCalls: 2, reservedLateCalls: 0, maxElapsedMs: 30000,
    getFinalAuditReserveMs: () => 270000 };
  const first = jobRecoveryBudget(context, .2, options);
  assert.equal(first.tryStart(), true); first.recordUsage({ estimatedUsd: .1 }, 'first');
  now = 20000;
  const second = jobRecoveryBudget(context, .2, { ...options, getFinalAuditReserveMs: () => 540000 });
  assert.equal(second, first);
  assert.equal(second.snapshot().spentUsd, .1);
  assert.equal(second.snapshot().finalAuditReserveMs, 540000);
  assert.equal(second.tryStart({ priority: 'late' }), true);
  assert.equal(second.tryStart({ priority: 'late' }), false);
  assert.equal(second.denialReason({ priority: 'late' }), 'recovery_call_limit_exhausted');
  assert.notEqual(jobRecoveryBudget({}, .2, options), first, 'unrelated jobs never share budgets');
});
test('fallback cannot renew elapsed time and mandatory audit time remains excluded', () => {
  let now = 0;
  const context = {}, options = { clock: () => now, maxElapsedMs: 30000 };
  const first = jobRecoveryBudget(context, 1, options);
  now = 20000;
  const endAudit = first.beginMandatoryAudit(); now += 100000; endAudit();
  assert.equal(first.snapshot().elapsedMs, 20000);
  now += 11000;
  const fallback = jobRecoveryBudget(context, 1, options);
  assert.equal(fallback.denialReason({ priority:'late' }), 'recovery_time_limit_exhausted');
});

test('a fallback with approved edits enables the original cost limit without discarding spent usage', () => {
  const context = {}, first = jobRecoveryBudget(context, .1, { enforced: false });
  first.recordUsage({ estimatedUsd: .12 }, 'technical_recovery');
  assert.equal(first.canStart(), true);
  const second = jobRecoveryBudget(context, .1, { enforced: true });
  assert.equal(second.denialReason(), 'recovery_budget_exhausted');
  assert.equal(second.canStart({ mandatory: true }), true);
});
