'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const rows = new Map([
  ['users/owner-user', { credits: 100, plan: 'free' }],
  ['users/other-user', { credits: 100, plan: 'free' }]
]);
let writes = 0;
let failReads = false;
const DELETE_FIELD = Symbol('delete');

function snapshot(target) {
  return { exists: rows.has(target.path), data: () => rows.get(target.path) };
}

function ref(pathname) {
  return {
    path: pathname,
    id: pathname.split('/').at(-1),
    async get() {
      if (failReads) throw new Error('synthetic storage outage');
      return snapshot(this);
    },
    collection: name => ({ doc: id => ref(`${pathname}/${name}/${id || 'auto'}`) })
  };
}

const db = {
  collection: name => ({ doc: id => ref(`${name}/${id}`) }),
  async runTransaction(callback) {
    return callback({
      get: async target => snapshot(target),
      set(target, value, options) {
        writes += 1;
        const next = options?.merge ? { ...(rows.get(target.path) || {}), ...value } : { ...value };
        for (const [field, item] of Object.entries(next)) if (item === DELETE_FIELD) delete next[field];
        rows.set(target.path, next);
      }
    });
  }
};

const configPath = require.resolve(path.join(ROOT, 'config.js'));
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { db, admin: { firestore: { FieldValue: { serverTimestamp: () => 'server-time', delete: () => DELETE_FIELD } } } }
};

const history = require('../lib/historyService');
const { createRouter } = require('../routes/clientData');

const INPUT = '합성 감지 입력입니다. 저장된 결과 화면을 다시 여는 경로만 확인합니다.';
const VERSION = 'synthetic-detector-v1';
const sentences = Array.from({ length: 1500 }, (_, index) => ({
  index, start: index * 60, end: index * 60 + 58,
  text: `합성 문장 ${index}번은 저장 형식 확인용이며 항목 ${index % 43}의 순서를 설명합니다.`
}));
const largeResponse = {
  ok: true, probability: 61, probSource: 'llm', summary: '큰 합성 결과', detectorVersion: VERSION,
  reportView: { status: 'ready', styleSignal: { source: 'llm' } },
  sentenceMap: { sentences }, paragraphs: sentences.map(item => ({ idx: item.index, text: item.text.repeat(3) })),
  charged: 3, remainingCredits: 97, activation: { first: true }, idempotentReplay: true, historySaved: true
};
const { charged, remainingCredits, activation, idempotentReplay, ...largeReport } = largeResponse;

async function saveDetect(requestId, response, { uid = 'owner-user', fingerprint = 'a'.repeat(64) } = {}) {
  return history.saveAnalyzeHistory({
    uid, requestId, opType: 'detect', text: INPUT, needed: 3, mode: 'detect',
    requestPayloadFingerprint: fingerprint, detectResponseCache: response,
    result: { probability: response.probability, probSource: 'llm', summary: '요약', detail: '상세', gptMeta: { engine: VERSION } }
  });
}

async function listen(deps = {}) {
  const app = express();
  app.use(express.json());
  app.use(createRouter({
    db,
    service: {},
    verifyFirebaseIdToken: async token => {
      if (token === 'bad') throw new Error('revoked');
      return { uid: token };
    },
    verifyAdminToken: async () => false,
    ...deps
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, token) => {
    const response = await fetch(`${baseUrl}/history/detect-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {})
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { post, close: () => new Promise(resolve => server.close(resolve)) };
}

test('압축 저장된 큰 감지 결과를 본인만 같은 내용으로 되읽고, 읽기는 차감·쓰기를 만들지 않는다', async t => {
  const id = 'detect-report-read-large-1';
  assert.equal((await saveDetect(id, largeResponse)).saved, true);
  const row = rows.get(`users/owner-user/history/${id}`);
  assert.equal(Object.hasOwn(row, 'detectResponseCache'), false);
  assert.ok(Buffer.isBuffer(row.detectResponseCacheEncoded.data));

  const { post, close } = await listen();
  t.after(close);
  const writesBefore = writes;
  const before = JSON.stringify([...rows.entries()].map(([key, value]) => [key, { ...value, detectResponseCacheEncoded: undefined }]));

  const first = await post({ id }, 'owner-user');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(first.body.id, id);
  // 점수·감지기 버전·문장 지도는 직렬화까지 같고, 차감 영수증은 실리지 않는다.
  assert.equal(JSON.stringify(first.body.report), JSON.stringify(largeReport));
  assert.equal(first.body.report.probability, row.probability);
  assert.equal(first.body.report.detectorVersion, row.detectorVersion);
  for (const key of ['charged', 'remainingCredits', 'activation', 'idempotentReplay']) {
    assert.equal(key in first.body.report, false, key);
    assert.equal(key in first.body, false, key);
  }
  const second = await post({ id }, 'owner-user');
  assert.equal(JSON.stringify(second.body), JSON.stringify(first.body));

  assert.equal(writes, writesBefore);
  assert.equal(rows.get('users/owner-user').credits, 100);
  assert.equal(JSON.stringify([...rows.entries()].map(([key, value]) => [key, { ...value, detectResponseCacheEncoded: undefined }])), before);
  assert.equal([...rows.keys()].some(key => /creditHistory|analyzeRequests/u.test(key)), false);

  // 다른 계정은 같은 기록 번호로도 없는 기록과 같은 응답만 받는다.
  const stranger = await post({ id }, 'other-user');
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.body, {
    ok: false, code: 'HISTORY_NOT_FOUND', error: '기록을 찾을 수 없어요.', retryable: false
  });
  assert.deepEqual(stranger.body, (await post({ id: 'never-saved-record-1' }, 'other-user')).body);
  // uid는 토큰에서만 온다. 바디로 다른 계정을 지목할 수 없다.
  assert.equal((await post({ id, uid: 'owner-user' }, 'other-user')).status, 404);
  assert.equal((await post({ id, idToken: 'owner-user' })).status, 401);
  assert.equal((await post({ id }, 'bad')).status, 401);
});

test('구형 plain 캐시도 같은 경로로 읽히고, 보관본이 없는 기록·잘못된 번호는 구분된 오류로 닫는다', async t => {
  const id = 'detect-report-read-plain-1';
  const plain = { ok: true, probability: 12.4, detectorVersion: VERSION, summary: '작은 결과', reportView: { status: 'ready' }, charged: 3 };
  assert.equal((await saveDetect(id, plain, { fingerprint: 'b'.repeat(64) })).saved, true);
  assert.equal(Object.hasOwn(rows.get(`users/owner-user/history/${id}`), 'detectResponseCacheEncoded'), false);
  rows.set('users/owner-user/history/humanize-row-1', { type: 'humanize', inputText: INPUT, outputText: '결과' });
  rows.set('users/owner-user/history/detect-legacy-row-1', { type: 'detect', inputText: INPUT, probability: 40 });

  const { post, close } = await listen();
  t.after(close);
  const ok = await post({ id }, 'owner-user');
  assert.equal(ok.status, 200);
  const { charged: _charged, ...expected } = plain;
  assert.deepEqual(ok.body.report, expected);

  for (const missing of ['humanize-row-1', 'detect-legacy-row-1']) {
    const response = await post({ id: missing }, 'owner-user');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'DETECT_REPORT_NOT_SAVED');
    assert.equal(response.body.retryable, false);
  }
  for (const invalid of ['', '../other-user/history/x', 'a/b', 'x'.repeat(129), { $ne: null }, ['a'], 7, null]) {
    const response = await post({ id: invalid }, 'owner-user');
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.equal(response.body.code, 'HISTORY_ID_INVALID');
  }
});

test('손상·초과 압축본과 점수·버전·원문이 어긋난 보관본은 내용을 내보내지 않는다', async t => {
  const base = rows.get('users/owner-user/history/detect-report-read-large-1');
  const put = (id, patch) => rows.set(`users/owner-user/history/${id}`, { ...base, ...patch });
  const encoded = base.detectResponseCacheEncoded;
  const bomb = zlib.gzipSync(Buffer.alloc(5_000_000));
  assert.ok(bomb.length < 700_000);
  put('corrupt-bytes-1', { detectResponseCacheEncoded: { ...encoded, data: Buffer.from('synthetic corruption') } });
  put('corrupt-truncated-1', { detectResponseCacheEncoded: { ...encoded, data: encoded.data.subarray(0, encoded.data.length - 40) } });
  put('corrupt-codec-1', { detectResponseCacheEncoded: { ...encoded, codec: 'unknown' } });
  put('corrupt-shape-1', { detectResponseCacheEncoded: { ...encoded, data: zlib.gzipSync(Buffer.from('[1,2,3]')) } });
  put('oversize-stored-1', { detectResponseCacheEncoded: { ...encoded, data: crypto.randomBytes(700_001) } });
  put('oversize-declared-1', { detectResponseCacheEncoded: { ...encoded, rawBytes: 4_000_001 } });
  put('oversize-expanded-1', { detectResponseCacheEncoded: { ...encoded, rawBytes: 10, data: bomb } });
  put('mismatch-score-1', { probability: 22 });
  put('mismatch-version-1', { detectorVersion: 'synthetic-detector-v2' });
  put('mismatch-input-1', { inputText: `${INPUT} 뒤에 덧붙인 문장.` });
  put('mismatch-empty-input-1', { inputText: '' });
  put('mismatch-no-score-1', { probability: null });

  const { post, close } = await listen();
  t.after(close);
  const expected = {
    'corrupt-bytes-1': [422, 'DETECT_REPORT_UNREADABLE'],
    'corrupt-truncated-1': [422, 'DETECT_REPORT_UNREADABLE'],
    'corrupt-codec-1': [422, 'DETECT_REPORT_UNREADABLE'],
    'corrupt-shape-1': [422, 'DETECT_REPORT_UNREADABLE'],
    'oversize-stored-1': [422, 'DETECT_REPORT_TOO_LARGE'],
    'oversize-declared-1': [422, 'DETECT_REPORT_TOO_LARGE'],
    'oversize-expanded-1': [422, 'DETECT_REPORT_TOO_LARGE'],
    'mismatch-score-1': [409, 'DETECT_REPORT_MISMATCH'],
    'mismatch-version-1': [409, 'DETECT_REPORT_MISMATCH'],
    'mismatch-input-1': [409, 'DETECT_REPORT_MISMATCH'],
    'mismatch-empty-input-1': [409, 'DETECT_REPORT_MISMATCH'],
    'mismatch-no-score-1': [409, 'DETECT_REPORT_MISMATCH']
  };
  const writesBefore = writes;
  for (const [id, [status, code]] of Object.entries(expected)) {
    const response = await post({ id }, 'owner-user');
    assert.equal(response.status, status, id);
    assert.equal(response.body.code, code, id);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.retryable, false, id);
    assert.equal('report' in response.body, false, id);
    assert.ok(response.body.error && !/합성 문장/u.test(JSON.stringify(response.body)), id);
  }
  assert.equal(writes, writesBefore);
});

test('저장소 장애와 예상 밖 오류는 다시 시도할 수 있는 503으로만 닫는다', async t => {
  const { post, close } = await listen();
  t.after(close);
  failReads = true;
  t.after(() => { failReads = false; });
  const outage = await post({ id: 'detect-report-read-large-1' }, 'owner-user');
  assert.equal(outage.status, 503);
  assert.deepEqual(outage.body, {
    ok: false, code: 'HISTORY_READ_UNAVAILABLE',
    error: '저장된 결과 화면을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', retryable: true
  });
  failReads = false;

  const broken = await listen({ readDetectHistoryReport: async () => { throw new TypeError('synthetic internal detail'); } });
  t.after(broken.close);
  const unexpected = await broken.post({ id: 'detect-report-read-large-1' }, 'owner-user');
  assert.equal(unexpected.status, 503);
  assert.equal(unexpected.body.code, 'HISTORY_READ_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unexpected.body), /synthetic internal detail/u);

  const limited = await listen({ historyReadLimiter: (_req, res) => res.status(429).json({ ok: false, code: 'RATE_LIMITED' }) });
  t.after(limited.close);
  assert.equal((await limited.post({ id: 'detect-report-read-large-1' }, 'owner-user')).status, 429);
});

test('숫자가 많은 결과는 JSON이 500KB 이하여도 압축본으로 저장되고, 문서 한도를 넘는 조합은 통제된 오류로 거절한다', async () => {
  const id = 'detect-report-read-numeric-1';
  const numeric = { ok: true, probability: 33, detectorVersion: VERSION, scores: Array.from({ length: 150_000 }, (_, index) => index % 10) };
  assert.ok(Buffer.byteLength(JSON.stringify(numeric), 'utf8') < 500_000);
  assert.equal((await saveDetect(id, numeric, { fingerprint: 'c'.repeat(64) })).saved, true);
  const row = rows.get(`users/owner-user/history/${id}`);
  assert.equal(Object.hasOwn(row, 'detectResponseCache'), false);
  assert.ok(row.detectResponseCacheEncoded.data.length < 700_000);
  assert.deepEqual((await history.readDetectHistoryReport({ uid: 'owner-user', historyId: id, store: db })).report, numeric);
  const ready = await history.getDetectHistoryIdempotency({
    uid: 'owner-user', requestId: id, needed: 3, requestPayloadFingerprint: 'c'.repeat(64)
  });
  assert.equal(ready.state, 'READY');
  assert.deepEqual(ready.response, numeric);

  // 압축본(약 515KB) + 나머지 필드(약 540KB)가 1MiB를 넘는 조합: Firestore 쓰기 오류 대신 같은 code로 닫고 row를 만들지 않는다.
  const incompressible = { ok: true, probability: 50, noise: crypto.randomBytes(510_000).toString('base64') };
  const writesBefore = writes;
  await assert.rejects(history.saveAnalyzeHistory({
    uid: 'owner-user', requestId: 'detect-report-read-doc-limit-1', opType: 'detect', text: INPUT, needed: 3, mode: 'detect',
    requestPayloadFingerprint: 'd'.repeat(64), detectResponseCache: incompressible,
    result: { probability: 50, probSource: 'llm', summary: '요약', detail: '가'.repeat(180_000) }
  }), error => error?.code === 'DETECT_RESPONSE_CACHE_TOO_LARGE' && error?.status === 503);
  assert.equal(writes, writesBefore);
  assert.equal(rows.has('users/owner-user/history/detect-report-read-doc-limit-1'), false);
});

test('재시도 조회는 손상된 보관본(UNREADABLE)과 저장소 장애(UNAVAILABLE)를 구분하고, 손상된 보관본은 같은 요청의 저장으로 복구된다', async () => {
  const id = 'detect-idempotency-corrupt-1';
  const fingerprint = 'b'.repeat(64);
  const query = { uid: 'owner-user', requestId: id, needed: 3, requestPayloadFingerprint: fingerprint };
  assert.deepEqual(await history.getDetectHistoryIdempotency(query), { state: 'NOT_FOUND' });

  assert.equal((await saveDetect(id, largeResponse, { fingerprint })).saved, true);
  const ready = await history.getDetectHistoryIdempotency(query);
  assert.equal(ready.state, 'READY');
  assert.deepEqual(ready.response, largeResponse);

  failReads = true;
  let outage;
  try { outage = await history.getDetectHistoryIdempotency(query); } finally { failReads = false; }
  assert.equal(outage.state, 'UNAVAILABLE');

  const key = `users/owner-user/history/${id}`;
  rows.set(key, { ...rows.get(key), detectResponseCacheEncoded: { ...rows.get(key).detectResponseCacheEncoded, data: Buffer.from('synthetic corruption') } });
  const corrupt = await history.getDetectHistoryIdempotency(query);
  assert.equal(corrupt.state, 'UNREADABLE');
  assert.equal(corrupt.error.code, 'DETECT_RESPONSE_CACHE_INVALID');
  assert.deepEqual(await history.getDetectHistoryIdempotency({ ...query, needed: 4 }), { state: 'MISMATCH' },
    '결합 확인은 보관본을 읽기 전에 끝난다');

  // 같은 요청에 고정된 결과(작은 plain 응답)로 다시 저장하면 손상된 압축본은 지워지고 새 보관본만 읽힌다.
  const smallResponse = { ok: true, probability: 61, probSource: 'llm', detectorVersion: VERSION, historySaved: true };
  const repaired = await saveDetect(id, smallResponse, { fingerprint });
  assert.equal(repaired.saved, true);
  assert.equal(repaired.duplicate, undefined, '읽을 수 없는 보관본을 기존 응답으로 돌려주지 않는다');
  assert.equal(Object.hasOwn(rows.get(key), 'detectResponseCacheEncoded'), false);
  assert.deepEqual(await history.getDetectHistoryIdempotency(query), { state: 'READY', response: smallResponse });

  // 읽을 수 있는 보관본은 뒤늦은 저장으로 바뀌지 않는다.
  const again = await saveDetect(id, { ...smallResponse, probability: 5 }, { fingerprint });
  assert.equal(again.duplicate, true);
  assert.equal(again.response.probability, 61);
});
