'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDetectInputDocument: build } = require('../lib/detectInputDocument');
const { groundSignals } = require('../lib/detectGrounding');
const { buildDetectInterpretation } = require('../lib/detectInterpretation');
const { signDetectInterpretation, verifiedBackupInterpretation } = require('../lib/detectHistoryPresentation');
const { normalizeSignalEvidence } = require('../lib/detectSignalPolicy');

test('flattened table headers and nominal cells are not sentence rhythm evidence', () => {
  const text = '표 3. 두 실험 조건의 비교\r\n비교 항목\r\n첫 실험\r\n둘째 실험\r\n측정 시점\r\n실험 시작 전\r\n실험 종료 후\r\n관찰 내용을 충분히 모아 기록함\r\n\r\n표와 별도로 실제 관찰 과정을 자세히 설명한다.';
  const doc = build(text);
  const signals = groundSignals([{ category: 'sentence_uniformity', strength: 'moderate', scope: 'recurring', evidenceSentences: doc.sentences.map(s => s.index) }], text);
  const located = signals[0].locations.map(loc => text.slice(loc.start, loc.end));
  assert(!located.some(value => /비교 항목|첫 실험|측정 시점|실험 시작 전/.test(value)));
  assert(located.some(value => value.includes('기록함')));
  assert(located.some(value => value.includes('자세히 설명한다')));
  for (const sentence of doc.sentences) assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
});

test('short authored sentences, nominal poetry, numbered prose and quoted tables stay distinct', () => {
  for (const text of ['별빛\n낮은 바람\n고요한 밤', '표 3. 관찰 기록\n나는 직접 보았다.\n결과도 적었다.\n다시 확인했다.', '1. 첫 실험의 진행 과정을 기록했다.\n2. 다음 조건의 결과를 비교했다.']) {
    const doc = build(text);
    assert(doc.sentences.every(s => s.eligibleForDetection));
  }
  const text = '```\n표 3. 코드 속 자료\n항목\n조건\n결과\n```';
  assert.equal(build(text).eligibleSentenceCount, 0);
});

test('bare numeric PDF debris does not become a verified prose signal', () => {
  const text = '관찰한 자료를 다음 조건과 비교했다.\n\n2 ,\n\n관찰 결과는 다시 정리했다.';
  const doc = build(text);
  const debris = doc.sentences.find(s => s.text.trim() === '2 ,');
  assert(debris); assert.equal(debris.eligibleForDetection, false);
  assert.equal(groundSignals([{ evidenceSentences: [debris.index], strength: 'strong' }], text)[0].locations.length, 0);
});

test('explicit nominal numbered headings have the same eligibility with one or two newlines', () => {
  const title = '2.1. 관찰 자료와 두 실험 조건의 비교';
  const body = '첫 실험에서는 충분한 자료를 모았다. 다음 실험에서는 조건을 바꾸어 관찰했다.';
  const documents = ['\n', '\n\n', '\r\n'].map(gap => build(title + gap + body));
  for (const doc of documents) {
    assert.equal(doc.eligibleSentenceCount, 2);
    assert(doc.sentences.some(s => s.spanType === 'heading' && !s.eligibleForDetection));
    assert(doc.sentences.filter(s => s.eligibleForDetection).every(s => !s.text.includes(title)));
  }
  assert.equal(build('2. 관찰 자료의 차이를 비교했다.').eligibleSentenceCount, 1);
});

test('unlocated positive scores disclose limited evidence while retaining scores and signed v4 history', () => {
  const input = { probability: 53, probSource: 'llm', confidence: 'high', textLength: 1800, sentenceTotal: 20, signalEvidence: [] };
  const result = buildDetectInterpretation(input);
  assert.equal(result.score, 53); assert.equal(result.evidence.level, 'limited'); assert.match(result.evidence.reason, /문장 근거는 확인되지/);
  const old = { ...result, version: 'detect-interpretation-v4-style-score', evidence: { level: 'some', label: '분석 근거 일부', reason: '이전 저장 설명' } };
  const text = '가'.repeat(1800), key = 'synthetic-test-key-'.repeat(3);
  const proof = signDetectInterpretation('synthetic-user', text, old, key);
  assert(proof);
  assert.equal(verifiedBackupInterpretation('synthetic-user', { inputText: text, probability: 53, interpretation: old, interpretationProof: proof }, key).evidence.reason, '이전 저장 설명');
  const adjusted = buildDetectInterpretation({ ...input, probability: 32, calibrationApplied: true, preCalibrationProbability: 53 });
  assert.equal(adjusted.score, 32);
});

test('generic signal descriptions never repeat the word signal', () => {
  const evidence = normalizeSignalEvidence([{ category: 'other_observed_style', strength: 'weak', scope: 'isolated', evidenceSentences: [0] }]);
  assert.equal(evidence.length, 1); assert.doesNotMatch(evidence[0].description, /신호 신호/); assert.match(evidence[0].description, /문체 신호가/);
});

test('uncertain finite endings after table rows stay eligible instead of being silently excluded', () => {
  const text = '표 4. 합성 자료 비교\n비교 항목\n첫 조건\n둘째 조건\n관찰 결과의 정확도가 예상보다 높다\n다음 분석에서는 차이를 다시 살펴본다';
  const doc = build(text);
  assert(doc.sentences.some(s => s.eligibleForDetection && s.text.includes('정확도가 예상보다 높다')));
  assert(doc.sentences.some(s => s.eligibleForDetection && s.text.includes('다시 살펴본다')));
});

test('flattened table protection stops before complete or wrapped authored prose', () => {
  const header = '표 3. 실험 조건의 비교\n비교 항목\n첫 실험\n둘째 실험';
  for (const body of [
    '서로 다른 조건에서 나타난 결과를 비교해 보았다\n새로운 관찰 기준도 직접 만들어 봤다',
    '자료에서 두 조건의 차이가 보인다\n관찰 기준에 대한 의문도 남아요',
    '두 실험 조건을 자세하게 관찰했다.\n그 과정에서 우리는\n예상과 다른 변화를 기록했다.',
    '그 과정에서 우리는\n예상과 다른 변화를 기록했다.'
  ]) {
    for (const newline of ['\n', '\r\n', '\r']) {
      const text = (header + '\n' + body).replace(/\n/gu, newline);
      const bodyStart = text.indexOf(body.split('\n')[0]);
      const doc = build(text);
      assert(doc.protectedSpans.some(span => span.spanType === 'table'));
      assert(doc.protectedSpans.every(span => span.end <= bodyStart));
      assert(doc.sentences.filter(sentence => sentence.start >= bodyStart).every(sentence => sentence.eligibleForDetection));
      for (const sentence of doc.sentences) assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
    }
  }
  const nouns = build('표 3. 관찰 대상\n높은 산\n넓은 바다\n주요 항목');
  assert(nouns.eligibleSentenceCount > 0, 'ambiguous 다/요 endings abstain from excluding prose');
});

test('quoted or fenced captions cannot exclude prose outside their syntax owner', () => {
  const table = '표 3. 실험 조건의 비교\n비교 항목\n첫 실험\n둘째 실험';
  const body = '서로 다른 조건에서 나타난 결과를 비교해 보았다';
  for (const wrapper of [
    '```\n' + table + '\n```',
    '~~~\n' + table + '\n~~~',
    '“외부 자료는 다음과 같다.\n' + table + '\n”'
  ]) {
    const text = wrapper + '\n' + body;
    const doc = build(text);
    assert(!doc.protectedSpans.some(span => span.spanType === 'table'));
    assert(doc.sentences.some(sentence => sentence.text === body && sentence.eligibleForDetection));
    for (const sentence of doc.sentences) assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
  }
});

test('a flattened table witness cannot bridge a blank paragraph or another structure', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = ['표 3. 실험 조건의 비교', '', '비교 항목', '첫 실험', '둘째 실험'].join(newline);
    assert(!build(text).protectedSpans.some(span => span.spanType === 'table'));
  }
  const source = '표 3. 실험 조건의 비교\n비교 항목\n첫 실험\n둘째 실험\n> 외부 인용은 별도로 기록했다.\n작성자가 관찰한 과정을 비교해 보았다';
  assert(build(source).sentences.some(sentence => sentence.text === '작성자가 관찰한 과정을 비교해 보았다' && sentence.eligibleForDetection));
});

test('letter-containing prose is not numeric debris and numbered unpunctuated prose stays eligible', () => {
  const foreign = build('研究結果如下。\nЭто самостоятельное предложение.\n日本語の文章を確認します。');
  assert.equal(foreign.eligibleSentenceCount, 3);
  assert(foreign.sentences.every(sentence => sentence.eligibleForDetection));
  for (const text of ['1. 관찰 조건을 비교해 보았다', '2. 관찰한 내용을 간단히 기록함', '3. 결과의 차이가 분명하게 보인다']) {
    assert(build(text).sentences.every(sentence => sentence.eligibleForDetection));
  }
});
