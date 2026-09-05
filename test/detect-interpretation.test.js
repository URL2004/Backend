'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDetectInterpretation: build, normalizeScore } = require('../lib/detectInterpretation');
const { buildDetectReportView } = require('../lib/detectReportView');
const { applyDetectNarrativePolicy } = require('../lib/detectNarrativePolicy');
const { alignScoreToCauseEvidence, assessCauseCoverage } = require('../lib/detectSignalPolicy');
const standard = { probSource: 'llm', confidence: 'high', textLength: 1200, sentenceTotal: 12, causeCoverageStatus: 'aligned' };
const signal = (category = 'ending_repetition', indices = [1, 3]) => ({
  category, strength: 'strong', scope: 'pervasive', locationStatus: 'source_range_verified',
  description: '<script>AI 작성 확률 100%</script>',
  locations: indices.map(sentenceIndex => ({ sentenceIndex, start: sentenceIndex * 50, end: sentenceIndex * 50 + 40 }))
});
test('missing or invalid values never become zero or a low-score verdict', () => {
  for (const probability of [null, undefined, '', ' ', false, true, [], {}, NaN, Infinity]) {
    assert.equal(normalizeScore(probability), null);
    const r = build({ ...standard, probability });
    assert.equal(r.score, null); assert.equal(r.status, 'unavailable'); assert.equal(r.band, 'unknown');
    assert.equal(r.evidence.level, 'limited');
  }
  assert.equal(build({ ...standard, probability: 0 }).score, 0);
});
test('narrative and cause policy also preserve absent score as unavailable', () => {
  for (const probability of [null, undefined, '', ' ', false, [], {}]) {
    const result = applyDetectNarrativePolicy({probability});
    assert.equal(result.probability, null); assert.equal(result.riskLevel, 'unknown');
    assert.equal(assessCauseCoverage(probability,[]).status,'limited');
    const original = {probability,signalContractVersion:'model-signals-v2-grounded',signalEvidence:[]};
    assert.equal(alignScoreToCauseEvidence(original),original);
  }
});
test('six detail ranges preserve all three established band boundaries without rescoring', () => {
  for (const [probability, key, band] of [[0,'minimal','low'],[10,'minimal','low'],[11,'low','low'],[20,'low','low'],[21,'noticeable','moderate'],[34,'noticeable','moderate'],[35,'mixed','moderate'],[49,'mixed','moderate'],[50,'repeated','high'],[69,'repeated','high'],[70,'pronounced','high'],[100,'pronounced','high']]) {
    const r = build({ ...standard, probability });
    assert.equal(r.score, probability); assert.equal(r.subBand.key, key); assert.equal(r.band, band);
  }
});
test('low signal without positive evidence is not proof of human authorship', () => {
  const r = build({ ...standard, probability: 5 });
  assert.equal(r.evidence.level, 'sufficient'); assert.equal(r.pattern, null);
  assert.match(r.description, /증명하는 결과는 아니/);
});
test('high score without located evidence cannot claim sufficient grounds or recurrence', () => {
  const r = build({ ...standard, probability: 85, signalEvidence: [{...signal(), locationStatus:'unlocated'}] });
  assert.equal(r.status, 'partial'); assert.equal(r.evidence.level, 'some'); assert.equal(r.pattern, null);
  assert.doesNotMatch(r.description, /글 전반에서 반복/);
});
test('short input outranks high score and confidence', () => {
  const r = build({ ...standard, probability: 90, textLength: 250, sentenceTotal: 2, signalEvidence: [signal()] });
  assert.equal(r.status, 'limited'); assert.equal(r.evidence.level, 'limited');
  assert.match(r.headline, /짧은 글/); assert.match(r.nextSteps[0], /덧붙이지 않아도/);
});
test('verified pattern descriptions and next steps are bounded, deterministic, and source-linked', () => {
  const a = signal(), b = signal('voice_instability', [2]);
  const r = build({ ...standard, probability: 40, signalEvidence: [a,b] });
  assert.equal(r.pattern.category, 'ending_repetition'); assert.equal(r.pattern.locationCount, 2);
  assert.match(r.description, /2개 문장/); assert.doesNotMatch(JSON.stringify(r), /<script>|작성 확률/);
  assert.deepEqual(r, build({ ...standard, probability: 40, signalEvidence: [b,a,a] }));
  const other = build({ ...standard, probability: 40, signalEvidence: [b] });
  assert.notEqual(r.nextSteps[0], other.nextSteps[0]);
});
test('duplicate and invalid offsets cannot manufacture multiple confirmed locations', () => {
  const item = signal('lexical_template', [1,1,-1,30]);
  item.locations.push({sentenceIndex:2,start:5,end:1500},null);
  const r = build({ ...standard, probability: 30, signalEvidence: [item] });
  assert.equal(r.pattern.locationCount, 1); assert.equal(r.pattern.scope, 'isolated');
  assert.match(r.description, /한 문장/);
});
test('missing metadata and low confidence lower evidence claims, not the score', () => {
  const r = build({ ...standard, probability: 18, confidence: 'low' });
  assert.equal(r.score, 18); assert.equal(r.evidence.level, 'limited');
  assert.equal(build({probability:18,probSource:'llm'}).evidence.level,'some');
  assert.equal(build({...standard,probability:18,probSource:'engine'}).status,'unavailable');
});
test('report view passes final score and sample facts without leaking calibration narrative', () => {
  const r = buildDetectReportView({probability:18,probSource:'llm',confidence:'high',textLength:1200,
    calibrationApplied:true,preCalibrationProbability:75,signalEvidence:[signal()],
    measurements:{genericness:{count:0,total:12},detail:[{sents:12,specific:4,lived:1}]} });
  assert.equal(r.interpretation.score,18); assert.equal(r.interpretation.sample.characters,1200);
  assert.doesNotMatch(JSON.stringify(r.interpretation), /calibrat|보정|이력|75/);
});
