'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const input = require('../lib/detectInputDocument');
const { groundSignals, sourceSentences } = require('../lib/detectGrounding');
const confidence = require('../lib/detectConfidence');
const cause = { category: 'formulaic_transition', strength: 'strong', scope: 'pervasive' };

test('historical raw sentence features remain stable while active grounding uses canonical eligibility', () => {
  const text = '그는 “정확한 표현이다.”라고 말했다.';
  assert.deepEqual(sourceSentences(text).map(item => item.text), require('../engine/koreanText').splitSentences(text));
  assert.equal(sourceSentences(text).length, 1);
  assert.equal(input.buildDetectInputDocument(text).sentences.length, 3);
});

test('canonical source protects explicit document syntax while preserving numbered prose and exact CRLF offsets', () => {
  const text = ' \r\n# 분석 제목\r\n1. 실제 본문의 첫 관찰을 기록했다. 두 번째 관찰을 비교했다.\r\n\r\n> 인용문에서만 한 주장이다.\r\n| 구분 | 수치 |\r\n```\r\nconst claim = true;\r\n```\r\n참고문헌\r\n외부 자료의 설명이다.\r\n# 다음 본문\r\n세 번째 관찰을 기록했다. 네 번째 결론을 비교했다.  ';
  const document = input.buildDetectInputDocument(text);
  for (const sentence of document.sentences) assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
  const prose = document.sentences.filter(sentence => sentence.eligibleForDetection);
  assert.equal(document.eligibleSentenceCount, 4);
  assert.equal(prose.some(sentence => sentence.spanType === 'list_prose'), true);
  assert.deepEqual(new Set(document.protectedSpans.map(span => span.spanType)), new Set(['heading', 'quote', 'table', 'code', 'reference']));
  const evidence = groundSignals([{ ...cause, evidenceSentences: document.sentences.map(sentence => sentence.index) }], text);
  assert(evidence[0].locations.every(loc => document.sentences[loc.sentenceIndex].eligibleForDetection));
  assert.equal(confidence.limitConfidenceToSample({ probability: 41, confidence: 'high' }, text).confidence, 'medium');
});

test('protected-only text and quotation fragments never increase evidence sample sufficiency', () => {
  const quoted = Array.from({ length: 8 }, (_, index) => '> 인용 자료의 설명 ' + (index + 1) + '이다.').join('\n');
  assert.equal(input.buildDetectInputDocument(quoted).eligibleSentenceCount, 0);
  assert.equal(confidence.limitConfidenceToSample({ probability: 70, confidence: 'high' }, quoted).confidence, 'low');
  const empty = groundSignals([{ ...cause, evidenceSentences: [0, 1] }], quoted)[0];
  assert.equal(empty.scope, 'isolated'); assert.equal(empty.strength, 'weak'); assert.deepEqual(empty.locations, []);
  const text = '그는 “정확한 표현이다.”라고 말했다.';
  const document = input.buildDetectInputDocument(text);
  const eligible = document.sentences.filter(sentence => sentence.eligibleForDetection);
  assert.equal(eligible.length, 2, 'two editable fragments surround the quotation');
  assert.equal(document.eligibleSentenceCount, 1, 'fragments are one underlying sentence');
  assert.equal(groundSignals([{ ...cause, evidenceSentences: eligible.map(sentence => sentence.index) }], text)[0].scope, 'isolated');
});

test('pervasive evidence needs document spread without rejecting causes sharing the same valid locations', () => {
  const text = Array.from({ length: 9 }, (_, index) => '분석 항목 ' + (index + 1) + '의 결과를 비교했다.').map((s, i) => s + (i === 2 || i === 5 ? '\n\n' : ' ')).join('');
  const localized = groundSignals([{ ...cause, evidenceSentences: [0, 1] }], text)[0];
  assert.equal(localized.scope, 'recurring'); assert.equal(localized.strength, 'strong');
  const shared = groundSignals([cause, { ...cause, category: 'ending_repetition' }].map(item => ({ ...item, evidenceSentences: [0, 4, 8] })), text);
  assert.equal(shared.length, 2); assert(shared.every(item => item.scope === 'pervasive'));
  assert.equal(groundSignals([{ ...cause, evidenceSentences: [0, 1] }], '첫 관찰이다. 둘째 관찰이다.')[0].scope, 'pervasive');
});

test('reference context is outside all indexed sentences and cannot change offsets or sample count', () => {
  const text = '본문에서 실제 관찰을 기록했다.';
  const without = input.buildDetectModelInput(text);
  const withContext = input.buildDetectModelInput(text, { referenceContext: '앞 문장이다. 또 다른 앞 문장이다.' });
  assert.deepEqual(withContext.sentences, without.sentences);
  assert.equal(withContext.referenceContext, '앞 문장이다. 또 다른 앞 문장이다.');
  assert.equal(withContext.sentences.length, 1);
  assert.equal(input.buildDetectModelInput(text, { referenceContext: 'x'.repeat(1000) }).referenceContext.length, 300);
});

test('real detector sends canonical scope and does not recheck insufficient low-confidence samples', async t => {
  const client = require('../engine-gpt-prod/openaiClient');
  const saved = client.completeJson;
  const calls = [];
  client.completeJson = async options => { calls.push(options); return { model: options.model, usage: {}, json: { probability: 12, confidence: 'low', signals: [] } }; };
  const filename = require.resolve('../engine-gpt-prod'); delete require.cache[filename];
  let engine;
  try { engine = require('../engine-gpt-prod'); } finally { client.completeJson = saved; }
  t.after(() => delete require.cache[filename]);
  const text = '# 제목\n실제 분석할 관찰을 기록했다.';
  const result = await engine.detect({ text, referenceContext: '이전 문맥은 점수에서 제외한다.', allowLocalFallback: false,
    config: { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } } });
  assert.equal(calls.length, 1); assert.equal(result.probability, 12); assert.equal(result.confidence, 'low');
  assert.equal(result.detectDiagnostics.recheckReason, 'insufficient_sample');
  const payload = JSON.parse(require('../engine-gpt-prod/promptEnvelope').extractPromptDataSection(calls[0].user, 'DETECT_INPUT'));
  assert.equal(payload.version, input.DETECT_INPUT_DOCUMENT_VERSION);
  assert.equal(payload.referenceContext, '이전 문맥은 점수에서 제외한다.');
  assert.equal(payload.sentences.filter(sentence => sentence.eligibleForDetection).length, 1);
});

test('short sample guard still rechecks low-confidence scores inconsistent with grounded evidence', async t => {
  const client = require('../engine-gpt-prod/openaiClient');
  const saved = client.completeJson;
  const calls = [];
  client.completeJson = async options => {
    calls.push(options);
    return { model: options.model, usage: {}, json: { probability: calls.length === 1 ? 80 : 12, confidence: 'low', signals: [] } };
  };
  const filename = require.resolve('../engine-gpt-prod'); delete require.cache[filename];
  let engine;
  try { engine = require('../engine-gpt-prod'); } finally { client.completeJson = saved; }
  t.after(() => delete require.cache[filename]);
  const result = await engine.detect({ text: '실제로 분석할 관찰을 기록했다.', allowLocalFallback: false,
    config: { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } } });
  assert.equal(calls.length, 2); assert.equal(result.probability, 12);
  assert.equal(result.detectDiagnostics.recheckReason, 'cause_mismatch');
});
