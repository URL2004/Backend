'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const semantic = require('../engine-gpt-prod/semanticProvenance');
const delivery = require('../lib/humanizeDeliveryPolicy');

test('검사 뒤 바뀐 최종본은 옛 pass로 clean을 주장하지 않고 검토 상태로 전달한다', () => {
  const source = '행사에는 30명이 참석했다.';
  const candidate = '참석 인원은 30명이었다.';
  const report = semantic.bindSemanticValidation({ ran: true, pass: true }, source, candidate);
  const final = '참석 인원은 31명이었다.';
  const validation = semantic.verifySemanticValidation(report, { source, candidate: final, requireDigest: true });
  const warnings = semantic.finalValidationWarnings(report, validation);
  assert.equal(validation.status, 'stale');
  assert.equal(warnings[0].code, 'semantic_validation_stale');
  const result = delivery.reconcileFinalDelivery({ blocked: false, baseReasonCodes: [], qualityWarnings: warnings });
  assert.equal(result.decision, 'deliver_review');
  assert.ok(result.reasonCodes.includes('semantic_validation_stale'));
});

test('정확한 검사 통과와 의도적으로 건너뛴 짧은 글은 새 확인 경고를 만들지 않는다', () => {
  assert.deepEqual(semantic.finalValidationWarnings({ ran: true, pass: true }, { status: 'pass' }), []);
  assert.deepEqual(semantic.finalValidationWarnings({ ran: false, pass: true }, { status: 'skipped' }), []);
  assert.equal(semantic.finalValidationWarnings({ ran: true, pass: true }, { status: 'unknown' })[0].code, 'semantic_validation_unconfirmed');
});
