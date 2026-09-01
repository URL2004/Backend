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
  assert.deepEqual(await store.begin(input, 1001), { state: 'PROCESSING' });
  assert.deepEqual(await store.begin(binding({ payloadFingerprint: 'b'.repeat(64) }), 1002), { state: 'MISMATCH' });
  assert.deepEqual(await store.begin(binding({ cost: 4 }), 1003), { state: 'MISMATCH' });

  const firstArtifact = {
    publicResponse: { ok: true, probability: 72, probSource: 'llm' },
    historyResult: { probability: 72, probSource: 'llm' },
    metric: { probability: 72 }
  };
  const staged = await store.stageResult(input, firstArtifact, 1100);
  assert.equal(staged.state, 'RESULT_READY');
  assert.deepEqual(staged.response, firstArtifact);

  const secondArtifact = {
    publicResponse: { ok: true, probability: 22, probSource: 'llm' },
    historyResult: { probability: 22, probSource: 'llm' },
    metric: { probability: 22 }
  };
  const firstWins = await store.stageResult(input, secondArtifact, 1200);
  assert.equal(firstWins.state, 'RESULT_READY');
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
