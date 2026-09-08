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
  for (const probability of [null, '32', NaN, 20, 74, 90]) {
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

test('independent statistics require stronger evidence and preserve the model score and cause list', () => {
  const prose = Array.from({ length: 5 }, (_, i) => source.slice(i * 120, (i + 1) * 120) + '.').join(' ');
  const low = { probability: 8, confidence: 'high', signalEvidence: [], modelProbability: 8 };
  const options = { profile: 'general', active: true, independentActive: true, modelValue: positiveModel };
  const out = assist.applyAssist(low, prose, options);
  assert.equal(out.probability, 74);
  assert.equal(out.modelProbability, 8);
  assert.deepEqual(out.signalEvidence, []);
  assert.equal(out.statisticalSupport.basis, 'independent_statistics');
  assert.equal(out.statisticalSupport.originalScore, 8);
  for (const patch of [{ active: false }, { independentActive: false }, { profile: 'resume_application' }, { profile: 'unknown' }]) {
    assert.equal(assist.applyAssist(low, prose, { ...options, ...patch }), low);
  }
  const limited = { ...low, confidence: 'low' };
  assert.equal(assist.applyAssist(limited, prose, options), limited);
  for (const text of [source, prose.slice(0, 499), prose.repeat(5), '> ' + prose, '| ' + prose, '참고문헌\n' + prose, '“' + prose + '”', '“' + prose.replaceAll('.', '.\n') + '”']) {
    assert.equal(assist.applyAssist(low, text, options), low);
  }
  const weak = { ...positiveModel, weights: features.map(() => 0), intercept: 0.049 };
  assert.equal(assist.applyAssist(low, prose, { ...options, modelValue: weak }), low);
  assert.equal(assist.applyAssist(low, prose, { ...options, modelValue: { ...weak, intercept: 0.05 } }).probability, 51);
  assert.equal(assist.independentEnabled(''), false);
  assert.equal(assist.independentEnabled('true'), true);
});

test('independent support remains explicit internally and never fabricates sentence-level causes', t => {
  const meta = { version: assist.VERSION, applied: true, originalScore: 8, score: 54, margin: 0.16, features: 300, profile: 'general', basis: 'independent_statistics' };
  assert.equal(assist.sanitizeSupport({ ...meta, margin: 0.01 }), null);
  assert.equal(assist.sanitizeSupport({ ...meta, version: 'statistical-assist-v1' }), null);
  const legacy = { version: 'statistical-assist-v1', applied: true, originalScore: 32, score: 54, margin: 0.16, features: 300, profile: 'general' };
  assert.equal(assist.sanitizeSupport(legacy).version, 'statistical-assist-v1');
  const report = require('../lib/detectReportView').buildDetectReportView({ probability: 54, probSource: 'llm', statisticalSupport: meta, signalEvidence: [], confidence: 'high', textLength: 650 });
  assert.equal(report.causeAnalysis.items.length, 0);
  assert.equal(report.causeAnalysis.status, 'partial');
  assert.equal(report.causeAnalysis.scoreBasis, 'style_statistics');
  assert.doesNotMatch(report.causeAnalysis.label, /모델이 확인한|보정/);
  const previous = process.env.DETECT_INDEPENDENT_STATISTICS_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.DETECT_INDEPENDENT_STATISTICS_ENABLED; else process.env.DETECT_INDEPENDENT_STATISTICS_ENABLED = previous; });
  const cache = require('../lib/detectResultStability');
  process.env.DETECT_INDEPENDENT_STATISTICS_ENABLED = '0'; const off = cache.variantForConfig({});
  process.env.DETECT_INDEPENDENT_STATISTICS_ENABLED = '1'; assert.notEqual(cache.variantForConfig({}), off);
  assert.deepEqual(cache.cleanResult({ probability: 54, statisticalSupport: meta }).statisticalSupport, assist.sanitizeSupport(meta));
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

test('fixed statistical evidence yields monotone scores across 49/50 and the entire score range', () => {
  const prose = source.match(/.{1,65}/gu).join('. ') + '.';
  for (const independentActive of [false, true]) {
    const values = Array.from({ length: 101 }, (_, probability) => assist.applyAssist({ probability, confidence: 'high', signalEvidence: evidence }, prose,
      { profile: 'general', active: true, independentActive, modelValue: positiveModel }).probability);
    assert.equal(values[49], 74); assert.equal(values[50], 74); assert.equal(values[74], 74); assert.equal(values[75], 75);
    assert(values.every((value, index) => !index || value >= values[index - 1]));
  }
  const supported = assist.applyAssist({ ...result, probability: 60 }, prose, { profile: 'general', active: true, modelValue: positiveModel });
  assert.equal(assist.sanitizeSupport(supported.statisticalSupport).originalScore, 60);
  assert.equal(assist.sanitizeSupport({ ...supported.statisticalSupport, version: 'statistical-assist-v2' }), null, 'legacy support cannot claim a new policy');
});

test('both statistical branches reject protected input rather than treating model locations as permission', () => {
  const prose = source.match(/.{1,65}/gu).join('. ') + '.';
  for (const text of ['> ' + prose, '| ' + prose, '# 제목\n' + prose, '참고문헌\n' + prose, '```\n' + prose + '\n```', '“' + prose + '”']) {
    for (const signalEvidence of [[], evidence]) {
      const original = { probability: 32, confidence: 'high', signalEvidence };
      assert.equal(assist.applyAssist(original, text, { profile: 'general', active: true, independentActive: true, modelValue: positiveModel }), original);
    }
  }
});
