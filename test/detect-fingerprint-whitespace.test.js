'use strict';

// 2026-10-09 운영 점검 F-16 회귀: 같은 글이 앞뒤 공백 차이만으로 감지 캐시를 빗나가 다른 점수를 받던 문제.
// 아래 글은 지어낸 것이다(사용자 글 아님).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const stability = require('../lib/detectResultStability');
const { buildDetectInputDocument, locatePublicEvidence } = require('../lib/detectInputDocument');
const { groundSignals } = require('../lib/detectGrounding');

const UID = 'detect-fingerprint-user';
const CORE = [
  '1. 책의 핵심 문제',
  '',
  '이 글은 지어낸 독서 감상문이다. 글쓴이는 낯선 모임에 처음 들어간 사람이 규칙을 익히는 과정을 다룬다.',
  '처음에는 모든 것이 어색했다. 인사하는 법도 달랐고, 자리에 앉는 순서도 정해져 있었다.',
  '',
  '2. 느낀 점',
  '',
  '나는 이 대목을 읽으며 전학 온 첫날을 떠올렸다. 그날 급식 줄에서 한참을 망설였다.',
  '그래서 새로 온 사람에게 먼저 말을 거는 일이 얼마나 큰 도움인지 알게 되었다.'
].join('\n');

const VARIANTS = {
  '그대로': CORE,
  '맨 앞 줄바꿈': `\n${CORE}`,
  '맨 끝 줄바꿈': `${CORE}\n`,
  '앞뒤 공백과 CRLF': ` \n\n${CORE} \r\n`,
  '맨 앞 BOM': `﻿${CORE}\n\n`
};

function variant() {
  return stability.variantForConfig({
    models: { detect: 'primary-test', detectEscalation: 'recheck-test' },
    reasoning: { detect: 'low', escalation: 'high' }
  }, { detectorVersion: 'test-detect', promptVersion: 'test-prompt' });
}

function signalsFor(source) {
  const eligible = buildDetectInputDocument(source).sentences.filter(sentence => sentence.eligibleForDetection);
  assert.ok(eligible.length >= 4, '근거로 쓸 문장이 부족하다');
  return [{
    category: 'ending_repetition',
    strength: 'strong',
    scope: 'recurring',
    evidenceSentences: [eligible[0].index, eligible[2].index, eligible.at(-1).index]
  }];
}

// 검출기가 만드는 결과와 같은 모양: 근거 좌표는 앞뒤 공백을 뗀 글 기준이다(engine-gpt-prod detectInternal).
function detectorResult(submitted, probability) {
  const scored = String(submitted).trim();
  return {
    probability,
    summary: '문체 신호가 일부 관찰됐어요.',
    detail: '종결 표현의 반복을 확인했어요.',
    signals: [],
    signalEvidence: groundSignals(signalsFor(scored), scored),
    signalContractVersion: 'model-signals-v2-grounded',
    confidence: 'medium',
    gptMeta: { selectedModel: 'primary-test', engine: 'test-detect', detectPromptVersion: 'test-prompt', escalated: false }
  };
}

test.beforeEach(() => stability.resetForTests());

test('F-16 앞뒤 공백만 다른 같은 글은 같은 캐시 지문을 쓴다', () => {
  const base = stability.payloadFingerprint({ text: CORE, lang: 'ko' });
  for (const [label, text] of Object.entries(VARIANTS)) {
    assert.equal(stability.payloadFingerprint({ text, lang: 'ko' }), base, label);
  }
  // 본문 안쪽 차이는 검출기 입력과 근거 좌표를 바꾸므로 다른 글이다.
  assert.notEqual(stability.payloadFingerprint({ text: CORE.replace('어색했다. 인사', '어색했다.  인사') }), base);
  assert.notEqual(stability.payloadFingerprint({ text: CORE.replace(/\n/g, '\r\n') }), base);
  assert.notEqual(stability.payloadFingerprint({ text: CORE.replace('급식 줄', '급식줄') }), base);
  assert.notEqual(stability.payloadFingerprint({ text: CORE, lang: 'en' }), base);
  assert.notEqual(stability.payloadFingerprint({ text: CORE, referenceContext: '앞 문맥이다.' }), base);
});

test('F-16 지문 규칙이 바뀌었으므로 이전 규칙으로 만든 지문과는 겹치지 않는다', () => {
  assert.notEqual(stability.PAYLOAD_FINGERPRINT_VERSION, 'detect-raw-input-v1');
  const previousRule = text => crypto.createHash('sha256').update(JSON.stringify({
    version: 'detect-raw-input-v1', text, lang: 'ko', referenceContext: ''
  }), 'utf8').digest('hex');
  for (const text of Object.values(VARIANTS)) {
    assert.notEqual(stability.payloadFingerprint({ text, lang: 'ko' }), previousRule(text));
  }
});

test('F-16 맨 앞 줄바꿈이 맨 끝으로 옮겨 간 재검사는 모델을 다시 부르지 않고 같은 점수를 받는다', async () => {
  const options = { firestore: null, hmacSecret: '', now: 10_000 };
  const first = VARIANTS['맨 앞 줄바꿈'];
  const again = VARIANTS['맨 끝 줄바꿈'];
  assert.equal(first.length, again.length);
  assert.notEqual(first, again);
  const key = text => ({ uid: UID, payloadFingerprint: stability.payloadFingerprint({ text, lang: 'ko' }), cacheVariant: variant() });

  const live = await stability.getOrCompute(key(first), async () => detectorResult(first, 17), options);
  const cached = await stability.getOrCompute(key(again), async () => assert.fail('앞뒤 공백만 다른 같은 글을 다시 채점했다'), { ...options, now: 400_000 });
  assert.equal(live.cacheHit, false);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.result.probability, 17);

  // 다른 사용자, 본문이 다른 글은 섞이지 않는다.
  let calls = 0;
  await stability.getOrCompute({ ...key(again), uid: 'another-user' }, async () => { calls += 1; return detectorResult(again, 24); }, options);
  await stability.getOrCompute(key(again.replace('급식 줄', '급식줄')), async () => { calls += 1; return detectorResult(again, 24); }, options);
  assert.equal(calls, 2);
});

test('F-16 캐시에서 꺼낸 근거 좌표를 현재 원문으로 옮기면 새로 계산한 결과와 같고 문장이 어긋나지 않는다', async () => {
  const options = { firestore: null, hmacSecret: '', now: 10_000 };
  const key = text => ({ uid: UID, payloadFingerprint: stability.payloadFingerprint({ text, lang: 'ko' }), cacheVariant: variant() });
  for (const [storedLabel, stored] of Object.entries(VARIANTS)) {
    stability.resetForTests();
    await stability.getOrCompute(key(stored), async () => detectorResult(stored, 33), options);
    for (const [requestLabel, requested] of Object.entries(VARIANTS)) {
      const label = `${storedLabel} → ${requestLabel}`;
      const hit = await stability.getOrCompute(key(requested), async () => assert.fail(`${label}: 캐시가 빗나갔다`), options);
      // 라우트가 요청마다 하는 좌표 옮김(routes/detectreport.js)과 같은 호출이다.
      const fromCache = locatePublicEvidence(hit.result.signalEvidence, requested);
      const fromLive = locatePublicEvidence(detectorResult(requested, 33).signalEvidence, requested);
      const coordinates = evidence => evidence.map(item => item.locations.map(loc => [loc.sentenceIndex, loc.start, loc.end]));
      assert.deepEqual(coordinates(fromCache), coordinates(fromLive), label);
      assert.equal(fromCache[0].locationStatus, 'source_range_verified', label);
      assert.equal(fromCache[0].locations.length, 3, label);
      const sentences = buildDetectInputDocument(requested).sentences;
      for (const loc of fromCache[0].locations) {
        assert.equal(requested.slice(loc.start, loc.end), sentences[loc.sentenceIndex].text, label);
      }
    }
  }
});

test('F-16 검출기는 앞뒤 공백을 뗀 글을 모델에 보내고 근거 좌표도 그 글 기준으로 만든다', async t => {
  // 지문이 앞뒤 공백을 떼는 근거가 이 동작이다. 검출기가 원문을 떼지 않고 채점하도록 바뀌면 이 테스트가 깨지고,
  // 그때는 lib/detectResultStability.js의 지문 규칙도 함께 고쳐야 한다.
  const client = require('../engine-gpt-prod/openaiClient');
  const saved = client.completeJson;
  const calls = [];
  client.completeJson = async options => {
    calls.push(options);
    return { model: options.model, usage: {}, json: { probability: 30, confidence: 'medium', signals: signalsFor(CORE) } };
  };
  const filename = require.resolve('../engine-gpt-prod');
  delete require.cache[filename];
  let engine;
  try { engine = require('../engine-gpt-prod'); } finally { client.completeJson = saved; }
  t.after(() => delete require.cache[filename]);
  const { extractPromptDataSection } = require('../engine-gpt-prod/promptEnvelope');
  const config = { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } };

  const outputs = {};
  const inputs = {};
  for (const [label, text] of Object.entries(VARIANTS)) {
    calls.length = 0;
    outputs[label] = await engine.detect({ text, allowLocalFallback: false, config });
    assert.ok(calls.length >= 1, label);
    inputs[label] = extractPromptDataSection(calls[0].user, 'DETECT_INPUT');
  }
  for (const label of Object.keys(VARIANTS)) {
    assert.equal(inputs[label], inputs['그대로'], `${label}: 모델에 보낸 글이 달라졌다`);
    assert.equal(outputs[label].probability, outputs['그대로'].probability, label);
    assert.deepEqual(outputs[label].signalEvidence, outputs['그대로'].signalEvidence, label);
  }
  const located = outputs['그대로'].signalEvidence[0].locations;
  assert.ok(located.length >= 1);
  for (const loc of located) {
    assert.equal(CORE.slice(loc.start, loc.end), buildDetectInputDocument(CORE).sentences[loc.sentenceIndex].text);
  }
});
