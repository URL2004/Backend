'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
const { confirmedRelationDefects, stopUnproductiveLongEscalation } = require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const { restoreRelationScopes } = require('../engine-gpt-prod/relationScopeRestore');
const { applyDeliveryPolicy } = require('../lib/humanizeDeliveryPolicy');
// Invented laboratory scenario; never retain a customer's document in fixtures.
const source = '준비가 끝나도 실험 장비가 제대로 작동하지 않거나 측정이 임의의 설정으로 진행된다면 결과는 유효하지 않다.';
const candidate = '준비가 끝나도 실험 장비가 제대로 작동하거나 측정이 임의의 설정으로 진행된다면 결과는 유효하지 않다.';
const finding = groundViolation({ type: 'distortion', origin: 'introduced', relation: 'modality_negation_causality',
  sourceSpan: source, candidateSpan: candidate, span: '작동하거나' }, source, candidate);
const verdict = extra => bindSemanticValidation({ ran: true, pass: false, verificationCompleted: true, violations: [finding], ...extra }, source, candidate);
test('a source-attested negative condition is restored before the final judge without another model call', () => {
  assert.equal(restoreRelationScopes(source, candidate).text, source);
  assert.equal(restoreRelationScopes(source, source).applied, false);
  assert.equal(restoreRelationScopes(source + ' ' + source, candidate).applied, false);
  assert.equal(restoreRelationScopes('“' + source + '”', '“' + candidate + '”').applied, false);
});
test('current exact confirmed meaning errors block charged review, while stale or uncertain evidence abstains', () => {
  assert.equal(confirmedRelationDefects(source, candidate, verdict()).length, 1);
  assert.equal(applyDeliveryPolicy({ criticals: [{ gate: 'confirmed_semantic_relation' }], warnings: [] }).decision, 'block_technical');
  for (const extra of [{ uncertain: true }, { verificationCompleted: false }, { nominationOnly: true }, { pass: true },
    { violations: [{ ...finding, origin: 'source_existing' }] }, { violations: [{ ...finding, relation: 'genre_naturalness' }] },
    { violations: [{ ...finding, spanVerified: false }] }]) {
    assert.equal(confirmedRelationDefects(source, candidate, verdict(extra)).length, 0);
  }
  assert.equal(confirmedRelationDefects(source, candidate + ' 추가 문장이다.', verdict()).length, 0);
  const mixed = verdict({ uncertain: true, violations: [finding, { origin: 'unconfirmed', repairable: false }] });
  assert.equal(confirmedRelationDefects(source, candidate, mixed).length, 1);
});
test('a failed optional long rewrite cannot repeat after no progress, but mandatory/no-op/meaning recovery stays eligible', () => {
  const input = { attempt: 1, sourceLength: 10000, semantic: { ran: true, pass: true, verificationCompleted: true },
    metrics: { substantiveChangedSentenceCount: 6, substantiveEditRatio: .15 }, reason: 'candidate_unchanged' };
  assert.equal(stopUnproductiveLongEscalation(input), true);
  for (const patch of [{ attempt: 0 }, { sourceLength: 5000 }, { reason: 'semantic_audit_failed' },
    { metrics: { substantiveChangedSentenceCount: 0, substantiveEditRatio: 0 } },
    { semantic: { ...input.semantic, pass: false } }, { semantic: { ...input.semantic, verificationCompleted: false } }]) {
    assert.equal(stopUnproductiveLongEscalation({ ...input, ...patch }), false);
  }
});
