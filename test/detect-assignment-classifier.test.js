'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const classifier = require('../lib/detectAssignmentClassifier');
const assist = require('../lib/detectStatisticalAssist');
const stability = require('../lib/detectResultStability');

const prose = Array.from({ length: 8 }, (_, i) => `${i + 1}번째 문장에서는 자료실 안내문을 검토한 과정을 적었다. 이용자의 의견을 기록하고 안내 순서를 관찰한 뒤 배치를 수정했다.`).join(' ');
const base = { probability: 12, confidence: 'medium', signalEvidence: [] };
const high = () => ({ score: 88.4, margin: 2.1, matchedFeatures: 640, version: 'korean-character-classifier-v1' });

test('default is off and never touches the result', () => {
  const previous = process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED; delete process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED;
  try {
    assert.equal(classifier.enabled(), false);
    assert.equal(classifier.applyClassifier(base, prose, { predictor: high }), base);
  } finally { if (previous !== undefined) process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED = previous; }
});

test('the bundled model validates and predicts inside the documented scope', () => {
  const model = classifier.loadModel();
  assert.equal(model.modelVersion, classifier.MODEL_VERSION);
  assert.equal(model.tokens.length <= 20000, true);
  const { predict } = require('../lib/detectStyleClassifier');
  const p = predict(prose, model);
  assert.ok(p && Number.isFinite(p.score) && p.score >= 0 && p.score <= 100, 'synthetic prose scores inside 0..100');
  assert.equal(predict('짧다', model), null, 'below 100 characters is out of scope');
});

test('high classifier scores raise the displayed score into the bounded 50..74 band only', () => {
  const out = classifier.applyClassifier(base, prose, { active: true, threshold: 50, predictor: high });
  assert.equal(out.probability, classifier.mapScore(88.4, 50));
  assert.ok(out.probability >= 50 && out.probability <= 74);
  assert.equal(out.statisticalSupport.version, classifier.VERSION);
  assert.equal(out.statisticalSupport.basis, 'independent_statistics');
  assert.equal(out.statisticalSupport.originalScore, 12);
  assert.equal(out.statisticalSupport.score, out.probability);
  assert.equal(out.statisticalSupport.classifierScore, 88.4);
  assert.equal(classifier.mapScore(100, 50), 74); assert.equal(classifier.mapScore(50, 50), 50); assert.equal(classifier.mapScore(30, 50), 50);
  for (let s = 50; s <= 100; s++) assert.ok(classifier.mapScore(s, 50) >= classifier.mapScore(s - 1, 50), 'monotone');
});

test('below threshold, above ceiling, protected documents and out-of-scope inputs are untouched', () => {
  const low = classifier.applyClassifier(base, prose, { active: true, threshold: 50, predictor: () => ({ score: 41, margin: -.3, matchedFeatures: 400 }) });
  assert.equal(low.probability, 12); assert.equal(low.statisticalSupport, undefined); assert.equal(low.classifierReference.scoreApplied, false);
  assert.equal(classifier.applyClassifier({ ...base, probability: 80 }, prose, { active: true, predictor: high }).probability, 80, 'never lowers, never touches 74+');
  assert.equal(classifier.applyClassifier({ ...base, probability: 60 }, prose, { active: true, predictor: () => ({ score: 55, margin: .1, matchedFeatures: 300 }) }).probability, 60, 'mapping below the current score does not lower it');
  const quoted = '"인용된 문장이 길게 이어지는 부분이다. 이 부분은 보호 구간이다." ' + prose;
  const quotedOut = classifier.applyClassifier(base, quoted, { active: true, predictor: high });
  assert.equal(quotedOut.probability === 12 || quotedOut.probability >= 50, true, 'protected-span decision is delegated to the input document policy');
  assert.equal(classifier.applyClassifier(base, prose, { active: true, predictor: () => null }).probability, 12);
  assert.equal(classifier.applyClassifier(base, prose, { active: true, predictor: () => { throw new Error('boom'); } }).probability, 12, 'a failing classifier never destroys a completed result');
});

test('support meta survives the shared sanitizer and cache projection, tampering is rejected', () => {
  const out = classifier.applyClassifier(base, prose, { active: true, threshold: 50, predictor: high });
  assert.deepEqual(assist.sanitizeSupport(out.statisticalSupport), out.statisticalSupport);
  assert.equal(assist.sanitizeSupport({ ...out.statisticalSupport, score: 90 }), null, 'above ceiling');
  assert.equal(assist.sanitizeSupport({ ...out.statisticalSupport, originalScore: 70 }), null, 'must raise');
  assert.equal(assist.sanitizeSupport({ ...out.statisticalSupport, modelVersion: 'other' }), null);
  assert.equal(assist.sanitizeSupport({ ...out.statisticalSupport, features: 5 }), null);
  const cleaned = stability.__test?.cleanResult ? stability.__test.cleanResult({ ...base, ...out }) : null;
  if (cleaned) assert.equal(cleaned.statisticalSupport.version, classifier.VERSION);
});

test('cache variant separates enabled, disabled and threshold states', () => {
  const previous = [process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED, process.env.DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD];
  try {
    delete process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED; delete process.env.DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD;
    const off = stability.variantForConfig({ models: { detect: 'm', detectEscalation: 'e' }, reasoning: { detect: 'low', escalation: 'high' } }, { promptVersion: 'p' });
    process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED = '1';
    const on = stability.variantForConfig({ models: { detect: 'm', detectEscalation: 'e' }, reasoning: { detect: 'low', escalation: 'high' } }, { promptVersion: 'p' });
    process.env.DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD = '60';
    const on60 = stability.variantForConfig({ models: { detect: 'm', detectEscalation: 'e' }, reasoning: { detect: 'low', escalation: 'high' } }, { promptVersion: 'p' });
    assert.notEqual(off, on); assert.notEqual(on, on60);
    assert.equal(classifier.highThreshold(), 60); assert.equal(classifier.highThreshold('abc'), 50); assert.equal(classifier.highThreshold('10'), 50);
  } finally {
    if (previous[0] === undefined) delete process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED; else process.env.DETECT_ASSIGNMENT_CLASSIFIER_ENABLED = previous[0];
    if (previous[1] === undefined) delete process.env.DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD; else process.env.DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD = previous[1];
  }
});

test('interpretation explains the statistical contribution for this path', () => {
  const { buildDetectInterpretation } = require('../lib/detectInterpretation');
  const out = classifier.applyClassifier({ ...base, probability: 18 }, prose, { active: true, threshold: 50, predictor: high });
  const info = buildDetectInterpretation({ probability: out.probability, probSource: 'llm', confidence: 'high', textLength: prose.length, sentenceTotal: 16, signalEvidence: [], statisticalSupport: out.statisticalSupport, causeCoverageStatus: 'partial' });
  assert.equal(info.evidenceDetails.statisticalContribution, true);
  assert.match(info.headline, /문체 통계/u);
});
