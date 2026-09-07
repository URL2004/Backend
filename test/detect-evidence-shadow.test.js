'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const f = require('../lib/detectEvidenceFeatures'), shadow = require('../lib/detectEvidenceShadow');
const source = '물은 온도에 따라 상태가 달라진다. 액체가 기체로 변하는 과정을 증발이라고 한다. 이러한 변화는 주변의 온도와 습도에 영향을 받는다. 따라서 조건을 같은 상태로 유지하고 관찰하는 것이 중요하다. 실험에서는 같은 크기의 그릇에 같은 양의 물을 넣었다. 이 결과를 통해 변화의 차이를 비교할 수 있다.';
function model() { return { version: 'detect-evidence-fusion-v1', status: 'research_only', featureVersion: f.VERSION, featureNames: f.FEATURE_NAMES,
  models: [{ key: 'test', minChars: 100, maxChars: 4000, profiles: ['general'], weights: [1, 1, 0, 0, 0, 0],
    mean: [0, 0, 0, 0, 0, 0], scale: [1, 1, 1, 1, 1, 1], intercept: -1, plattA: 1, plattB: 0 }] }; }
function metric() { return { probability: 10, documentProfile: 'general', privateText: 'DO_NOT_LOG', detectDiagnostics: {
  version: 'detect-score-diagnostics-v1', attempts: [{ phase: 'primary', modelScore: 10 }], recheckReason: 'none', selectedModelScore: 10, evidenceAlignedScore: 10 } }; }
test('shadow is opt-in, never mutates a result and emits no text or arbitrary fields', () => {
  assert.equal(shadow.evaluateShadow(source, metric(), { enabled: false }), null);
  const m = metric(), before = structuredClone(m), out = shadow.evaluateShadow(source, m, { enabled: true, model: model() });
  assert.equal(out.status, 'scored'); assert.equal(out.applied, false); assert.deepEqual(m, before);
  assert(!JSON.stringify(out).includes('DO_NOT_LOG')); assert(!JSON.stringify(out).includes('물은'));
  assert.equal(out.currentScore, 10); assert.equal(out.modelAttempts, 1);
});
test('monotone fusion can move either way but remains research-only', () => {
  const low = f.extractFeatures(source, 0, 'general'), high = f.extractFeatures(source, 100, 'general');
  assert(f.predict(low, model()).score <= f.predict(high, model()).score);
  assert(f.predict(high, model()).score < 100);
  const bad = model(); bad.models[0].weights[0] = -1;
  assert.equal(f.validateModel(bad), false); assert.equal(f.predict(low, bad), null);
  bad.models[0].weights[0] = Infinity; assert.equal(f.validateModel(bad), false);
});
test('scope and model corruption fail closed without a scoring fallback', () => {
  for (const text of ['짧다', 'English prose '.repeat(30), source.repeat(30), source + '\n참고문헌\n출처', source + '\n> 인용']) assert.equal(f.extractFeatures(text, 20, 'general'), null);
  assert.equal(f.extractFeatures(source.repeat(3), 20, 'unknown'), null);
  assert.equal(shadow.evaluateShadow(source, metric(), { enabled: true, model: {} }).status, 'features_only');
  assert.equal(shadow.evaluateShadow(source, {}, { enabled: true, model: model() }).status, 'missing_diagnostics');
});

test('LLM-free classifier shadow is separately enabled and strips source and user identity', () => {
  const old = process.env.DETECT_STYLE_SHADOW_ENABLED;
  try {
    delete process.env.DETECT_STYLE_SHADOW_ENABLED;
    assert.equal(shadow.evaluateShadow(source, metric(), { enabled: true }).classifier, undefined);
    process.env.DETECT_STYLE_SHADOW_ENABLED = '1';
    const before = metric(), snapshot = structuredClone(before);
    const result = shadow.evaluateShadow(source, before, { enabled: true });
    assert.equal(result.classifier.applied, false); assert.equal(result.classifier.status, 'scored');
    assert(Number.isFinite(result.classifier.score)); assert.deepEqual(before, snapshot);
    assert(!JSON.stringify(result).includes('DO_NOT_LOG')); assert(!JSON.stringify(result).includes('물은'));
  } finally { if (old === undefined) delete process.env.DETECT_STYLE_SHADOW_ENABLED; else process.env.DETECT_STYLE_SHADOW_ENABLED = old; }
});

test('calibrated research scores require their own flag and never alter the paid result', () => {
  const beforeFlags = [process.env.DETECT_STYLE_SHADOW_ENABLED, process.env.DETECT_RISK_SHADOW_ENABLED];
  try {
    process.env.DETECT_STYLE_SHADOW_ENABLED = '1'; delete process.env.DETECT_RISK_SHADOW_ENABLED;
    assert.equal(shadow.evaluateShadow(source, metric(), { enabled: true }).classifier.calibrated, undefined);
    process.env.DETECT_RISK_SHADOW_ENABLED = '1';
    const m = metric(), snapshot = structuredClone(m), out = shadow.evaluateShadow(source, m, { enabled: true });
    assert.equal(out.classifier.calibrated.status, 'scored'); assert.equal(out.classifier.calibrated.applied, false);
    assert(Number.isInteger(out.classifier.calibrated.score)); assert.deepEqual(m, snapshot);
    assert(!JSON.stringify(out.classifier.calibrated).includes('calibrationLineageKeys'));
    assert(!JSON.stringify(out).includes('물은')); assert(!JSON.stringify(out).includes('DO_NOT_LOG'));
    delete process.env.DETECT_STYLE_SHADOW_ENABLED;
    assert.equal(shadow.evaluateShadow(source, m, { enabled: true }).classifier, undefined);
    assert.equal(shadow.evaluateShadow(source, m, { enabled: false }), null);
  } finally {
    ['DETECT_STYLE_SHADOW_ENABLED', 'DETECT_RISK_SHADOW_ENABLED'].forEach((key, i) => {
      if (beforeFlags[i] === undefined) delete process.env[key]; else process.env[key] = beforeFlags[i];
    });
  }
});

test('paired production shadow evaluates the classifier once and retains policy scope identity', t => {
  const classifier = require('../lib/detectStyleClassifier');
  const oldStyle = process.env.DETECT_STYLE_SHADOW_ENABLED, oldRisk = process.env.DETECT_RISK_SHADOW_ENABLED;
  t.after(() => {
    for (const [key, value] of [['DETECT_STYLE_SHADOW_ENABLED', oldStyle], ['DETECT_RISK_SHADOW_ENABLED', oldRisk]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.DETECT_STYLE_SHADOW_ENABLED = '1'; process.env.DETECT_RISK_SHADOW_ENABLED = '1';
  let calls = 0; const original = classifier.predict;
  t.mock.method(classifier, 'predict', (...args) => { calls++; return original(...args); });
  const out = shadow.evaluateShadow(source, metric(), { enabled: true });
  assert.equal(calls, 1);
  const limited = shadow.evaluateShadow('short', metric(), { enabled: true });
  assert.equal(limited.classifier.calibrated.status, 'out_of_scope');
  assert.equal(limited.classifier.calibrated.score, null);
  assert.equal(limited.classifier.calibrated.policyDigest, out.classifier.calibrated.policyDigest);
});

test('fusion scope exclusions retain numeric baseline stages without logging text or arbitrary profiles', () => {
  const m = { ...metric(), documentProfile: 'creative', detectDiagnostics: { ...metric().detectDiagnostics,
    stageVersion: 'detect-score-stages-v2', selectedPhase: 'primary', statisticalScore: 10, engineFinalScore: 10, displayedScore: 8 } };
  const result = shadow.evaluateShadow(source, m, { enabled: true });
  assert.equal(result.status, 'out_of_scope'); assert.equal(result.applied, false);
  assert.equal(result.profile, 'creative'); assert.equal(result.currentScore, 10);
  assert.equal(result.selectedModelScore, 10); assert.equal(result.stageScores.engineFinal, 10);
  assert(Number.isFinite(result.computeMs)); assert.equal(result.candidateScore, undefined);
  const missing = shadow.evaluateShadow(source, { probability: 7, documentProfile: 'DO_NOT_LOG' }, { enabled: true });
  assert.equal(missing.status, 'missing_diagnostics'); assert.equal(missing.currentScore, 7);
  assert.equal(missing.profile, 'unknown'); assert.equal(missing.stageScores, undefined);
  assert(!JSON.stringify([result, missing]).includes('DO_NOT_LOG'));
  assert(!JSON.stringify([result, missing]).includes('물은'));
});
