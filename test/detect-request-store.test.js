'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const configPath = require.resolve(path.join(ROOT, 'config.js'));
const loggerPath = require.resolve(path.join(ROOT, 'lib/logger.js'));
const storePath = require.resolve(path.join(ROOT, 'lib/detectRequestStore.js'));
const originalConfig = require.cache[configPath];
const originalLogger = require.cache[loggerPath];
const originalStore = require.cache[storePath];

require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { db: null, admin: null }
};
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { logger: { error() {}, warn() {} } }
};
delete require.cache[storePath];
const store = require('../lib/detectRequestStore');

test.after(() => {
  if (originalConfig) require.cache[configPath] = originalConfig;
  else delete require.cache[configPath];
  if (originalLogger) require.cache[loggerPath] = originalLogger;
  else delete require.cache[loggerPath];
  if (originalStore) require.cache[storePath] = originalStore;
  else delete require.cache[storePath];
});

function binding(overrides = {}) {
  return {
    uid: 'detect-store-user',
    requestId: 'detect-store-request-1',
    payloadFingerprint: 'a'.repeat(64),
    cost: 3,
    ...overrides
  };
}

test('감지 요청 캐시는 2시간 보존 목적과 비식별 문서 키를 고정한다', () => {
  assert.equal(store.COLLECTION, 'analyzeRequests');
  assert.equal(store.JOB_TTL_MS, 2 * 60 * 60 * 1000);
  const key = store.storageKey('detect-store-user', 'detect-store-request-1');
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(key, /detect-store-user|detect-store-request-1/u);
});

test('같은 payload는 처리 상태와 최초 결과를 replay하고 다른 payload는 거절한다', async () => {
  store.resetMemoryForTests();
  const input = binding();
  assert.deepEqual(await store.begin(input, 1000), { state: 'NEW' });
  assert.deepEqual(await store.begin(input, 1001), { state: 'PROCESSING', retryAfterMs: store.STALE_PROCESSING_MS - 1 });
  assert.deepEqual(await store.begin(binding({ payloadFingerprint: 'b'.repeat(64) }), 1002), { state: 'MISMATCH' });
  assert.deepEqual(await store.begin(binding({ cost: 4 }), 1003), { state: 'MISMATCH' });

  const firstArtifact = {
    publicResponse: { ok: true, probability: 72, probSource: 'llm' },
    historyResult: { probability: 72, probSource: 'llm' },
    metric: { probability: 72 }
  };
  const staged = await store.stageResult(input, firstArtifact, 1100);
  assert.equal(staged.state, 'RESULT_READY');
  assert.equal(staged.reused, false, 'serialization of a fresh result is not replay');
  assert.notEqual(staged.response, firstArtifact);
  assert.deepEqual(staged.response, firstArtifact);

  const secondArtifact = {
    publicResponse: { ok: true, probability: 22, probSource: 'llm' },
    historyResult: { probability: 22, probSource: 'llm' },
    metric: { probability: 22 }
  };
  const firstWins = await store.stageResult(input, secondArtifact, 1200);
  assert.equal(firstWins.state, 'RESULT_READY');
  assert.equal(firstWins.reused, true, 'an older staged result winning is replay');
  assert.deepEqual(firstWins.response, firstArtifact, '동일 키의 최초 모델 결과를 덮어쓰면 안 된다');
  assert.deepEqual(await store.begin(input, 1201), { state: 'RESULT_READY', response: firstArtifact });

  const completedArtifact = {
    ...firstArtifact,
    publicResponse: { ...firstArtifact.publicResponse, charged: 3, remainingCredits: 7 }
  };
  const completed = await store.complete(input, completedArtifact, 1300);
  assert.equal(completed.state, 'COMPLETE');
  assert.deepEqual(await store.begin(input, 1301), { state: 'COMPLETE', response: completedArtifact });
});

test('모델 전 실패는 PROCESSING claim만 해제하고 staged 결과는 보존한다', async () => {
  store.resetMemoryForTests();
  const processing = binding({ requestId: 'detect-store-release-1' });
  await store.begin(processing, 2000);
  await store.releaseAfterModelFailure(processing);
  assert.deepEqual(await store.begin(processing, 2001), { state: 'NEW' });

  const stagedBinding = binding({ requestId: 'detect-store-release-2' });
  const artifact = {
    publicResponse: { ok: true, probability: 72 },
    historyResult: { probability: 72 },
    metric: { probability: 72 }
  };
  await store.begin(stagedBinding, 3000);
  await store.stageResult(stagedBinding, artifact, 3001);
  await store.releaseAfterModelFailure(stagedBinding);
  assert.deepEqual(await store.begin(stagedBinding, 3002), { state: 'RESULT_READY', response: artifact });
});

function largeArtifact(probability = 61) {
  const sentences = Array.from({ length: 1200 }, (_, index) => ({
    index, start: index * 60, end: index * 60 + 58, kind: 'plain',
    text: `합성 문장 ${index}번은 저장 형식 확인용이며 항목 ${index % 41}의 순서를 설명합니다.`
  }));
  const reportView = { status: 'ready', conversion: { targets: sentences.slice(0, 200) } };
  const sentenceMap = { sentences };
  return {
    publicResponse: { ok: true, probability, probSource: 'llm', reportView, sentenceMap,
      paragraphs: sentences.map(item => ({ idx: item.index, text: item.text.repeat(3) })) },
    historyResult: { probability, probSource: 'llm', reportView, sentenceMap },
    metric: { probability }
  };
}

test('이전 500KB 한도를 넘는 결과도 고정·replay·완료가 같은 내용으로 이어진다', async () => {
  store.resetMemoryForTests();
  const input = binding({ requestId: 'detect-store-large-1' });
  const artifact = largeArtifact();
  assert.ok(Buffer.byteLength(JSON.stringify(artifact), 'utf8') > 500_000);

  await store.begin(input, 4000);
  const staged = await store.stageResult(input, artifact, 4001);
  assert.equal(staged.state, 'RESULT_READY');
  assert.equal(staged.reused, false);
  assert.deepEqual(staged.response, artifact);
  assert.deepEqual(await store.begin(input, 4002), { state: 'RESULT_READY', response: artifact });

  const completed = { ...artifact, publicResponse: { ...artifact.publicResponse, charged: 3, remainingCredits: 7 } };
  assert.equal((await store.complete(input, completed, 4003)).state, 'COMPLETE');
  assert.deepEqual(await store.begin(input, 4004), { state: 'COMPLETE', response: completed });
});

test('저장 한도 초과와 잘못된 결과는 던지지 않고 상태로 돌려주며 claim은 해제할 수 있다', async () => {
  store.resetMemoryForTests();
  const input = binding({ requestId: 'detect-store-oversized-1' });
  await store.begin(input, 5000);
  const oversized = { publicResponse: { ok: true, probability: 50,
    noise: require('node:crypto').randomBytes(900_000).toString('base64') }, historyResult: { probability: 50 }, metric: {} };
  assert.deepEqual(await store.stageResult(input, oversized, 5001),
    { state: 'TOO_LARGE', code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  assert.deepEqual(await store.stageResult(input, null, 5002),
    { state: 'UNAVAILABLE', code: 'DETECT_RESPONSE_CACHE_INVALID' });
  assert.deepEqual(await store.begin(input, 5003), { state: 'PROCESSING', retryAfterMs: store.STALE_PROCESSING_MS - 3 },
    '실패한 고정은 결과 상태를 만들지 않는다');
  assert.equal(await store.releaseAfterModelFailure(input), true);
  assert.deepEqual(await store.begin(input, 5004), { state: 'NEW' });
});

test('완료된 결과는 뒤늦은 고정이나 두 번째 완료로 바뀌거나 RESULT_READY로 내려가지 않는다', async () => {
  store.resetMemoryForTests();
  const input = binding({ requestId: 'detect-store-complete-wins-1' });
  const first = { publicResponse: { ok: true, probability: 72, charged: 3 }, historyResult: { probability: 72 }, metric: { probability: 72 } };
  const late = { publicResponse: { ok: true, probability: 22 }, historyResult: { probability: 22 }, metric: { probability: 22 } };
  await store.begin(input, 6000);
  await store.stageResult(input, first, 6001);
  await store.complete(input, first, 6002);

  const lateStage = await store.stageResult(input, late, 6003);
  assert.equal(lateStage.state, 'COMPLETE');
  assert.equal(lateStage.reused, true);
  assert.deepEqual(lateStage.response, first);
  const lateComplete = await store.complete(input, late, 6004);
  assert.equal(lateComplete.state, 'COMPLETE');
  assert.equal(lateComplete.reused, true);
  assert.deepEqual(await store.begin(input, 6005), { state: 'COMPLETE', response: first });
});

test('lookup은 처리 상태를 만들지 않고 고정된 결과만 돌려준다', async () => {
  store.resetMemoryForTests();
  const input = binding({ requestId: 'detect-store-lookup-1' });
  assert.deepEqual(await store.lookup(input, 7000), { state: 'ABSENT' });
  assert.deepEqual(await store.begin(input, 7001), { state: 'NEW' }, 'lookup이 claim을 남겼다면 PROCESSING이다');
  assert.deepEqual(await store.lookup(input, 7002), { state: 'PROCESSING', retryAfterMs: store.STALE_PROCESSING_MS - 1 });
  assert.deepEqual(await store.lookup(binding({ requestId: 'detect-store-lookup-1', cost: 4 }), 7003), { state: 'MISMATCH' });

  const artifact = { publicResponse: { ok: true, probability: 72 }, historyResult: { probability: 72 }, metric: { probability: 72 } };
  await store.stageResult(input, artifact, 7004);
  assert.deepEqual(await store.lookup(input, 7005), { state: 'RESULT_READY', response: artifact });
  // 메모리 모드는 보존 기한을 직접 적용한다. 기한 뒤의 lookup도 새 claim을 만들지 않는다.
  assert.deepEqual(await store.lookup(input, 7004 + store.JOB_TTL_MS), { state: 'ABSENT' });
  assert.deepEqual(await store.lookup(input, 7004 + store.JOB_TTL_MS + 1), { state: 'ABSENT' });
});
