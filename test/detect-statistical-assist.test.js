'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const assist = require('../lib/detectStatisticalAssist');

const source = Array.from({ length: 650 }, (_, i) => String.fromCharCode(0xac00 + i)).join('');
const features = Array.from({ length: 300 }, (_, i) => source.slice(i, i + 2));
const positiveModel = { features, idf: features.map(() => 1), weights: features.map(() => 1), intercept: 0, threshold: 0 };
const evidence = [{ category: 'formulaic_transition', strength: 'moderate', scope: 'recurring', locations: [{ sentenceIndex: 0 }, { sentenceIndex: 1 }] }];
const result = { probability: 32, signalEvidence: evidence, modelProbability: 32 };

test('statistical assistance requires enabled scope plus independent grounded model evidence', () => {
  const options = { profile: 'general', active: true, modelValue: positiveModel };
  const applied = assist.applyAssist(result, source, options);
  assert.equal(applied.probability, 74);
  assert.equal(applied.modelProbability, 32);
  assert.equal(applied.statisticalSupport.originalScore, 32);
  assert.equal(assist.applyAssist(result, source, { ...options, active: false }), result);
  for (const profile of ['resume_application', 'personal_essay', 'unknown']) assert.equal(assist.applyAssist(result, source, { ...options, profile }), result);
  for (const probability of [null, '32', NaN, 20, 50, 90]) {
    const input = { ...result, probability }; assert.equal(assist.applyAssist(input, source, options), input);
  }
  for (const text of ['짧은 글', source.repeat(5), 'english prose '.repeat(60)]) assert.equal(assist.applyAssist(result, text, options), result);
  for (const signalEvidence of [[], [{ ...evidence[0], strength: 'weak' }], [{ ...evidence[0], scope: 'isolated' }], [{ ...evidence[0], locations: [{ sentenceIndex: 0 }, { sentenceIndex: 0 }] }]]) {
    const input = { ...result, signalEvidence }; assert.equal(assist.applyAssist(input, source, options), input);
  }
});

test('negative statistics and failed optional model keep completed model result intact', () => {
  const negative = { ...positiveModel, weights: features.map(() => -1) };
  assert.equal(assist.applyAssist(result, source, { profile: 'general', active: true, modelValue: negative }), result);
  assert.equal(assist.applyAssist(result, source, { profile: 'general', active: true, modelValue: {} }), result);
  assert.equal(assist.enabled(''), false);
});

test('statistical metadata is closed and cache variants separate enable/disable states', t => {
  const value = assist.applyAssist(result, source, { profile: 'general', active: true, modelValue: positiveModel }).statisticalSupport;
  const clean = assist.sanitizeSupport({ ...value, text: 'secret', providerResponse: 'secret' });
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(assist.sanitizeSupport({ ...value, score: 90 }), null);
  const cache = require('../lib/detectResultStability');
  assert.deepEqual(cache.cleanResult({ ...result, statisticalSupport: value }).statisticalSupport, value);
  const previous = process.env.DETECT_STATISTICAL_ASSIST_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.DETECT_STATISTICAL_ASSIST_ENABLED; else process.env.DETECT_STATISTICAL_ASSIST_ENABLED = previous; });
  process.env.DETECT_STATISTICAL_ASSIST_ENABLED = '0'; const off = cache.variantForConfig({});
  process.env.DETECT_STATISTICAL_ASSIST_ENABLED = '1'; assert.notEqual(cache.variantForConfig({}), off);
});

test('report names combined analysis without inventing additional model causes or calibration badges', () => {
  const statisticalSupport = assist.applyAssist(result, source, { profile: 'general', active: true, modelValue: positiveModel }).statisticalSupport;
  const report = require('../lib/detectReportView').buildDetectReportView({ probability: 74, probSource: 'llm', statisticalSupport, signalEvidence: evidence, confidence: 'high', textLength: 650 });
  assert.equal(report.causeAnalysis.items.length, 1);
  assert.equal(report.causeAnalysis.status, 'partial');
  assert.equal(report.causeAnalysis.scoreBasis, 'model_and_style_statistics');
  assert.match(report.styleSignal.sourceLabel, /문체 통계/);
  assert.equal(report.styleSignal.calibrated, false);
});

test('actual detect finish preserves model and cause-stage scores when support changes delivery score', async t => {
  const client = require('../engine-gpt-prod/openaiClient'), originalClient = client.completeJson;
  client.completeJson = async options => ({ model: options.model, usage: {}, json: {
    probability: 32, confidence: 'high', signals: [{ category: 'formulaic_transition', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }]
  } });
  const enginePath = require.resolve('../engine-gpt-prod'); delete require.cache[enginePath];
  const engine = require('../engine-gpt-prod'); client.completeJson = originalClient;
  const originalAssist = assist.applyAssist;
  assist.applyAssist = (result, text, options) => originalAssist(result, text, { ...options, active: true, modelValue: positiveModel });
  t.after(() => { assist.applyAssist = originalAssist; delete require.cache[enginePath]; });
  const text = source.match(/.{1,65}/gu).join('. ') + '.';
  const output = await engine.detect({ text, documentProfile: { profile: 'general' }, config: { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } }, allowLocalFallback: false });
  assert.equal(output.probability, 74);
  assert.equal(output.modelProbability, 32);
  assert.equal(output.detectDiagnostics.evidenceAlignedScore, 32);
  assert.equal(output.detectDiagnostics.selectedModelScore, 32);
  assert.equal(output.statisticalSupport.originalScore, 32);
  assert.equal(output.signalEvidence.length, 1);
  assert.equal(output.gptMeta.escalated, false);
});
