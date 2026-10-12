'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const configPath = require.resolve(path.join(ROOT, 'config.js'));
const loggerPath = require.resolve(path.join(ROOT, 'lib/logger.js'));
const storePath = require.resolve(path.join(ROOT, 'lib/detectRequestStore.js'));
const originals = [configPath, loggerPath, storePath].map(file => [file, require.cache[file]]);

// 직렬 transaction과 field 단위 set(merge)/update/delete만 흉내 내는 최소 Firestore.
const DELETE = Symbol('delete');
const fake = { rows: new Map(), failWrites: 0, failReads: 0, queue: Promise.resolve(), logs: [] };
const apply = (target, patch) => {
  for (const [field, value] of Object.entries(patch)) {
    if (value === DELETE) delete target[field];
    else target[field] = structuredClone(value);
  }
  return target;
};
const db = {
  collection: name => ({ doc: id => ({ path: `${name}/${id}` }) }),
  runTransaction(work) {
    const run = async () => {
      const writes = [];
      const result = await work({
        get: async ref => {
          if (fake.failReads > 0) { fake.failReads -= 1; throw new Error('synthetic firestore read failure'); }
          const row = fake.rows.get(ref.path);
          return { exists: !!row, data: () => structuredClone(row) };
        },
        set: (ref, patch, options) => writes.push(() => {
          fake.rows.set(ref.path, apply(options?.merge ? fake.rows.get(ref.path) || {} : {}, patch));
        }),
        update: (ref, patch) => writes.push(() => {
          if (!fake.rows.has(ref.path)) throw new Error('NOT_FOUND');
          apply(fake.rows.get(ref.path), patch);
        }),
        delete: ref => writes.push(() => fake.rows.delete(ref.path))
      });
      if (fake.failWrites > 0 && writes.length) { fake.failWrites -= 1; throw new Error('synthetic firestore commit failure'); }
      writes.forEach(write => write());
      return result;
    };
    const next = fake.queue.then(run, run);
    fake.queue = next.catch(() => {});
    return next;
  }
};
const admin = { firestore: {
  FieldValue: { delete: () => DELETE },
  Timestamp: { fromMillis: ms => ({ seconds: Math.floor(ms / 1000) }) }
} };

require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { db, admin } };
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { logger: {
  error: (event, fields) => fake.logs.push({ event, fields }),
  warn: (event, fields) => fake.logs.push({ event, fields })
} } };
delete require.cache[storePath];
const store = require('../lib/detectRequestStore');

test.after(() => {
  for (const [file, cached] of originals) {
    if (cached) require.cache[file] = cached;
    else delete require.cache[file];
  }
});

function binding(requestId) {
  return { uid: 'detect-store-db-user', requestId, payloadFingerprint: 'c'.repeat(64), cost: 3 };
}
const rowOf = input => fake.rows.get(`${store.COLLECTION}/${store.storageKey(input.uid, input.requestId)}`);
const small = probability => ({
  publicResponse: { ok: true, probability, probSource: 'llm' },
  historyResult: { probability, probSource: 'llm' },
  metric: { probability }
});
function large(probability = 61) {
  const sentences = Array.from({ length: 1200 }, (_, index) => ({
    index, start: index * 60, end: index * 60 + 58,
    text: `합성 문장 ${index}번은 저장 형식 확인용이며 항목 ${index % 41}의 순서를 설명합니다.`
  }));
  const reportView = { status: 'ready', conversion: { targets: sentences.slice(0, 200) } };
  return {
    publicResponse: { ok: true, probability, probSource: 'llm', reportView, sentenceMap: { sentences },
      paragraphs: sentences.map(item => ({ idx: item.index, text: item.text.repeat(3) })) },
    historyResult: { probability, probSource: 'llm', reportView, sentenceMap: { sentences } },
    metric: { probability }
  };
}

test('작은 결과는 구형과 같은 plain 맵으로, 큰 결과는 1MiB 안의 bytes로만 저장한다', async () => {
  const smallInput = binding('detect-store-db-small-1');
  await store.begin(smallInput, 1000);
  await store.stageResult(smallInput, small(72), 1001);
  assert.deepEqual(rowOf(smallInput).response, small(72));
  assert.equal(Object.hasOwn(rowOf(smallInput), 'responseEncoded'), false);

  const largeInput = binding('detect-store-db-large-1');
  const artifact = large();
  assert.ok(Buffer.byteLength(JSON.stringify(artifact), 'utf8') > 500_000);
  await store.begin(largeInput, 1000);
  const staged = await store.stageResult(largeInput, artifact, 1001);
  assert.equal(staged.state, 'RESULT_READY');
  assert.deepEqual(staged.response, artifact);
  const row = rowOf(largeInput);
  assert.equal(row.status, 'RESULT_READY');
  assert.equal(Object.hasOwn(row, 'response'), false);
  assert.ok(row.responseEncoded.data.length < 800_000);
  assert.deepEqual(await store.begin(largeInput, 1002), { state: 'RESULT_READY', response: artifact });

  // 완료 응답이 다시 작아지면 plain으로 돌아가고 압축본은 지워진다.
  await store.complete(largeInput, small(61), 1003);
  assert.equal(Object.hasOwn(rowOf(largeInput), 'responseEncoded'), false);
  assert.deepEqual(await store.begin(largeInput, 1004), { state: 'COMPLETE', response: small(61) });
});

test('Firestore commit 실패는 어디에도 성공 상태를 남기지 않고 다음 고정이 새로 기록된다', async () => {
  const input = binding('detect-store-db-failure-1');
  await store.begin(input, 2000);

  fake.failWrites = 1;
  assert.deepEqual(await store.stageResult(input, small(72), 2001), { state: 'UNAVAILABLE' });
  assert.equal(rowOf(input).status, 'PROCESSING');
  assert.equal(Object.hasOwn(rowOf(input), 'response'), false);
  assert.deepEqual(await store.begin(input, 2002), { state: 'PROCESSING', retryAfterMs: store.STALE_PROCESSING_MS - 2 });

  // 실패한 첫 결과가 프로세스 메모리에 남아 있었다면 여기서 72점이 replay로 돌아온다.
  const retried = await store.stageResult(input, small(41), 2003);
  assert.equal(retried.state, 'RESULT_READY');
  assert.equal(retried.reused, false);
  assert.equal(retried.response.publicResponse.probability, 41);

  fake.failWrites = 1;
  assert.deepEqual(await store.complete(input, small(41), 2004), { state: 'UNAVAILABLE' });
  assert.equal(rowOf(input).status, 'RESULT_READY', '완료 commit 실패는 COMPLETE로 보이면 안 된다');
  assert.equal((await store.begin(input, 2005)).state, 'RESULT_READY');

  fake.failReads = 1;
  assert.deepEqual(await store.begin(input, 2006), { state: 'UNAVAILABLE' });
});

test('같은 요청의 동시 고정은 먼저 commit된 결과 하나만 남기고 나머지는 replay로 받는다', async () => {
  const input = binding('detect-store-db-concurrent-1');
  assert.deepEqual(await Promise.all([store.begin(input, 3000), store.begin(input, 3000)]),
    [{ state: 'NEW' }, { state: 'PROCESSING', retryAfterMs: store.STALE_PROCESSING_MS }]);

  const results = await Promise.all([large(61), large(22), small(35)]
    .map((artifact, index) => store.stageResult(input, artifact, 3001 + index)));
  assert.deepEqual(results.map(item => item.state), ['RESULT_READY', 'RESULT_READY', 'RESULT_READY']);
  assert.equal(results.filter(item => item.reused === false).length, 1);
  const winner = results.find(item => item.reused === false).response.publicResponse.probability;
  assert.deepEqual(results.map(item => item.response.publicResponse.probability), [winner, winner, winner]);

  const completed = await Promise.all([
    store.complete(input, { ...small(winner), publicResponse: { ...small(winner).publicResponse, charged: 3 } }, 3010),
    store.stageResult(input, small(99), 3011),
    store.complete(input, small(99), 3012)
  ]);
  assert.deepEqual(completed.map(item => item.state), ['COMPLETE', 'COMPLETE', 'COMPLETE']);
  assert.deepEqual(completed.map(item => item.reused), [false, true, true]);
  assert.equal(rowOf(input).status, 'COMPLETE');
  assert.equal((await store.begin(input, 3013)).response.publicResponse.charged, 3);
});

test('구형 캐시 row는 그대로 replay되고, 읽을 수 없는 압축본은 결과로 쓰지 않는다', async () => {
  const legacy = binding('detect-store-db-legacy-1');
  const legacyRow = { purpose: store.PURPOSE, ...legacy, status: 'RESULT_READY', response: small(72),
    createdAtMs: 4000, updatedAtMs: 4000 };
  fake.rows.set(`${store.COLLECTION}/${store.storageKey(legacy.uid, legacy.requestId)}`, legacyRow);
  assert.deepEqual(await store.begin(legacy, 4001), { state: 'RESULT_READY', response: small(72) });
  const reused = await store.stageResult(legacy, small(10), 4002);
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.response, small(72));

  // 구버전 인스턴스가 plain을 덮어쓴 뒤 남은 압축본보다 plain이 우선한다.
  const mixed = binding('detect-store-db-mixed-1');
  await store.begin(mixed, 4100);
  await store.stageResult(mixed, large(61), 4101);
  rowOf(mixed).response = small(48);
  assert.equal((await store.begin(mixed, 4102)).response.publicResponse.probability, 48);

  const corrupt = binding('detect-store-db-corrupt-1');
  await store.begin(corrupt, 4200);
  await store.stageResult(corrupt, large(61), 4201);
  rowOf(corrupt).responseEncoded.data = Buffer.from('synthetic corruption');
  // 손상은 다시 읽어도 같다. 저장소 장애(UNAVAILABLE, 재시도 가능)와 구분해 알린다.
  assert.deepEqual(await store.begin(corrupt, 4202), { state: 'CORRUPT' });
  assert.deepEqual(await store.lookup(corrupt, 4202), { state: 'CORRUPT' });
  assert.deepEqual(await store.stageResult(corrupt, small(30), 4203), { state: 'CORRUPT', reused: true });
  assert.equal(rowOf(corrupt).status, 'RESULT_READY', '손상된 결과를 다른 점수로 덮어쓰지 않는다');
  fake.failReads = 1;
  assert.deepEqual(await store.lookup(corrupt, 4204), { state: 'UNAVAILABLE' });
});

test('claim이 없거나 다른 payload의 row에는 결과를 쓰지 않는다', async () => {
  const input = binding('detect-store-db-guard-1');
  assert.deepEqual(await store.stageResult(input, small(72), 5000), { state: 'UNAVAILABLE' });
  assert.equal(rowOf(input), undefined);

  await store.begin(input, 5001);
  const other = { ...input, payloadFingerprint: 'd'.repeat(64) };
  assert.deepEqual(await store.stageResult(other, small(72), 5002), { state: 'MISMATCH' });
  assert.equal(rowOf(input).status, 'PROCESSING');
  // 저장소 장애 중에는 claim 정리가 확인되지 않았다고 알리고, 처리 상태는 stale 시점까지만 남는다.
  fake.failReads = 1;
  assert.equal(await store.releaseAfterModelFailure(input), false);
  assert.equal(rowOf(input).status, 'PROCESSING');
  assert.equal((await store.begin(input, 5001 + store.STALE_PROCESSING_MS - 1)).state, 'PROCESSING');
  assert.deepEqual(await store.begin(input, 5001 + store.STALE_PROCESSING_MS), { state: 'NEW' });
  assert.equal(await store.releaseAfterModelFailure(input), true);
  assert.equal(rowOf(input), undefined);
});

test('lookup은 row를 만들지 않고, 보존 기한이 지나도 남아 있는 결과는 그대로 replay한다', async () => {
  const input = binding('detect-store-db-lookup-1');
  assert.deepEqual(await store.lookup(input, 6000), { state: 'ABSENT' });
  assert.equal(rowOf(input), undefined);

  await store.begin(input, 6001);
  await store.stageResult(input, small(72), 6002);
  await store.complete(input, small(72), 6003);
  // TTL 정책 삭제는 지연될 수 있다. 기한은 정리 기준일 뿐이고, row가 남아 있으면 차감된 결과를 돌려준다.
  const late = 6003 + store.JOB_TTL_MS * 30;
  assert.deepEqual(await store.lookup(input, late), { state: 'COMPLETE', response: small(72) });
  assert.deepEqual(await store.begin(input, late), { state: 'COMPLETE', response: small(72) });
  assert.equal(rowOf(input).status, 'COMPLETE');

  // 방치된 처리 상태는 lookup에서도 claim으로 바뀌지 않는다.
  const stale = binding('detect-store-db-lookup-2');
  await store.begin(stale, 6100);
  assert.deepEqual(await store.lookup(stale, 6100 + store.STALE_PROCESSING_MS), { state: 'ABSENT' });
  assert.equal(rowOf(stale).updatedAtMs, 6100);
});

test('JSON은 작아도 숫자가 많아 Firestore에서 1MiB를 넘는 결과는 압축본으로만 저장하고 문서 전체를 한도 안에 둔다', async () => {
  const codec = require('../lib/detectResponseCodec');
  const numbers = Array.from({ length: 150_000 }, (_, index) => index % 10);
  const artifact = { publicResponse: { ok: true, probability: 44, offsets: numbers },
    historyResult: { probability: 44 }, metric: { probability: 44 } };
  assert.ok(Buffer.byteLength(JSON.stringify(artifact), 'utf8') < codec.INLINE_MAX_BYTES);
  assert.ok(codec.firestoreBytes(artifact) > 1_048_576, 'plain 맵으로는 Firestore 문서 한도를 넘는다');

  const input = binding('detect-store-db-numbers-1');
  await store.begin(input, 7000);
  const staged = await store.stageResult(input, artifact, 7001);
  assert.equal(staged.state, 'RESULT_READY');
  assert.deepEqual(staged.response, artifact);
  const row = rowOf(input);
  assert.equal(Object.hasOwn(row, 'response'), false);
  assert.ok(codec.firestoreBytes(row) < codec.DOCUMENT_MAX_BYTES);
  assert.deepEqual(await store.lookup(input, 7002), { state: 'RESULT_READY', response: artifact });

  // 숫자가 적은 일반 결과는 계속 plain이다.
  const plain = binding('detect-store-db-numbers-2');
  await store.begin(plain, 7100);
  await store.stageResult(plain, small(31), 7101);
  assert.deepEqual(rowOf(plain).response, small(31));
});
