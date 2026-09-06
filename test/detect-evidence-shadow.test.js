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
