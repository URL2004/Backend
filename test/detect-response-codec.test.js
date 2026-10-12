'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const codec = require('../lib/detectResponseCodec');

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

// 실제 원문 대신 합성 문장으로 만든 긴 보고서 artifact. 문장 지도·보고서 뷰가
// publicResponse와 historyResult 양쪽에 그대로 실리는 운영 구조를 따른다.
function syntheticArtifact(sentenceCount = 900) {
  const sentences = [];
  let cursor = 0;
  for (let index = 0; index < sentenceCount; index += 1) {
    const text = `합성 문장 ${index}번은 저장 형식만 확인하려고 만든 예시이며 조사 대상 ${index % 37}곳의 결과를 차례로 정리합니다.`;
    sentences.push({ index, paragraphIndex: Math.floor(index / 6), start: cursor, end: cursor + text.length,
      kind: index % 5 === 0 ? 'generic' : 'plain', endingRun: index % 4, text });
    cursor += text.length + 1;
  }
  const sentenceMap = { version: 'synthetic-map', maxEndingRun: 3, sentences,
    sourceLocations: sentences.map(({ index, start, end }) => ({ index, start, end })) };
  const reportView = {
    version: 'evidence-v3-cause-aligned',
    interpretation: { version: 'detect-interpretation-v4-style-score', score: 61, headline: '합성 해석' },
    conversion: { candidateSentences: 200, targets: sentences.slice(0, 200).map(item => ({
      purpose: 'style_review', sentenceIndex: item.index, evidenceIds: [`synthetic:generic_abstraction:${item.start}:${item.end}`],
      targetSpan: { start: item.start, end: item.end, coordinateSystem: 'utf16' },
      expectedScope: { unit: 'sentence', start: item.start, end: item.end, preserveOutsideTarget: true } })) }
  };
  const paragraphs = Array.from({ length: Math.ceil(sentenceCount / 6) }, (_, idx) => ({
    idx, kind: 'thin', snippet: sentences[idx * 6].text, text: sentences.slice(idx * 6, idx * 6 + 6).map(item => item.text).join(' ') }));
  return {
    publicResponse: { ok: true, probability: 61, probSource: 'llm', summary: '합성 요약', interpretation: reportView.interpretation,
      reportView, sentenceMap, paragraphs },
    historyResult: { probability: 61, riskLevel: 'high', summary: '합성 요약', interpretation: reportView.interpretation,
      reportView, sentenceMap, signals: ['합성 신호'], probSource: 'llm', rawProbability: 61 },
    metric: { probability: 61, rawProbability: 61, grade: 'B' }
  };
}

test('500,000B 경계까지는 기존 plain 형식 그대로, 1B만 넘어도 압축 형식으로 저장한다', async () => {
  const base = { publicResponse: { ok: true, probability: 40, body: '' }, historyResult: { probability: 40 }, metric: {} };
  const room = codec.INLINE_MAX_BYTES - bytes(base);
  const hangul = '가'.repeat(Math.floor(room / 3));
  const atLimit = structuredClone(base);
  atLimit.publicResponse.body = hangul + 'a'.repeat(room - hangul.length * 3);
  assert.equal(bytes(atLimit), 500_000);

  const inline = await codec.encode(atLimit, { dedupe: true });
  assert.deepEqual(inline.inline, atLimit);
  assert.equal(inline.encoded, undefined);

  const over = structuredClone(atLimit);
  over.publicResponse.body += 'a';
  assert.equal(bytes(over), 500_001);
  const packed = await codec.encode(over, { dedupe: true });
  assert.equal(packed.inline, undefined);
  assert.equal(packed.encoded.v, 2);
  assert.ok(Buffer.isBuffer(packed.encoded.data));
  assert.ok(packed.encoded.data.length < codec.ENCODED_MAX_BYTES);
  assert.deepEqual(codec.decode({ encoded: packed.encoded }), over);
});

test('실제 길이의 합성 문장 지도는 중복을 걷어내 1MiB 안에 들어가고 직렬화까지 동일하게 복원된다', async () => {
  const artifact = syntheticArtifact();
  const rawBytes = bytes(artifact);
  assert.ok(rawBytes > 500_000, `합성 artifact는 이전 한도를 넘어야 한다: ${rawBytes}`);

  const packed = await codec.encode(artifact, { dedupe: true });
  assert.ok(packed.encoded.rawBytes < rawBytes * 0.7, '겹치는 reportView·sentenceMap은 한 번만 실어야 한다');
  assert.ok(packed.encoded.data.length < 200_000, `압축 크기 ${packed.encoded.data.length}`);

  const restored = codec.decode({ encoded: packed.encoded });
  assert.equal(JSON.stringify(restored), JSON.stringify(artifact), 'key 순서와 값이 저장 전과 같아야 한다');
  restored.historyResult.reportView.conversion.candidateSentences = 0;
  assert.equal(restored.publicResponse.reportView.conversion.candidateSentences, 200, '복원된 두 사본은 객체를 공유하지 않는다');
});

test('겹치지 않거나 값이 다른 필드는 참조로 바꾸지 않는다', async () => {
  const artifact = syntheticArtifact();
  artifact.historyResult.sentenceMap = { ...artifact.historyResult.sentenceMap, maxEndingRun: 9 };
  artifact.historyResult.summary = '이력에만 있는 요약';
  const restored = codec.decode({ encoded: (await codec.encode(artifact, { dedupe: true })).encoded });
  assert.equal(restored.historyResult.sentenceMap.maxEndingRun, 9);
  assert.equal(restored.publicResponse.sentenceMap.maxEndingRun, 3);
  assert.equal(restored.historyResult.summary, '이력에만 있는 요약');
  assert.deepEqual(restored, artifact);
});

test('압축되지 않는 초과 결과와 raw 한도 초과는 저장하지 않고 통제된 오류로 거절한다', async () => {
  const incompressible = { publicResponse: { ok: true, probability: 50,
    noise: crypto.randomBytes(900_000).toString('base64') }, historyResult: { probability: 50 }, metric: {} };
  await assert.rejects(codec.encode(incompressible, { dedupe: true }), { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });

  const compressibleButHuge = { publicResponse: { ok: true, probability: 50, filler: '가'.repeat(1_400_000) },
    historyResult: { probability: 50 }, metric: {} };
  assert.ok(bytes(compressibleButHuge) > codec.RAW_MAX_BYTES);
  await assert.rejects(codec.encode(compressibleButHuge, { dedupe: true }), { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });

  // 중복을 걷어내면 한도 안이어도, 되살아나는 크기가 한도를 넘으면 저장하지 않는다.
  const shared = { filler: '가'.repeat(800_000) };
  const expandsPastLimit = { publicResponse: { ok: true, probability: 50, shared }, historyResult: { probability: 50, shared }, metric: {} };
  assert.ok(bytes(expandsPastLimit) > codec.RAW_MAX_BYTES && bytes(expandsPastLimit.publicResponse) < codec.RAW_MAX_BYTES);
  await assert.rejects(codec.encode(expandsPastLimit, { dedupe: true }), { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });

  for (const invalid of [null, 'text', 7]) {
    await assert.rejects(codec.encode(invalid), { code: 'DETECT_RESPONSE_CACHE_INVALID' });
  }
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(codec.encode(cyclic), { code: 'DETECT_RESPONSE_CACHE_INVALID' });
});

test('읽기는 저장된 크기 표기를 믿지 않고 확장 크기와 형식을 제한한다', async () => {
  const bomb = zlib.gzipSync(Buffer.from(JSON.stringify({ b: { filler: 'a'.repeat(6_000_000) }, s: [], o: [] })));
  assert.ok(bomb.length < codec.ENCODED_MAX_BYTES);
  assert.throws(() => codec.decode({ encoded: { v: 2, codec: codec.CODEC, rawBytes: 10, data: bomb } }),
    { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });

  const packed = (await codec.encode(syntheticArtifact(), { dedupe: true })).encoded;
  assert.throws(() => codec.decode({ encoded: { ...packed, rawBytes: codec.RAW_MAX_BYTES + 1 } }),
    { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  assert.throws(() => codec.decode({ encoded: { ...packed, data: Buffer.alloc(codec.ENCODED_MAX_BYTES + 1) } }),
    { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  // 공유 참조로 raw 한도 안의 envelope을 한도 밖으로 불리는 조작도 읽지 않는다.
  const inflating = zlib.gzipSync(Buffer.from(JSON.stringify({
    b: { publicResponse: { shared: 'a'.repeat(3_000_000) }, historyResult: {} }, s: ['shared'], o: ['shared'] })));
  assert.throws(() => codec.decode({ encoded: { v: 2, codec: codec.CODEC, rawBytes: 3_000_100, data: inflating } }),
    { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  for (const broken of [
    { ...packed, v: 1 }, { ...packed, codec: 'other' }, { ...packed, data: Buffer.from('not gzip') },
    { ...packed, data: null }, { ...packed, data: zlib.gzipSync(Buffer.from('[]')) },
    { ...packed, data: zlib.gzipSync(Buffer.from(JSON.stringify({ b: { publicResponse: {}, historyResult: {} }, s: ['missing'], o: ['missing'] }))) }
  ]) {
    assert.throws(() => codec.decode({ encoded: broken }), { code: 'DETECT_RESPONSE_CACHE_INVALID' });
  }
});

test('구형 plain 캐시와 Firestore가 돌려주는 bytes 표현을 모두 읽는다', async () => {
  const legacy = { publicResponse: { ok: true, probability: 72 }, historyResult: { probability: 72 }, metric: { probability: 72 } };
  const read = codec.decode({ plain: legacy });
  assert.deepEqual(read, legacy);
  assert.notEqual(read, legacy);
  assert.equal(codec.decode({}), null);

  const artifact = syntheticArtifact();
  const packed = (await codec.encode(artifact, { dedupe: true })).encoded;
  assert.deepEqual(codec.decode({ encoded: { ...packed, data: new Uint8Array(packed.data) } }), artifact);
  assert.deepEqual(codec.decode({ encoded: { ...packed, data: packed.data.toString('base64') } }), artifact);
  // 구버전 인스턴스가 나중에 덮어쓴 plain이 남은 압축본보다 우선한다.
  assert.deepEqual(codec.decode({ plain: legacy, encoded: packed }), legacy);
});

test('firestoreBytes는 Firestore 저장 크기를 근사하고 한도를 넘으면 더 세지 않는다', () => {
  assert.equal(codec.firestoreBytes({ a: 1, b: 'xy', c: [true, null], d: { e: 2.5 } }), 64 + (2 + 8) + (2 + 3) + (2 + 2) + (2 + 2 + 8));
  assert.equal(codec.firestoreBytes({ data: Buffer.alloc(100) }), 32 + 5 + 100);
  const numbers = Array.from({ length: 200_000 }, () => 7);
  assert.equal(codec.firestoreBytes(numbers), 1_600_000);
  const bounded = codec.firestoreBytes({ first: numbers, second: numbers }, 1000);
  assert.ok(bounded > 1000 && bounded < 1100, `한도 직후에 멈춰야 한다: ${bounded}`);
});

test('inlineStoredMaxBytes는 저장 크기가 넘을 때만 압축을 강제하고 내용은 그대로 되읽힌다', async () => {
  const heavy = { publicResponse: { ok: true, probability: 12, offsets: Array.from({ length: 120_000 }, (_, i) => i % 7) },
    historyResult: { probability: 12 }, metric: {} };
  assert.ok(Buffer.byteLength(JSON.stringify(heavy), 'utf8') < codec.INLINE_MAX_BYTES);
  assert.ok((await codec.encode(heavy)).inline, '옵션이 없으면 기존처럼 plain이다');
  const packed = await codec.encode(heavy, { dedupe: true, inlineStoredMaxBytes: codec.ENCODED_MAX_BYTES });
  assert.ok(packed.encoded && !packed.inline);
  assert.ok(packed.encoded.data.length < 50_000);
  assert.deepEqual(codec.decode({ encoded: packed.encoded }), heavy);

  const light = { publicResponse: { ok: true, probability: 12, summary: '문장'.repeat(1000) }, historyResult: {}, metric: {} };
  assert.deepEqual((await codec.encode(light, { inlineStoredMaxBytes: codec.ENCODED_MAX_BYTES })).inline, light);
  const maps = { offsets: Array.from({ length: 35000 }, () => ({})) };
  assert.ok(Buffer.byteLength(JSON.stringify(maps)) < codec.INLINE_MAX_BYTES);
  assert.ok(codec.firestoreBytes(maps) > 1048576, 'empty maps still incur 32 bytes each');
  const packedMaps = await codec.encode(maps, { inlineStoredMaxBytes: codec.ENCODED_MAX_BYTES });
  assert.ok(packedMaps.encoded);
  assert.deepEqual(codec.decode({ encoded: packedMaps.encoded }), maps);
});
