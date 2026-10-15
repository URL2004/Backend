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
const statisticalSupport = { version:'statistical-assist-v5-whitespace-stable', modelVersion:'korean-style-statistics-v1',
  applied:true, originalScore:18, score:49, margin:0.2, features:300, profile:'general', basis:'independent_statistics' };
test('weak sentence causes plus independent statistics explain their distinct scopes without rescoring', () => {
  const signalEvidence = [{...signal(),strength:'weak'}];
  const r = build({...standard,probability:49,signalEvidence,statisticalSupport});
  assert.equal(r.score,49); assert.equal(r.evidence.level,'some');
  assert.ok(r.limitations.some(s=>s.includes('18점에서 반영 후 49점')));
  assert.match(r.description,/문체 통계/); assert.match(r.evidence.reason,/문장별 근거만으로/);
  assert.notEqual(build({...standard,probability:49,signalEvidence}).evidence.level,'sufficient');
  assert.doesNotMatch(build({...standard,probability:49,signalEvidence,statisticalSupport:{...statisticalSupport,score:48}}).description,/통계 신호가 함께/);
});

test('statistics and history adjustment remain distinct without changing either score',()=>{
 const r=build({...standard,probability:29,calibrationApplied:true,preCalibrationProbability:49,
   statisticalSupport,statisticalReference:{basis:'independent_statistics',scoreApplied:false}});
 assert.equal(r.score,29);
 assert.ok(r.limitations.some(s=>s.includes('18점에서 반영 후 49점')&&s.includes('이력 보정')));
 assert.ok(r.limitations.some(s=>s.includes('참고용 추가 통계')));
});
test('report and trusted history fallback pass statistical explanation through', () => {
  const r = buildDetectReportView({probability:49,probSource:'llm',confidence:'high',textLength:1200,
    statisticalSupport,signalEvidence:[{...signal(),strength:'weak'}],
    measurements:{genericness:{count:0,total:12},detail:[{sents:12,specific:4,lived:1}]} });
  assert.match(r.interpretation.description,/문체 통계/);
  const {storedDetectInterpretation}=require('../lib/detectHistoryPresentation');
  const old = storedDetectInterpretation({probability:49,probSource:'llm',confidence:'high',statisticalSupport},'합성 문장이다. '.repeat(80));
  assert.match(old.description,/문체 통계/);
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
  assert.equal(r.evidence.level, 'some'); assert.equal(r.pattern, null);
  assert.match(r.description, /증명하는 결과는 아니/);
});
test('high score without located evidence cannot claim sufficient grounds or recurrence', () => {
  const r = build({ ...standard, probability: 85, signalEvidence: [{...signal(), locationStatus:'unlocated'}] });
  assert.equal(r.status, 'partial'); assert.equal(r.evidence.level, 'limited'); assert.equal(r.pattern, null);
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
  const item = { ...signal('lexical_template', [1,1,-1,30]), scope: 'isolated' };
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

test('interpretation backup supports old signatures and validates new assessability', () => {
  const crypto = require('node:crypto');
  const { signDetectInterpretation, verifiedBackupInterpretation } = require('../lib/detectHistoryPresentation');
  const inputText = 'A synthetic source. '.repeat(20), uid = 'test-reader', key = 'local-test-key-'.repeat(4);
  const current = build({ ...standard, probability: 16, textLength: inputText.length });
  const proof = signDetectInterpretation(uid, inputText, current, key);
  assert.equal(typeof proof, 'string');
  assert.deepEqual(verifiedBackupInterpretation(uid, { inputText, probability: 16, interpretation: current, interpretationProof: proof }, key), current);
  const legacy = { ...current, version: 'detect-interpretation-v1' }; delete legacy.assessability;
  const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
  const oldProof = 'detect-interpretation-proof-v1.' + crypto.createHmac('sha256', key).update(JSON.stringify([
    'detect-interpretation-proof-v1', uid, crypto.createHash('sha256').update(inputText).digest('hex'), 16, ordered(legacy)
  ])).digest('base64url');
  assert.deepEqual(verifiedBackupInterpretation(uid, { inputText, probability: 16, interpretation: legacy, interpretationProof: oldProof }, key), legacy);
  for (const assessability of [undefined, { status: 'human', meaning: 'confirmed' }, { ...current.assessability, extra: 'untrusted' }, { ...current.assessability, meaning: 'x'.repeat(1001) }]) {
    assert.equal(signDetectInterpretation(uid, inputText, { ...current, assessability }, key), null);
  }
});

test('recheck wording follows the recorded attempts, and absent diagnostics make no recheck claim', () => {
  const { resolveRecheckStatus } = require('../lib/detectInterpretation');
  const conflict = { status: 'conflict', reason: 'unsupported_high_score' };
  const primary = { phase: 'primary', modelScore: 62, confidence: 'medium' };
  const recheck = { phase: 'recheck', modelScore: 58, confidence: 'medium' };
  const diagnostics = extra => ({ version: 'detect-score-diagnostics-v1', recheckReason: 'none', recheckFailed: false,
    attempts: [primary], finalCandidateConsistency: conflict, ...extra });
  const cases = [
    ['not_attempted', diagnostics(), /추가 검사를 진행하지 않았고/u],
    ['completed', diagnostics({ recheckReason: 'cause_mismatch', attempts: [primary, recheck] }), /추가 검사 이후에도/u],
    ['failed', diagnostics({ recheckReason: 'cause_mismatch', recheckFailed: true,
      attempts: [primary, { phase: 'recheck', failed: true, failureCode: 'OPENAI_TIMEOUT' }] }), /추가 검사를 끝내지 못해/u],
    ['failed', diagnostics({ recheckReason: 'low_confidence', recheckFailed: true }), /추가 검사를 끝내지 못해/u],
    // The only successful call replaced a failed primary: nothing was compared.
    ['unknown', diagnostics({ recheckReason: 'primary_failed', attempts: [{ phase: 'primary', failed: true }, recheck] }), null],
    ['unknown', undefined, null], ['unknown', null, null], ['unknown', {}, null], ['unknown', { attempts: [] }, null],
    ['unknown', { attempts: [null, 'x'], recheckFailed: true }, null]
  ];
  const scores = new Set();
  for (const [status, detectDiagnostics, wording] of cases) {
    assert.equal(resolveRecheckStatus(detectDiagnostics), status);
    const r = build({ ...standard, probability: 62, signalEvidence: [signal()], finalCandidateConsistency: conflict, detectDiagnostics });
    const line = r.limitations.find(item => item.includes('점수와 근거의 연결을 완전히 확인하지 못했어요'));
    assert.ok(line, status);
    if (wording) assert.match(line, wording);
    else assert.doesNotMatch(JSON.stringify(r), /추가 검사/u);
    assert.equal(r.status, 'partial');
    scores.add(r.score);
  }
  assert.deepEqual([...scores], [62]);
  // Without a conflict the diagnostics never add a recheck sentence.
  assert.doesNotMatch(JSON.stringify(build({ ...standard, probability: 62, signalEvidence: [signal()],
    detectDiagnostics: diagnostics({ attempts: [primary, recheck] }) })), /추가 검사/u);
});

test('all six independent disclosures roundtrip in a bounded signed history backup', () => {
  const { signDetectInterpretation, verifiedBackupInterpretation } = require('../lib/detectHistoryPresentation');
  const inputText = '가'.repeat(800), key = 'synthetic-disclosure-key-'.repeat(3), uid = 'fixture';
  const interpretation = build({ ...standard, probability: 60, textLength: inputText.length, sentenceTotal: 4,
    signalEvidence: [], finalCandidateConsistency: { status: 'conflict' },
    statisticalSupport: { ...statisticalSupport, originalScore: 18, score: 60 },
    statisticalReference: { basis: 'independent_statistics', scoreApplied: false } });
  assert.equal(interpretation.limitations.length, 6);
  const proof = signDetectInterpretation(uid, inputText, interpretation, key);
  assert.equal(typeof proof, 'string');
  const entry = { inputText, probability: 60, interpretation, interpretationProof: proof };
  assert.deepEqual(verifiedBackupInterpretation(uid, entry, key), interpretation);
  const tooMany = { ...interpretation, limitations: [...interpretation.limitations, '추가 항목'] };
  assert.equal(signDetectInterpretation(uid, inputText, tooMany, key), null);
  assert.equal(verifiedBackupInterpretation(uid, { ...entry, interpretation: { ...interpretation, limitations: ['변조된 설명'] } }, key), null);
});
test('report view and stored history pass diagnostics through to the same recheck wording', () => {
  const conflict = { status: 'conflict', reason: 'unsupported_high_score' };
  const detectDiagnostics = { version: 'detect-score-diagnostics-v1', recheckReason: 'none', recheckFailed: false,
    attempts: [{ phase: 'primary', modelScore: 62, confidence: 'medium' }], finalCandidateConsistency: conflict };
  const input = { probability: 62, probSource: 'llm', confidence: 'medium', textLength: 1200, signalEvidence: [signal()],
    measurements: { genericness: { count: 0, total: 12 }, detail: [{ sents: 12, specific: 4, lived: 1 }] } };
  const legacy = buildDetectReportView({ ...input, finalCandidateConsistency: conflict });
  assert.doesNotMatch(JSON.stringify(legacy.interpretation), /추가 검사/u);
  const current = buildDetectReportView({ ...input, finalCandidateConsistency: conflict, detectDiagnostics });
  assert.ok(current.interpretation.limitations.some(item => /추가 검사를 진행하지 않았고/u.test(item)));
  assert.equal(current.interpretation.score, legacy.interpretation.score);
  const { storedDetectInterpretation, signDetectInterpretation } = require('../lib/detectHistoryPresentation');
  const text = '합성 문장이다. '.repeat(150);
  const stored = storedDetectInterpretation({ probability: 62, probSource: 'llm', confidence: 'medium', detectDiagnostics }, text);
  assert.ok(stored.limitations.some(item => /추가 검사를 진행하지 않았고/u.test(item)));
  assert.equal(typeof signDetectInterpretation('test-reader', text, stored, 'local-test-key-'.repeat(4)), 'string');
});
