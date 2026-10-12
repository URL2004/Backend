'use strict';

// 감지 응답 캐시의 저장 표현. 점수·문구·좌표는 한 글자도 바꾸지 않고 저장 형식만 줄인다.
//   - raw JSON이 INLINE_MAX_BYTES 이하면 기존과 같은 plain 맵으로 둔다(구버전 인스턴스·구형 row 호환).
//   - 초과분만 publicResponse와 겹치는 historyResult 필드를 참조로 바꾼 뒤 gzip한다.
//     gzip window(32KB)는 멀리 떨어진 reportView·sentenceMap 중복을 줄이지 못해 먼저 걷어낸다.
//   - 쓰기·읽기 모두 raw와 압축 크기를 제한해 Firestore 1MiB와 읽기 확장 크기를 묶는다.
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);
const ENCODING_VERSION = 2;
const CODEC = 'gzip-json-dedupe';
const INLINE_MAX_BYTES = 500_000;
const RAW_MAX_BYTES = 4_000_000;
const ENCODED_MAX_BYTES = 800_000;
// Firestore 한도는 1,048,576B다. 문서 이름과 근사 오차 몫을 남긴다.
const DOCUMENT_MAX_BYTES = 1_000_000;

function codecError(code) {
  return Object.assign(new Error(code), { code, status: 503 });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function splitShared(value) {
  const { publicResponse, historyResult } = value;
  if (!isPlainObject(publicResponse) || !isPlainObject(historyResult)) return { body: value, shared: [], order: [] };
  const shared = [];
  const slim = {};
  for (const [key, item] of Object.entries(historyResult)) {
    if (item && typeof item === 'object' && Object.hasOwn(publicResponse, key)
        && JSON.stringify(item) === JSON.stringify(publicResponse[key])) shared.push(key);
    else slim[key] = item;
  }
  if (!shared.length) return { body: value, shared, order: [] };
  return { body: { ...value, historyResult: slim }, shared, order: Object.keys(historyResult) };
}

function joinShared(body, shared, order) {
  if (!shared.length) return body;
  if (!isPlainObject(body?.publicResponse) || !isPlainObject(body?.historyResult)
      || !shared.every(key => typeof key === 'string' && Object.hasOwn(body.publicResponse, key))
      || !order.every(key => typeof key === 'string')) throw codecError('DETECT_RESPONSE_CACHE_INVALID');
  const sharedKeys = new Set(shared);
  const historyResult = {};
  // 원래 key 순서로 되돌려 직렬화 결과까지 저장 전과 같게 만든다.
  for (const key of order) {
    if (sharedKeys.has(key)) historyResult[key] = JSON.parse(JSON.stringify(body.publicResponse[key]));
    else if (Object.hasOwn(body.historyResult, key)) historyResult[key] = body.historyResult[key];
  }
  return { ...body, historyResult };
}

// Firestore 문서 크기 근사: 문자열은 UTF-8+1, 숫자·시각은 8, 불리언·null은 1, map은 32B와 key+1을 더한다.
// JSON에서 1~2B인 숫자가 8B가 되므로 plain 맵은 JSON 길이보다 커질 수 있다.
// limit을 넘으면 더 세지 않고 넘은 값을 돌려준다(반환값 > limit만 믿는다).
function firestoreBytes(value, limit = Infinity) {
  let total = 0;
  const visit = item => {
    if (total > limit) return;
    if (item == null || typeof item === 'boolean') total += 1;
    else if (typeof item === 'number') total += 8;
    else if (typeof item === 'string') total += Buffer.byteLength(item, 'utf8') + 1;
    else if (item instanceof Uint8Array) total += item.length;
    else if (Array.isArray(item)) for (const child of item) visit(child);
    else if (Object.getPrototypeOf(item) !== Object.prototype) total += 8;
    else {
      total += 32;
      for (const [key, child] of Object.entries(item)) {
        total += Buffer.byteLength(key, 'utf8') + 1;
        visit(child);
        if (total > limit) return;
      }
    }
  };
  visit(value);
  return total;
}

// 반환: { inline } 또는 { encoded }. 한도 초과와 직렬화 불가는 code가 붙은 오류로 던진다.
// inlineStoredMaxBytes: plain 맵의 Firestore 저장 크기가 이 값을 넘을 때만 JSON 길이와 무관하게 압축한다.
async function encode(value, {
  dedupe = false,
  inlineMaxBytes = INLINE_MAX_BYTES,
  inlineStoredMaxBytes = Infinity,
  rawMaxBytes = RAW_MAX_BYTES,
  encodedMaxBytes = ENCODED_MAX_BYTES
} = {}) {
  if (!value || typeof value !== 'object') throw codecError('DETECT_RESPONSE_CACHE_INVALID');
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw codecError('DETECT_RESPONSE_CACHE_INVALID');
  }
  const expandedBytes = Buffer.byteLength(serialized, 'utf8');
  if (expandedBytes <= inlineMaxBytes) {
    const inline = JSON.parse(serialized);
    if (!(firestoreBytes(inline, inlineStoredMaxBytes) > inlineStoredMaxBytes)) return { inline };
  }
  // 중복 제거 전 크기도 같은 한도로 묶는다. 읽을 때 되살아나는 크기가 곧 이 값이다.
  if (expandedBytes > rawMaxBytes) throw codecError('DETECT_RESPONSE_CACHE_TOO_LARGE');

  const parts = dedupe ? splitShared(JSON.parse(serialized)) : { body: value, shared: [], order: [] };
  const raw = Buffer.from(JSON.stringify({ b: parts.body, s: parts.shared, o: parts.order }), 'utf8');
  if (raw.length > rawMaxBytes) throw codecError('DETECT_RESPONSE_CACHE_TOO_LARGE');
  const data = await gzip(raw, { level: 6 });
  if (data.length > encodedMaxBytes) throw codecError('DETECT_RESPONSE_CACHE_TOO_LARGE');
  return { encoded: { v: ENCODING_VERSION, codec: CODEC, rawBytes: raw.length, data } };
}

function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return Buffer.from(value, 'base64');
  return null;
}

function decodeEncoded(encoded, { rawMaxBytes = RAW_MAX_BYTES, encodedMaxBytes = ENCODED_MAX_BYTES } = {}) {
  const data = bytesOf(encoded?.data);
  if (!isPlainObject(encoded) || encoded.v !== ENCODING_VERSION || encoded.codec !== CODEC || !data?.length) {
    throw codecError('DETECT_RESPONSE_CACHE_INVALID');
  }
  if (data.length > encodedMaxBytes || !(encoded.rawBytes <= rawMaxBytes)) {
    throw codecError('DETECT_RESPONSE_CACHE_TOO_LARGE');
  }
  let envelope;
  try {
    // maxOutputLength: 저장된 rawBytes 값을 믿지 않고 실제 확장 크기를 묶는다.
    envelope = JSON.parse(zlib.gunzipSync(data, { maxOutputLength: rawMaxBytes }).toString('utf8'));
  } catch (error) {
    throw codecError(error?.code === 'ERR_BUFFER_TOO_LARGE'
      ? 'DETECT_RESPONSE_CACHE_TOO_LARGE' : 'DETECT_RESPONSE_CACHE_INVALID');
  }
  if (!isPlainObject(envelope) || !isPlainObject(envelope.b)
      || !Array.isArray(envelope.s) || !Array.isArray(envelope.o)) throw codecError('DETECT_RESPONSE_CACHE_INVALID');
  const value = joinShared(envelope.b, envelope.s, envelope.o);
  // 참조를 되살린 뒤의 크기도 확인한다. 조작된 envelope이 공유 필드로 크기를 불릴 수 없다.
  if (envelope.s.length && Buffer.byteLength(JSON.stringify(value), 'utf8') > rawMaxBytes) {
    throw codecError('DETECT_RESPONSE_CACHE_TOO_LARGE');
  }
  return value;
}

// plain(구형·소형)과 encoded가 함께 있으면 plain이 나중에 쓰인 값이다. 새 코드는 한쪽을 쓸 때
// 다른 쪽을 지우므로, 둘이 공존하는 경우는 구버전 인스턴스가 plain을 덮어쓴 뒤뿐이다.
function decode({ plain, encoded } = {}, limits = {}) {
  if (plain && typeof plain === 'object') {
    const serialized = JSON.stringify(plain);
    if (Buffer.byteLength(serialized, 'utf8') > (limits.rawMaxBytes ?? RAW_MAX_BYTES)) {
      throw codecError('DETECT_RESPONSE_CACHE_TOO_LARGE');
    }
    return JSON.parse(serialized);
  }
  if (encoded) return decodeEncoded(encoded, limits);
  return null;
}

module.exports = {
  ENCODING_VERSION,
  CODEC,
  INLINE_MAX_BYTES,
  RAW_MAX_BYTES,
  ENCODED_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  firestoreBytes,
  encode,
  decode
};
