'use strict';

const crypto = require('crypto');
const { db, admin } = require('../config');
const { logger } = require('./logger');
const { accountDeletionBlocksWrites } = require('./accountActivityClaims');
const codec = require('./detectResponseCodec');

const COLLECTION = 'analyzeRequests';
const PURPOSE = 'detect_report_idempotency_v1';
// 보존 기한은 정리 기준이지 정확성 조건이 아니다. Firestore row는 TTL 정책이 지울 때까지(지연되거나
// 정책이 없으면 더 오래) 남고, 남아 있는 동안은 같은 요청의 결과를 그대로 replay한다. 차감된 결과를
// 기한이 지났다는 이유로 버리지 않는다. row가 사라진 뒤의 재시도는 라우트가 원장 기준으로 닫는다.
// 메모리 모드(로컬 개발 전용)만 기한을 직접 적용한다.
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/u;
const memory = new Map();

function storageKey(uid, requestId) {
  return crypto.createHash('sha256').update(`${uid}\0${requestId}`, 'utf8').digest('hex');
}

function bindingOf({ uid, requestId, payloadFingerprint, cost }) {
  return {
    uid: String(uid || ''),
    requestId: String(requestId || ''),
    payloadFingerprint: String(payloadFingerprint || ''),
    cost: Math.max(0, Math.floor(Number(cost) || 0))
  };
}

function validBinding(binding) {
  return !!binding.uid
    && /^[A-Za-z0-9][A-Za-z0-9:_-]{7,79}$/u.test(binding.requestId)
    && FINGERPRINT_RE.test(binding.payloadFingerprint)
    && binding.cost > 0;
}

function matches(row, binding) {
  return row?.purpose === PURPOSE
    && row?.uid === binding.uid
    && row?.requestId === binding.requestId
    && row?.payloadFingerprint === binding.payloadFingerprint
    && Math.max(0, Math.floor(Number(row?.cost) || 0)) === binding.cost;
}

function timestampMs(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  return 0;
}

function hasResponse(row) {
  return !!(row?.response || row?.responseEncoded);
}

// 구형 row는 plain `response`만, 큰 결과는 `responseEncoded`만 가진다.
function responseOf(row) {
  return codec.decode({ plain: row.response, encoded: row.responseEncoded });
}

function stateFromRow(row) {
  if (['COMPLETE', 'RESULT_READY'].includes(row?.status) && hasResponse(row)) {
    return { state: row.status, response: responseOf(row) };
  }
  return { state: 'PROCESSING' };
}

// 고정된 결과를 읽을 수 없는 row는 저장소 장애(UNAVAILABLE)가 아니다. 다시 읽어도 같으므로 따로 알린다.
function replayFromRow(row, binding) {
  try {
    return stateFromRow(row);
  } catch (error) {
    logger.error('detect_report.idempotency_cache_unreadable', {
      uid: binding.uid,
      requestId: binding.requestId,
      code: String(error?.code || 'DETECT_RESPONSE_CACHE_INVALID')
    });
    return { state: 'CORRUPT' };
  }
}

function keepsExisting(status, row) {
  if (!hasResponse(row)) return false;
  // 먼저 고정된 결과가 이긴다. COMPLETE는 어떤 쓰기로도 덮거나 RESULT_READY로 내리지 않는다.
  return row.status === 'COMPLETE' || (status === 'RESULT_READY' && row.status === 'RESULT_READY');
}

// claim: false면 처리 상태를 새로 잡지 않고, 잡았을 자리에서 ABSENT를 돌려준다(읽기 전용).
async function begin(input, now = Date.now(), { claim = true } = {}) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return { state: 'INVALID' };
  const key = storageKey(binding.uid, binding.requestId);
  if (!db || !admin) return beginMemory(key, binding, now, claim);
  const ref = db.collection(COLLECTION).doc(key);
  const deletionRef = db.collection('accountDeletionJobs').doc(binding.uid);
  try {
    return await db.runTransaction(async transaction => {
      const [snapshot, deletionSnapshot] = await Promise.all([
        transaction.get(ref),
        transaction.get(deletionRef)
      ]);
      if (deletionSnapshot.exists && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
        return { state: 'ACCOUNT_DELETION' };
      }
      const existing = snapshot.exists ? snapshot.data() || {} : null;
      if (existing) {
        if (!matches(existing, binding)) return { state: 'MISMATCH' };
        if (['COMPLETE', 'RESULT_READY'].includes(existing.status) && hasResponse(existing)) {
          return replayFromRow(existing, binding);
        }
        if (existing.status === 'PROCESSING') {
          const ageMs = now - timestampMs(existing.updatedAtMs || existing.updatedAt);
          // 남은 시간을 함께 돌려준다. claim을 풀지 못한 장애 뒤에도 재시도 시점을 정확히 안내할 수 있다.
          if (ageMs < STALE_PROCESSING_MS) return { state: 'PROCESSING', retryAfterMs: STALE_PROCESSING_MS - Math.max(0, ageMs) };
        }
      }
      if (!claim) return { state: 'ABSENT' };
      transaction.set(ref, {
        purpose: PURPOSE,
        ...binding,
        status: 'PROCESSING',
        createdAtMs: existing?.createdAtMs || now,
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        response: admin.firestore.FieldValue.delete(),
        responseEncoded: admin.firestore.FieldValue.delete(),
        lastBillingErrorCode: admin.firestore.FieldValue.delete()
      }, { merge: true });
      return { state: 'NEW' };
    });
  } catch (error) {
    logger.error('detect_report.idempotency_begin_failed', {
      uid: binding.uid,
      requestId: binding.requestId,
      err: error
    });
    return { state: 'UNAVAILABLE' };
  }
}

// 이미 차감된 요청의 재시도용. 고정된 결과가 없어도 처리 상태를 만들지 않는다.
async function lookup(input, now = Date.now()) {
  return begin(input, now, { claim: false });
}

async function stageResult(input, response, now = Date.now()) {
  return writeResultState(input, response, 'RESULT_READY', now);
}

async function complete(input, response, now = Date.now()) {
  return writeResultState(input, response, 'COMPLETE', now);
}

// 저장 형식 변환과 되읽기 검증. 읽을 수 없는 결과는 과금 근거로 고정하지 않는다.
// JSON이 500KB 이하여도 숫자가 많으면 plain 맵이 Firestore에서 1MiB를 넘는다. 그런 결과만 압축본으로 둔다.
async function prepareResponse(response, binding) {
  const packed = await codec.encode(response, { dedupe: true, inlineStoredMaxBytes: codec.ENCODED_MAX_BYTES });
  const fields = packed.encoded ? { responseEncoded: packed.encoded } : { response: packed.inline };
  // 결합 정보·상태·시각 필드까지 더한 문서 전체를 쓰기 전에 묶는다.
  const row = { purpose: PURPOSE, ...binding, status: 'RESULT_READY', ...fields,
    createdAtMs: 0, updatedAtMs: 0, expiresAt: 0, lastBillingErrorCode: 'x'.repeat(80) };
  if (codec.firestoreBytes(row, codec.DOCUMENT_MAX_BYTES) > codec.DOCUMENT_MAX_BYTES) {
    throw Object.assign(new Error('DETECT_RESPONSE_CACHE_TOO_LARGE'), { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  }
  return { fields, response: codec.decode({ plain: fields.response, encoded: fields.responseEncoded }) };
}

function writeMemory(key, binding, status, prepared, now) {
  const existing = memory.get(key);
  if (existing && !matches(existing, binding)) return { state: 'MISMATCH' };
  if (keepsExisting(status, existing)) return { ...replayFromRow(existing, binding), reused: true };
  memory.set(key, {
    purpose: PURPOSE,
    ...binding,
    status,
    ...prepared.fields,
    createdAtMs: existing?.createdAtMs || now,
    updatedAtMs: now,
    expiresAtMs: now + JOB_TTL_MS
  });
  return { state: status, response: prepared.response, reused: false };
}

async function writeResultState(input, response, status, now) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return { state: 'INVALID' };
  const key = storageKey(binding.uid, binding.requestId);
  const event = `detect_report.idempotency_${status === 'COMPLETE' ? 'complete' : 'stage'}_failed`;
  let prepared;
  try {
    prepared = await prepareResponse(response, binding);
  } catch (error) {
    const code = error?.code === 'DETECT_RESPONSE_CACHE_TOO_LARGE' ? error.code : 'DETECT_RESPONSE_CACHE_INVALID';
    logger.error(event, { uid: binding.uid, requestId: binding.requestId, code });
    return { state: code === 'DETECT_RESPONSE_CACHE_TOO_LARGE' ? 'TOO_LARGE' : 'UNAVAILABLE', code };
  }
  if (!db || !admin) {
    try {
      return writeMemory(key, binding, status, prepared, now);
    } catch (error) {
      logger.error(event, { uid: binding.uid, requestId: binding.requestId, err: error });
      return { state: 'UNAVAILABLE' };
    }
  }

  // Firestore가 유일한 권위다. commit 전에는 이 프로세스에도 성공 상태를 남기지 않는다.
  const ref = db.collection(COLLECTION).doc(key);
  const deletionRef = db.collection('accountDeletionJobs').doc(binding.uid);
  try {
    return await db.runTransaction(async transaction => {
      const [snapshot, deletionSnapshot] = await Promise.all([
        transaction.get(ref),
        transaction.get(deletionRef)
      ]);
      if (deletionSnapshot.exists && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
        if (snapshot.exists) transaction.delete(ref);
        return { state: 'ACCOUNT_DELETION' };
      }
      if (!snapshot.exists) return { state: 'UNAVAILABLE' };
      const existing = snapshot.data() || {};
      if (!matches(existing, binding)) return { state: 'MISMATCH' };
      if (keepsExisting(status, existing)) return { ...replayFromRow(existing, binding), reused: true };
      // update는 field를 통째로 바꾼다. merge set은 이전 결과의 key를 map 안에 남길 수 있다.
      transaction.update(ref, {
        status,
        response: prepared.fields.response || admin.firestore.FieldValue.delete(),
        responseEncoded: prepared.fields.responseEncoded || admin.firestore.FieldValue.delete(),
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        lastBillingErrorCode: admin.firestore.FieldValue.delete()
      });
      return { state: status, response: prepared.response, reused: false };
    });
  } catch (error) {
    logger.error(event, {
      uid: binding.uid,
      requestId: binding.requestId,
      err: error
    });
    return { state: 'UNAVAILABLE' };
  }
}

async function recordBillingFailure(input, error, now = Date.now()) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return;
  const key = storageKey(binding.uid, binding.requestId);
  const safeCode = String(error?.code || error?.message || 'DETECT_BILLING_UNAVAILABLE')
    .replace(/[^A-Za-z0-9_.:-]/g, '')
    .slice(0, 80) || 'DETECT_BILLING_UNAVAILABLE';
  const local = memory.get(key);
  if (local && matches(local, binding)) {
    local.lastBillingErrorCode = safeCode;
    local.updatedAtMs = now;
  }
  if (!db || !admin) return;
  try {
    const ref = db.collection(COLLECTION).doc(key);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || !matches(snapshot.data() || {}, binding)) return;
      transaction.set(ref, { lastBillingErrorCode: safeCode, updatedAtMs: now }, { merge: true });
    });
  } catch (storeError) {
    logger.warn('detect_report.idempotency_billing_failure_persist_failed', {
      uid: binding.uid,
      requestId: binding.requestId,
      err: storeError
    });
  }
}

// 반환값: claim 정리가 확인됐는지. false면 PROCESSING row가 stale 처리될 때까지 남을 수 있다.
async function releaseAfterModelFailure(input) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return true;
  const key = storageKey(binding.uid, binding.requestId);
  const local = memory.get(key);
  if (local && matches(local, binding) && local.status === 'PROCESSING') memory.delete(key);
  if (!db || !admin) return true;
  try {
    const ref = db.collection(COLLECTION).doc(key);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const existing = snapshot.data() || {};
      if (matches(existing, binding) && existing.status === 'PROCESSING') transaction.delete(ref);
    });
    return true;
  } catch (error) {
    logger.warn('detect_report.idempotency_release_failed', {
      uid: binding.uid,
      requestId: binding.requestId,
      err: error
    });
    return false;
  }
}

function beginMemory(key, binding, now, claim = true) {
  const existing = memory.get(key);
  if (existing && existing.expiresAtMs > now) {
    if (!matches(existing, binding)) return { state: 'MISMATCH' };
    if (['COMPLETE', 'RESULT_READY'].includes(existing.status) && hasResponse(existing)) return replayFromRow(existing, binding);
    if (existing.status === 'PROCESSING' && now - existing.updatedAtMs < STALE_PROCESSING_MS) {
      return { state: 'PROCESSING', retryAfterMs: STALE_PROCESSING_MS - Math.max(0, now - existing.updatedAtMs) };
    }
  }
  if (!claim) return { state: 'ABSENT' };
  memory.set(key, {
    purpose: PURPOSE,
    ...binding,
    status: 'PROCESSING',
    createdAtMs: existing?.createdAtMs || now,
    updatedAtMs: now,
    expiresAtMs: now + JOB_TTL_MS
  });
  return { state: 'NEW' };
}

function resetMemoryForTests() {
  memory.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, row] of memory) {
    if (row.expiresAtMs <= now) memory.delete(key);
  }
}, 60 * 60 * 1000).unref();

module.exports = {
  COLLECTION,
  PURPOSE,
  JOB_TTL_MS,
  STALE_PROCESSING_MS,
  storageKey,
  begin,
  lookup,
  stageResult,
  complete,
  recordBillingFailure,
  releaseAfterModelFailure,
  resetMemoryForTests
};
