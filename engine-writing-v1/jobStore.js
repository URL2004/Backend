'use strict';

const crypto = require('crypto');
const { db, admin } = require('../config');
const { logger } = require('../lib/logger');
const {
  COLLECTION: ACCOUNT_ACTIVITY_COLLECTION,
  WRITING_CLAIM_TTL_MS,
  WRITING_LANE,
  accountDeletionBlocksWrites,
  deletionInProgressError,
  laneWithClaim,
  laneWithoutClaim,
} = require('../lib/accountActivityClaims');

const memory = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/u.test(id)) return '';
  return id;
}

function storageKey(uid, requestId) {
  return crypto.createHash('sha256').update(`${uid}:${requestId}`).digest('hex');
}

async function begin(uid, requestId, inputHash, now = Date.now()) {
  const id = normalizeRequestId(requestId);
  if (!id) return { state: 'INVALID' };
  const key = storageKey(uid, id);
  if (!db || !admin) return beginMemory(key, uid, id, inputHash, now);
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
    return await db.runTransaction(async transaction => {
      const [snap, deletionSnapshot, activitySnapshot] = await Promise.all([
        transaction.get(ref),
        transaction.get(deletionRef),
        transaction.get(activityRef),
      ]);
      if (deletionSnapshot.exists
        && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
        return { state: 'ACCOUNT_DELETION' };
      }
      const existing = snap.exists ? snap.data() : null;
      if (existing) {
        if (existing.uid !== uid || existing.requestId !== id) return { state: 'FORBIDDEN' };
        if (existing.inputHash !== inputHash) return { state: 'MISMATCH' };
        if (existing.status === 'READY' && existing.result) return { state: 'READY', result: existing.result };
        const updatedAtMs = timestampMs(existing.updatedAtMs || existing.updatedAt);
        if (existing.status === 'PROCESSING' && now - updatedAtMs < STALE_PROCESSING_MS) {
          const activity = activitySnapshot.exists ? activitySnapshot.data() || {} : {};
          transaction.set(activityRef, {
            uid,
            [WRITING_LANE]: laneWithClaim(activity, WRITING_LANE, {
              id: key,
              status: 'PROCESSING',
              ttlMs: WRITING_CLAIM_TTL_MS,
            }, now),
            updatedAtMs: now,
          }, { merge: true });
          return { state: 'PROCESSING' };
        }
      }
      transaction.set(ref, {
        uid,
        requestId: id,
        inputHash,
        status: 'PROCESSING',
        createdAtMs: existing?.createdAtMs || now,
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        error: admin.firestore.FieldValue.delete(),
        result: admin.firestore.FieldValue.delete()
      }, { merge: true });
      const activity = activitySnapshot.exists ? activitySnapshot.data() || {} : {};
      transaction.set(activityRef, {
        uid,
        [WRITING_LANE]: laneWithClaim(activity, WRITING_LANE, {
          id: key,
          status: 'PROCESSING',
          ttlMs: WRITING_CLAIM_TTL_MS,
        }, now),
        updatedAtMs: now,
      }, { merge: true });
      return { state: 'NEW' };
    });
  } catch (error) {
    logger.error('writinglab.job_begin_failed', { uid, requestId: id, err: error });
    return { state: 'UNAVAILABLE' };
  }
}

async function complete(uid, requestId, inputHash, result, now = Date.now()) {
  const id = normalizeRequestId(requestId);
  if (!id) throw new Error('INVALID_WRITING_JOB_ID');
  const key = storageKey(uid, id);
  const safeResult = JSON.parse(JSON.stringify(result));
  const row = { uid, requestId: id, inputHash, status: 'READY', result: safeResult, createdAtMs: now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS };
  memory.set(key, row);
  if (!db || !admin) return;
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
    const persisted = await db.runTransaction(async transaction => {
      const [deletionSnapshot, activitySnapshot] = await Promise.all([
        transaction.get(deletionRef),
        transaction.get(activityRef),
      ]);
      const activity = activitySnapshot.exists ? activitySnapshot.data() || {} : {};
      const release = {
        uid,
        [WRITING_LANE]: laneWithoutClaim(activity, WRITING_LANE, key, now),
        updatedAtMs: now,
      };
      if (deletionSnapshot.exists
        && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
        transaction.delete(ref);
        if (activitySnapshot.exists) transaction.set(activityRef, release, { merge: true });
        return { blocked: true };
      }
      transaction.set(ref, {
        uid,
        requestId: id,
        inputHash,
        status: 'READY',
        result: safeResult,
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        error: admin.firestore.FieldValue.delete()
      }, { merge: true });
      transaction.set(activityRef, release, { merge: true });
      return { blocked: false };
    });
    if (persisted.blocked) {
      memory.delete(key);
      throw deletionInProgressError();
    }
  } catch (error) {
    logger.error('writinglab.job_complete_persist_failed', { uid, requestId: id, err: error });
    if (error?.code === 'ACCOUNT_DELETION_IN_PROGRESS') throw error;
    throw Object.assign(new Error('WRITING_JOB_PERSIST_UNAVAILABLE'), {
      code: 'WRITING_JOB_PERSIST_UNAVAILABLE',
      status: 503,
    });
  }
}

async function fail(uid, requestId, inputHash, error, now = Date.now()) {
  const id = normalizeRequestId(requestId);
  if (!id) return;
  const key = storageKey(uid, id);
  const failure = {
    code: String(error?.code || 'WRITING_ENGINE_FAILED').slice(0, 100),
    message: String(error?.message || '글 생성에 실패했어요.').slice(0, 500),
    retryable: ![400, 403, 409, 422].includes(Number(error?.status || 0))
  };
  memory.set(key, { uid, requestId: id, inputHash, status: 'FAILED', error: failure, createdAtMs: now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS });
  if (!db || !admin) return;
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
    await db.runTransaction(async transaction => {
      const [deletionSnapshot, activitySnapshot] = await Promise.all([
        transaction.get(deletionRef),
        transaction.get(activityRef),
      ]);
      const activity = activitySnapshot.exists ? activitySnapshot.data() || {} : {};
      const release = {
        uid,
        [WRITING_LANE]: laneWithoutClaim(activity, WRITING_LANE, key, now),
        updatedAtMs: now,
      };
      if (deletionSnapshot.exists
        && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
        transaction.delete(ref);
        if (activitySnapshot.exists) transaction.set(activityRef, release, { merge: true });
        return;
      }
      transaction.set(ref, {
        uid,
        requestId: id,
        inputHash,
        status: 'FAILED',
        error: failure,
        updatedAtMs: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        result: admin.firestore.FieldValue.delete()
      }, { merge: true });
      transaction.set(activityRef, release, { merge: true });
    });
  } catch (storeError) {
    logger.warn('writinglab.job_fail_persist_failed', { uid, requestId: id, err: storeError });
  }
}

async function get(uid, requestId) {
  const id = normalizeRequestId(requestId);
  if (!id) return { state: 'INVALID' };
  const key = storageKey(uid, id);
  const local = memory.get(key);
  if (local && local.expiresAtMs > Date.now()) return responseState(local);
  if (!db) return { state: 'NOT_FOUND' };
  try {
    const snap = await db.collection('writingLabV2Jobs').doc(key).get();
    if (!snap.exists) return { state: 'NOT_FOUND' };
    const row = snap.data();
    if (row.uid !== uid || row.requestId !== id) return { state: 'FORBIDDEN' };
    return responseState(row);
  } catch (error) {
    logger.error('writinglab.job_read_failed', { uid, requestId: id, err: error });
    return local ? responseState(local) : { state: 'UNAVAILABLE' };
  }
}

function beginMemory(key, uid, requestId, inputHash, now) {
  const existing = memory.get(key);
  if (existing && existing.expiresAtMs > now) {
    if (existing.uid !== uid || existing.requestId !== requestId) return { state: 'FORBIDDEN' };
    if (existing.inputHash !== inputHash) return { state: 'MISMATCH' };
    if (existing.status === 'READY') return { state: 'READY', result: existing.result };
    if (existing.status === 'PROCESSING' && now - existing.updatedAtMs < STALE_PROCESSING_MS) return { state: 'PROCESSING' };
  }
  memory.set(key, {
    uid, requestId, inputHash, status: 'PROCESSING',
    createdAtMs: existing?.createdAtMs || now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS
  });
  return { state: 'NEW' };
}

function responseState(row) {
  if (row.status === 'READY' && row.result) return { state: 'READY', inputHash: row.inputHash, result: row.result };
  if (row.status === 'FAILED') return { state: 'FAILED', inputHash: row.inputHash, error: row.error || null };
  if (row.status === 'PROCESSING') return { state: 'PROCESSING', inputHash: row.inputHash };
  return { state: 'NOT_FOUND' };
}

function timestampMs(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (value?.toMillis) return value.toMillis();
  return 0;
}

function resetMemoryForTests() { memory.clear(); }

setInterval(() => {
  const now = Date.now();
  for (const [key, row] of memory) if (row.expiresAtMs <= now) memory.delete(key);
}, 60 * 60 * 1000).unref();

module.exports = {
  JOB_TTL_MS,
  STALE_PROCESSING_MS,
  normalizeRequestId,
  storageKey,
  begin,
  complete,
  fail,
  get,
  resetMemoryForTests
};
