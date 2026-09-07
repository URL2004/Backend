'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const risk = require('../lib/detectRiskCalibration');
const classifier = require('../lib/detectStyleClassifier');
const { sha } = require('../lib/detectBenchmark');
const model = require('../engine-gpt-prod/models/detect-style-classifier-v1.json');
const rows = Array.from({ length: 200 }, (_, i) => ({ id: 'risk-' + i, group: 'risk-family-' + i,
  normalizedSha256: sha('risk-text-' + i), lineageKeys: ['risk-lineage-' + i], split: 'development',
  authorship: 'human_reference', labelQuality: 'source_backed', genre: 'explainer',
  permissions: { evaluate: true, derive: true }, margin: i / 200 }));

test('rank accounts for uncertainty rather than taking the empirical 95th percentile', () => {
  assert.equal(risk.selectRank(58, .05, .05), null);
  assert.equal(risk.selectRank(59, .05, .05).ascendingRank, 59);
  const r = risk.selectRank(200, .05, .05);
  assert.ok(r.allowedExceedances < 10);
  assert.ok(r.bound <= .05);
  assert.throws(() => risk.selectRank(0, .05, .05));
});
test('repeated documents from one family do not increase calibration evidence', () => {
  const base = risk.fitCalibration(rows, model), copies = rows.map(r => ({ ...r, id: r.id + '-copy' }));
  const repeated = risk.fitCalibration([...rows, ...copies], model);
  assert.equal(repeated.familyCount, base.familyCount);
  assert.equal(repeated.cutoffMargin, base.cutoffMargin);
  assert.equal(repeated.documentCount, 400);
});
test('calibration rejects training leakage, AI labels, consumed final labels and missing provenance', () => {
  for (const change of [{ split: 'holdout' }, { authorship: 'ai' }, { margin: NaN },
    { lineageKeys: [] }, { permissions: { evaluate: true } }, { normalizedSha256: model.trainingTextHashes[0] }]) {
    assert.throws(() => risk.fitCalibration([{ ...rows[0], ...change }, ...rows.slice(1)], model));
  }
});
test('model/policy binding and validation aliases cannot be bypassed by changing family ids', () => {
  const p = risk.fitCalibration(rows, model);
  assert.equal(risk.validatePolicy(p, model), true);
  assert.equal(risk.validatePolicy({ ...p, cutoffMargin: 0 }, model), false);
  assert.equal(risk.validatePolicy(p, { ...model, intercept: model.intercept + 1 }), false);
  const fresh = { ...rows[0], id: 'validation', group: 'new-group', split: 'holdout', priorExposure: false };
  assert.throws(() => risk.assertIndependentValidation(p, model, [fresh]));
  assert.doesNotThrow(() => risk.assertIndependentValidation(p, model, [{ ...fresh,
    normalizedSha256: sha('unseen'), lineageKeys: ['unseen'] }]));
});
test('strict tie policy and integer display preserve the selected operating point', () => {
  const text = '이 문장은 한국어 설명 자료를 이용한 점수 경계 검사입니다. '.repeat(10);
  const raw = classifier.predict(text, model);
  const p = risk.fitCalibration(rows, model);
  const at = margin => { const { digest, ...body } = { ...p, cutoffMargin: margin }; return { ...body, digest: sha(JSON.stringify(body)) }; };
  assert.equal(risk.predict(text, model, at(raw.margin)).score, 49);
  assert.equal(risk.predict(text, model, at(raw.margin)).positive, false);
  assert.equal(risk.predict(text, model, at(raw.margin + 1e-7)).score, 49);
  assert.equal(risk.predict(text, model, at(raw.margin - 1e-7)).score, 50);
  assert.equal(risk.predict('short', model, p), null);
  assert.equal(risk.predict(text, model, { ...p, digest: 'tampered' }), null);
});

test('prepared predictor reuses one inference and isolates later caller mutations', t => {
  const text = '한국어 자료의 문장과 표현을 살펴보며 관찰한 내용을 비교한다. '.repeat(12);
  const inputModel = structuredClone(model), policy = risk.fitCalibration(rows, inputModel);
  const expectedRaw = classifier.predict(text, inputModel), expected = risk.predict(text, inputModel, policy);
  const prepared = risk.createPredictor(inputModel, policy);
  inputModel.weights.fill(0); inputModel.intercept = 999; policy.cutoffMargin = 999;
  let calls = 0;
  const original = classifier.predict;
  t.mock.method(classifier, 'predict', (...args) => { calls++; return original(...args); });
  const actual = prepared.predict(text);
  assert.equal(calls, 1);
  assert.deepEqual(actual.raw, expectedRaw);
  assert.deepEqual(actual.calibrated, expected);
  assert.equal(prepared.policyDigest, expected.policyDigest);
  assert.equal(prepared.modelDigest, sha(JSON.stringify(model)));
  assert.deepEqual(prepared.predict('short'), { raw: null, calibrated: null });
  assert.throws(() => risk.createPredictor(model, { ...policy, digest: 'tampered' }), /invalid_policy/);
});
