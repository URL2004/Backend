'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const rubric = require('../engine-gpt-prod/prompts/detectRubric');
const { summarizeEvents } = require('../lib/detectEvidenceMonitoring');
const { evaluateHumanizePairs } = require('../lib/detectEvaluation');
test('rubric keeps paragraph structure in prose experiment and grounds ratings', () => {
  const text = '첫 문장을 기록한다.\n\n다음 문단을 기록한다.';
  assert.equal(JSON.parse(rubric.buildInput(text, 'prose')).originalProse, text);
  assert.equal(JSON.parse(rubric.buildInput(text)).originalProse, undefined);
  const value = { dimensions: rubric.DIMENSIONS.map(category => ({ category, rating: 0, evidenceSentences: [] })) };
  assert.equal(rubric.validateRatings(value, 2).length, 7);
  value.dimensions[0].rating = 2; value.dimensions[0].evidenceSentences = [0];
  assert.throws(() => rubric.validateRatings(value, 2), /unlocated/);
  value.dimensions[0].evidenceSentences = [0, 2]; assert.throws(() => rubric.validateRatings(value, 2), /invalid_evidence/);
  value.dimensions[0].evidenceSentences = [0, 1]; assert.equal(rubric.validateRatings(value, 2)[0].rating, 2);
});
test('monitoring separates replay, real cache hits and the diagnostic denominator', () => {
  const fresh = { event: 'detect_report.score_outcome', fields: { requestId: 'a', detectorVersion: 'v1', probability: 54, scoreSource: 'llm', detectCacheHit: false,
    detectDiagnostics: { selectedModelScore: 8, evidenceAlignedScore: 8 }, text: 'PRIVATE' } };
  const out = summarizeEvents([fresh, fresh, { ...fresh, fields: { ...fresh.fields, requestId: 'b', scoreSource: 'cached_llm', detectCacheHit: true, detectDiagnostics: undefined } },
    { event: 'detect_report.idempotent_replay', fields: { clientRequestId: 'a', scoreSource: 'request_replay' } }]);
  const g = out.groups.find(r => r.event === 'detect_report.score_outcome');
  assert.equal(g.n, 2); assert.equal(g.diagnosed, 1); assert.equal(g.actualCacheHits, 1); assert.equal(g.capped, 0);
  assert(!JSON.stringify(out).includes('PRIVATE'));
});
test('humanization comparisons reject history correction, version changes and unverified fidelity', () => {
  const row = { id: 'pair', beforeScore: 34, afterScore: 42, detectorBefore: 'v1', detectorAfter: 'v1', historyCalibrationExcluded: true, contentPreserved: true };
  assert.equal(evaluateHumanizePairs([row]).bySourceBand.mixed.meanDelta, 8);
  assert.equal(evaluateHumanizePairs([{ ...row, detectorAfter: 'v2' }]).valid, 0);
  assert.equal(evaluateHumanizePairs([{ ...row, contentPreserved: undefined }]).valid, 0);
  assert.equal(evaluateHumanizePairs([{ ...row, historyCalibrationExcluded: false }]).valid, 0);
});
