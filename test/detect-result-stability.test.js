'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const stability = require('../lib/detectResultStability');

const UID = 'detect-stability-user';
const FP_A = crypto.createHash('sha256').update('같은 글').digest('hex');
const FP_B = crypto.createHash('sha256').update('같은  글').digest('hex');
const CONFIG = {
  models: { detect: 'gpt-5.6-luna', detectEscalation: 'gpt-5.6-terra' },
  reasoning: { detect: 'low', escalation: 'high' }
};
const PERSISTENT_SECRET = 'detect-stability-test-secret-32-bytes-minimum';

function modelResult(probability = 42) {
  return {
    probability,
    summary: '문체 신호가 일부 관찰됐어요.',
    detail: '문장 구조의 반복을 확인했어요.',
    signals: ['문장 구조 반복'],
    signalEvidence: [{
      category: 'sentence_uniformity',
      categoryLabel: '문장 호흡의 균일성',
      strength: 'moderate',
      scope: 'recurring',
      description: '문장 구조 반복',
      format: 'structured'
    }],
    signalContractVersion: 'model-signals-v1',
    confidence: 'medium',
    gptMeta: {
      selectedModel: 'gpt-5.6-luna',
      engine: 'gpt-detect-v1.25',
      detectPromptVersion: 'detect-prompt-v5-cause-aligned',
      escalated: false,
      usage: { inputTokens: 999 },
      providerResponse: '저장 금지'
    }
  };
}

function input(fingerprint = FP_A, variant = variantFor()) {
  return { uid: UID, payloadFingerprint: fingerprint, cacheVariant: variant };
}

function variantFor(overrides = {}) {
  return stability.variantForConfig({
    ...CONFIG,
    ...overrides,
    models: { ...CONFIG.models, ...(overrides.models || {}) },
    reasoning: { ...CONFIG.reasoning, ...(overrides.reasoning || {}) }
  }, {
    detectorVersion: 'gpt-detect-v1.25',
    promptVersion: 'detect-prompt-v5-cause-aligned'
  });
}

function fakeFirestore() {
  const rows = new Map();
  function ref(collection, id) {
    const key = `${collection}/${id}`;
    return {
      key,
      async get() {
        return { exists: rows.has(key), data: () => rows.get(key) };
      },
      async set(value) {
        rows.set(key, value);
      }
    };
  }
  return {
    rows,
    collection(name) {
      return { doc: id => ref(name, id) };
    },
    async runTransaction(callback) {
      return callback({
        async get(target) {
          return target.get();
        },
        set(target, value) {
          rows.set(target.key, value);
        }
      });
    }
  };
}

test.beforeEach(() => stability.resetForTests());

test('같은 사용자·입력·모델 정책은 24시간 동안 원점수를 재사용한다', async () => {
  let calls = 0;
  const options = { firestore: null, now: 10_000 };
  const first = await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(42);
  }, options);
  const second = await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(68);
  }, { ...options, now: 20_000 });

  assert.equal(first.cacheHit, false);
  assert.equal(first.source, 'live');
  assert.equal(second.cacheHit, true);
  assert.equal(second.source, 'memory');
  assert.equal(second.result.probability, 42);
  assert.equal(second.result.signalEvidence[0].category, 'sentence_uniformity');
  assert.equal(second.result.signalContractVersion, 'model-signals-v1');
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(second.result.gptMeta, 'usage'), false);
  assert.equal(Object.hasOwn(second.result.gptMeta, 'providerResponse'), false);
});

test('공백을 포함한 입력 지문과 감지 정책 버전이 다르면 이전 점수를 섞지 않는다', async () => {
  let calls = 0;
  const compute = async () => modelResult(40 + (++calls));
  const first = await stability.getOrCompute(input(FP_A), compute, { firestore: null, now: 10_000 });
  const whitespaceChanged = await stability.getOrCompute(input(FP_B), compute, { firestore: null, now: 11_000 });
  const modelChanged = await stability.getOrCompute(input(FP_A, variantFor({ models: { detect: 'gpt-next' } })), compute, { firestore: null, now: 12_000 });

  assert.equal(first.result.probability, 41);
  assert.equal(whitespaceChanged.result.probability, 42);
  assert.equal(modelChanged.result.probability, 43);
  assert.equal(calls, 3);
});

test('원인-점수 정렬 kill switch가 바뀌면 안정화 캐시를 분리한다', () => {
  const previous = process.env.DETECT_CAUSE_SCORE_ALIGNMENT_ENABLED;
  try {
    process.env.DETECT_CAUSE_SCORE_ALIGNMENT_ENABLED = '1';
    const enabled = variantFor();
    process.env.DETECT_CAUSE_SCORE_ALIGNMENT_ENABLED = '0';
    const disabled = variantFor();
    assert.notEqual(enabled, disabled);
  } finally {
    if (previous === undefined) delete process.env.DETECT_CAUSE_SCORE_ALIGNMENT_ENABLED;
    else process.env.DETECT_CAUSE_SCORE_ALIGNMENT_ENABLED = previous;
  }
});

test('TTL이 지나면 같은 입력도 새 정책 결과로 다시 계산한다', async () => {
  let calls = 0;
  const compute = async () => modelResult(50 + (++calls));
  const first = await stability.getOrCompute(input(), compute, {
    firestore: null,
    now: 1_000,
    ttlMs: stability.MIN_TTL_MS
  });
  const expired = await stability.getOrCompute(input(), compute, {
    firestore: null,
    now: 1_000 + stability.MIN_TTL_MS + 1,
    ttlMs: stability.MIN_TTL_MS
  });

  assert.equal(first.result.probability, 51);
  assert.equal(expired.result.probability, 52);
  assert.equal(expired.cacheHit, false);
  assert.equal(calls, 2);
});

test('동시에 들어온 같은 입력은 한 모델 호출만 공유한다', async () => {
  let calls = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const compute = async () => {
    calls += 1;
    await barrier;
    return modelResult(57);
  };
  const one = stability.getOrCompute(input(), compute, { firestore: null, now: 10_000 });
  const two = stability.getOrCompute(input(), compute, { firestore: null, now: 10_000 });
  release();
  const [first, second] = await Promise.all([one, two]);

  assert.equal(calls, 1);
  assert.equal(first.result.probability, 57);
  assert.equal(second.result.probability, 57);
  assert.equal([first.source, second.source].includes('inflight'), true);
});

test('프로세스 메모리가 비어도 Firestore의 사용자 결합 캐시를 재사용한다', async () => {
  const firestore = fakeFirestore();
  const firebaseAdmin = { firestore: { Timestamp: { fromMillis: value => value } } };
  let calls = 0;
  const first = await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(63);
  }, { firestore, firebaseAdmin, now: 10_000, hmacSecret: PERSISTENT_SECRET });
  stability.resetForTests();
  const second = await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(12);
  }, { firestore, firebaseAdmin, now: 20_000, hmacSecret: PERSISTENT_SECRET });

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.source, 'firestore');
  assert.equal(second.result.probability, 63);
  assert.equal(calls, 1);
  const stored = [...firestore.rows.values()].find(row => row.purpose === stability.PURPOSE);
  assert.ok(stored);
  assert.match(stored.bindingHash, /^[a-f0-9]{64}$/u);
  assert.match(stored.stabilityDeletionKey, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(stored, 'uid'), false);
  assert.equal(Object.hasOwn(stored, 'payloadFingerprint'), false);
  assert.equal(Object.hasOwn(stored, 'text'), false);
  assert.equal(Object.hasOwn(stored, 'inputText'), false);
});

test('사용자 삭제용 키는 원문 UID 없이 도메인 분리되며 메모리 캐시를 지운다', async () => {
  await stability.getOrCompute(input(), async () => modelResult(47), {
    firestore: null,
    hmacSecret: PERSISTENT_SECRET,
    now: 10_000
  });
  const key = stability.deletionKeyForUid(UID, { hmacSecret: PERSISTENT_SECRET });
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.equal(key.includes(UID), false);
  assert.equal(stability.purgeForUid(UID, { hmacSecret: PERSISTENT_SECRET }), 1);

  let calls = 0;
  await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(48);
  }, { firestore: null, hmacSecret: PERSISTENT_SECRET, now: 20_000 });
  assert.equal(calls, 1);
});

test('영속 비밀키가 없으면 메모리 안정화만 사용하고 Firestore에는 쓰지 않는다', async () => {
  const firestore = fakeFirestore();
  const firebaseAdmin = { firestore: { Timestamp: { fromMillis: value => value } } };
  await stability.getOrCompute(input(), async () => modelResult(58), {
    firestore,
    firebaseAdmin,
    hmacSecret: 'short',
    now: 10_000
  });
  assert.equal([...firestore.rows.values()].some(row => row.purpose === stability.PURPOSE), false);
  assert.equal(stability.purgeForUid(UID, { hmacSecret: 'short' }), 1,
    '영속 비밀이 없어도 현재 프로세스의 사용자 캐시는 즉시 지운다');

  stability.resetForTests();
  let calls = 0;
  const second = await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(59);
  }, {
    firestore,
    firebaseAdmin,
    hmacSecret: 'another-short-process-key',
    now: 20_000
  });
  assert.equal(second.cacheHit, false);
  assert.equal(second.source, 'live');
  assert.equal(second.result.probability, 59);
  assert.equal(calls, 1);
});

test('불완전한 모델 결과와 실패는 캐시하지 않는다', async () => {
  let calls = 0;
  await assert.rejects(stability.getOrCompute(input(), async () => {
    calls += 1;
    return { summary: '점수 없음' };
  }, { firestore: null, now: 10_000 }), /DETECT_INCOMPLETE/u);
  const recovered = await stability.getOrCompute(input(), async () => {
    calls += 1;
    return modelResult(34);
  }, { firestore: null, now: 20_000 });
  assert.equal(recovered.result.probability, 34);
  assert.equal(calls, 2);
});

test('원문 지문·사용자·정책 결합이 불완전하면 캐시 없이 계산한다', async () => {
  let calls = 0;
  const invalid = await stability.getOrCompute({ uid: UID, payloadFingerprint: 'not-a-hash', cacheVariant: variantFor() }, async () => {
    calls += 1;
    return modelResult(44);
  }, { firestore: null });
  assert.equal(invalid.cacheHit, false);
  assert.equal(invalid.source, 'live');
  assert.equal(calls, 1);
});

test('신규 근거 좌표와 계약 버전은 최초 응답·메모리·Firestore 캐시에서 보존한다', async () => {
  const firestore = fakeFirestore();
  const firebaseAdmin = { firestore: { Timestamp: { fromMillis: value => value } } };
  const locations = [{ sentenceIndex: 0, start: 0, end: 12 }, { sentenceIndex: 1, start: 13, end: 25 }];
  const result = modelResult(42);
  result.signalContractVersion = 'model-signals-v2-grounded';
  result.signalEvidence[0].locations = locations.map(location => ({ ...location, text: '캐시에 저장하지 않을 본문' }));
  result.signalEvidence[0].locationStatus = 'source_range_verified';
  const opts = { firestore, firebaseAdmin, hmacSecret: PERSISTENT_SECRET, now: 10000 };
  const first = await stability.getOrCompute(input(), async () => result, opts);
  const memory = await stability.getOrCompute(input(), async () => assert.fail('cache missed'), { ...opts, now: 11000 });
  stability.resetForTests();
  const persisted = await stability.getOrCompute(input(), async () => assert.fail('cache missed'), { ...opts, now: 12000 });
  for (const response of [first, memory, persisted]) {
    assert.equal(response.result.signalContractVersion, 'model-signals-v2-grounded');
    assert.deepEqual(response.result.signalEvidence[0].locations, locations);
    assert.equal(response.result.signalEvidence[0].locationStatus, 'source_range_verified');
    assert.equal(response.result.probability, 42);
  }
  assert.equal(persisted.source, 'firestore');
});

test('누락·빈 점수는 0점 결과로 캐시하지 않고 유효한 0점은 보존한다', () => {
  for (const probability of [null, undefined, '', ' ', false, [], {}, NaN]) {
    assert.equal(stability.cleanResult({ probability }), null);
  }
  assert.equal(stability.cleanResult({ probability: 0 }).probability, 0);
  assert.equal(Object.hasOwn(stability.cleanResult({ probability: 4, modelProbability: null }), 'modelProbability'), false);
});
