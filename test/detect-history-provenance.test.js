'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let stored = null;
const rows = new Map([
  ['users/history-user', { credits: 100, plan: 'free' }]
]);

function snapshot(target) {
  return {
    exists: rows.has(target.path),
    data: () => rows.get(target.path)
  };
}

function ref(pathname) {
  return {
    path: pathname,
    id: pathname.split('/').at(-1),
    async get() {
      return snapshot(this);
    },
    collection(name) {
      return {
        doc: id => ref(`${pathname}/${name}/${id || 'auto'}`)
      };
    }
  };
}

const db = {
  collection(name) {
    return { doc: id => ref(`${name}/${id}`) };
  },
  async runTransaction(callback) {
    return callback({
      async get(target) {
        return snapshot(target);
      },
      set(target, value, options) {
        stored = { target, value, options };
        rows.set(target.path, options?.merge
          ? { ...(rows.get(target.path) || {}), ...value }
          : { ...value });
      }
    });
  }
};

const configPath = require.resolve(path.join(ROOT, 'config.js'));
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    db,
    admin: {
      firestore: {
        FieldValue: { serverTimestamp: () => 'server-time' }
      }
    }
  }
};

const history = require('../lib/historyService');

test('감지 이력은 공개 점수 provenance만 allowlist로 저장한다', async () => {
  stored = null;
  await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId: 'detect-history-1',
    opType: 'detect',
    text: '합성 테스트 원문',
    needed: 3,
    mode: 'detect',
    result: {
      probability: 72,
      riskLevel: 'high',
      riskLabel: 'AI 의심 높음',
      probSource: 'llm',
      confidence: 'medium',
      gptMeta: {
        selectedModel: 'gpt-test',
        engine: 'detect-test-v1',
        escalated: true,
        usage: { raw: '저장 금지' },
        providerResponse: '저장 금지'
      },
      summary: '요약',
      detail: '상세'
    }
  });

  assert.equal(stored.target.path, 'users/history-user/history/detect-history-1');
  assert.equal(stored.value.probSource, 'llm');
  assert.equal(stored.value.detectConfidence, 'medium');
  assert.equal(stored.value.detectModel, 'gpt-test');
  assert.equal(stored.value.detectorVersion, 'detect-test-v1');
  assert.equal(stored.value.detectEscalated, true);
  assert.equal(Object.hasOwn(stored.value, 'gptMeta'), false);
  assert.equal(Object.hasOwn(stored.value, 'usage'), false);
  assert.equal(Object.hasOwn(stored.value, 'providerResponse'), false);
});

test('엔진 폴백 출처와 유효하지 않은 confidence는 감지 이력에 저장하지 않는다', async () => {
  stored = null;
  await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId: 'detect-history-2',
    opType: 'detect',
    text: '합성 테스트 원문',
    needed: 0,
    mode: 'detect',
    result: {
      probability: 22,
      probSource: 'engine',
      confidence: 'certain',
      summary: '요약',
      detail: '상세'
    }
  });

  assert.equal(Object.hasOwn(stored.value, 'probSource'), false);
  assert.equal(Object.hasOwn(stored.value, 'detectConfidence'), false);
});

test('감지 이력 requestId는 payload fingerprint와 비용에 결합되고 최초 응답을 덮어쓰지 않는다', async () => {
  const requestId = 'detect-history-bound-1';
  const fingerprint = 'a'.repeat(64);
  const firstResponse = {
    ok: true,
    probability: 72,
    probSource: 'llm',
    summary: '최초 결과',
    charged: 3,
    remainingCredits: 97
  };
  const first = await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId,
    opType: 'detect',
    text: '최초 감지 입력',
    needed: 3,
    mode: 'detect',
    requestPayloadFingerprint: fingerprint,
    detectResponseCache: firstResponse,
    result: { probability: 72, probSource: 'llm', summary: '최초 결과', detail: '최초 상세' }
  });
  assert.equal(first.saved, true);

  const ready = await history.getDetectHistoryIdempotency({
    uid: 'history-user',
    requestId,
    needed: 3,
    requestPayloadFingerprint: fingerprint
  });
  assert.equal(ready.state, 'READY');
  assert.deepEqual(ready.response, firstResponse);

  const duplicate = await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId,
    opType: 'detect',
    text: '최초 감지 입력',
    needed: 3,
    mode: 'detect',
    requestPayloadFingerprint: fingerprint,
    detectResponseCache: { ...firstResponse, probability: 22, summary: '덮어쓰기 금지' },
    result: { probability: 22, probSource: 'llm', summary: '덮어쓰기 금지', detail: '덮어쓰기 금지' }
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.response, firstResponse);
  assert.deepEqual(rows.get(`users/history-user/history/${requestId}`).detectResponseCache, firstResponse);

  const mismatch = await history.getDetectHistoryIdempotency({
    uid: 'history-user',
    requestId,
    needed: 4,
    requestPayloadFingerprint: 'b'.repeat(64)
  });
  assert.equal(mismatch.state, 'MISMATCH');
  await assert.rejects(history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId,
    opType: 'detect',
    text: '다른 감지 입력',
    needed: 4,
    mode: 'detect',
    requestPayloadFingerprint: 'b'.repeat(64),
    detectResponseCache: { ...firstResponse, probability: 22 },
    result: { probability: 22, probSource: 'llm', summary: '다름', detail: '다름' }
  }), error => error?.code === 'IDEMPOTENCY_KEY_REUSED' && error?.status === 409);
  assert.equal(rows.get(`users/history-user/history/${requestId}`).probability, 72);
});
