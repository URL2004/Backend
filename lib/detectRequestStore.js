'use strict';

const crypto = require('crypto');
const { db, admin } = require('../config');
const { logger } = require('./logger');
const { accountDeletionBlocksWrites } = require('./accountActivityClaims');

const COLLECTION = 'analyzeRequests';
const PURPOSE = 'detect_report_idempotency_v1';
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

function cloneResponse(value) {
  if (!value || typeof value !== 'object') throw new Error('DETECT_RESPONSE_CACHE_INVALID');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 500_000) {
    throw Object.assign(new Error('DETECT_RESPONSE_CACHE_TOO_LARGE'), { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  }
  return JSON.parse(serialized);
}

function stateFromRow(row) {
  if (row?.status === 'COMPLETE' && row.response) {
    return { state: 'COMPLETE', response: cloneResponse(row.response) };
  }
  if (row?.status === 'RESULT_READY' && row.response) {
    return { state: 'RESULT_READY', response: cloneResponse(row.response) };
  }
  return { state: 'PROCESSING' };
}

async function begin(input, now = Date.now()) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return { state: 'INVALID' };
  const key = storageKey(binding.uid, binding.requestId);
  if (!db || !admin) return beginMemory(key, binding, now);
  const ref = db.collection(COLLECTION).doc(key);
  const deletionRef = db.collection('accountDeletionJobs').doc(binding.uid);
  try {
    const result = await db.runTransaction(async transaction => {
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
        if (['COMPLETE', 'RESULT_READY'].includes(existing.status) && existing.response) {
          return stateFromRow(existing);
        }
        if (existing.status === 'PROCESSING'
          && now - timestampMs(existing.updatedAtMs || existing.updatedAt) < STALE_PROCESSING_MS) {
          return { state: 'PROCESSING' };
        }
      }
      transaction.set(ref, {
        purpose: PURPOSE,
        ...binding,
        status: 'PROCESSING',
        createdAtMs: existing?.createdAtMs || now,
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        response: admin.firestore.FieldValue.delete(),
        lastBillingErrorCode: admin.firestore.FieldValue.delete()
      }, { merge: true });
      return { state: 'NEW' };
    });
    if (result.state === 'NEW') {
      memory.set(key, { purpose: PURPOSE, ...binding, status: 'PROCESSING', createdAtMs: now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS });
    }
    return result;
  } catch (error) {
    logger.error('detect_report.idempotency_begin_failed', {
      uid: binding.uid,
      requestId: binding.requestId,
      err: error
    });
    return { state: 'UNAVAILABLE' };
  }
}

async function stageResult(input, response, now = Date.now()) {
  return writeResultState(input, response, 'RESULT_READY', now);
}

async function complete(input, response, now = Date.now()) {
  return writeResultState(input, response, 'COMPLETE', now);
}

async function writeResultState(input, response, status, now) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return { state: 'INVALID' };
  const safeResponse = cloneResponse(response);
  const key = storageKey(binding.uid, binding.requestId);
  const localExisting = memory.get(key);
  if (localExisting && !matches(localExisting, binding)) return { state: 'MISMATCH' };
  if (status === 'RESULT_READY' && ['RESULT_READY', 'COMPLETE'].includes(localExisting?.status) && localExisting.response) {
    return stateFromRow(localExisting);
  }
  memory.set(key, {
    purpose: PURPOSE,
    ...binding,
    status,
    response: safeResponse,
    createdAtMs: localExisting?.createdAtMs || now,
    updatedAtMs: now,
    expiresAtMs: now + JOB_TTL_MS
  });
  if (!db || !admin) return { state: status, response: safeResponse };

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
        memory.delete(key);
        return { state: 'ACCOUNT_DELETION' };
      }
      if (!snapshot.exists) return { state: 'UNAVAILABLE' };
      const existing = snapshot.data() || {};
      if (!matches(existing, binding)) return { state: 'MISMATCH' };
      if (status === 'RESULT_READY' && ['RESULT_READY', 'COMPLETE'].includes(existing.status) && existing.response) {
        return stateFromRow(existing);
      }
      if (status === 'COMPLETE' && existing.status === 'COMPLETE' && existing.response) {
        return stateFromRow(existing);
      }
      transaction.set(ref, {
        status,
        response: safeResponse,
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        lastBillingErrorCode: admin.firestore.FieldValue.delete()
      }, { merge: true });
      return { state: status, response: safeResponse };
    });
  } catch (error) {
    logger.error(`detect_report.idempotency_${status === 'COMPLETE' ? 'complete' : 'stage'}_failed`, {
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

async function releaseAfterModelFailure(input) {
  const binding = bindingOf(input || {});
  if (!validBinding(binding)) return;
  const key = storageKey(binding.uid, binding.requestId);
  const local = memory.get(key);
  if (local && matches(local, binding) && local.status === 'PROCESSING') memory.delete(key);
  if (!db || !admin) return;
  try {
    const ref = db.collection(COLLECTION).doc(key);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const existing = snapshot.data() || {};
      if (matches(existing, binding) && existing.status === 'PROCESSING') transaction.delete(ref);
    });
  } catch (error) {
    logger.warn('detect_report.idempotency_release_failed', {
      uid: binding.uid,
      requestId: binding.requestId,
      err: error
    });
  }
}

function beginMemory(key, binding, now) {
  const existing = memory.get(key);
  if (existing && existing.expiresAtMs > now) {
    if (!matches(existing, binding)) return { state: 'MISMATCH' };
    if (['COMPLETE', 'RESULT_READY'].includes(existing.status) && existing.response) return stateFromRow(existing);
    if (existing.status === 'PROCESSING' && now - existing.updatedAtMs < STALE_PROCESSING_MS) {
      return { state: 'PROCESSING' };
    }
  }
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
  stageResult,
  complete,
  recordBillingFailure,
  releaseAfterModelFailure,
  resetMemoryForTests
};
