'use strict';

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { creditHistoryDocumentId } = require('../lib/creditLotAccounting');
const { settleWithin } = require('./requestLifecycle');
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
// Legacy rows without a lease use the old staleness rule.
const STALE_PROCESSING_MS = 10 * 60 * 1000;
// Processing ownership is a renewable lease. The owner renews it while it
// works; another request may take over only after it expires. A lease is
// never renewed past deadline + grace, so the whole run is bounded even if an
// owner keeps renewing. Completion and failure writes are fenced by leaseId.
const LEASE_TTL_MS = 90 * 1000;
const FINISH_GRACE_MS = 60 * 1000;
const DEFAULT_WORK_DEADLINE_MS = 8 * 60 * 1000;
const MAX_STAGED_COMPLETION_BYTES = 700 * 1024;

function leaseLostError() {
  return Object.assign(new Error('WRITING_JOB_LEASE_LOST'), { code: 'WRITING_JOB_LEASE_LOST', status: 409 });
}

function processingActive(row, now) {
  if (row?.status !== 'PROCESSING') return false;
  const leaseExpiresAtMs = Number(row.leaseExpiresAtMs);
  if (row.leaseId && Number.isFinite(leaseExpiresAtMs)) return now < leaseExpiresAtMs;
  if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > 0) return now < leaseExpiresAtMs;
  return now - timestampMs(row.updatedAtMs || row.updatedAt) < STALE_PROCESSING_MS;
}

function newLease(now, deadlineMs) {
  const workMs = Math.max(1000, Math.min(STALE_PROCESSING_MS - FINISH_GRACE_MS, Number(deadlineMs) || DEFAULT_WORK_DEADLINE_MS));
  const deadlineAtMs = now + workMs;
  return {
    leaseId: crypto.randomBytes(12).toString('hex'),
    deadlineAtMs,
    leaseExpiresAtMs: Math.min(now + LEASE_TTL_MS, deadlineAtMs + FINISH_GRACE_MS)
  };
}

// null = the caller still owns the lease; otherwise the refusal reason.
function leaseRefusal(row, leaseId, now) {
  if (!row || row.status !== 'PROCESSING' || row.leaseId !== leaseId) return 'LEASE_LOST';
  if (now >= Number(row.leaseExpiresAtMs || 0)) return 'LEASE_EXPIRED';
  return null;
}

function ownedRow(row, uid, inputHash, leaseId, now, { allowExpired = false } = {}) {
  const refused = leaseRefusal(row, leaseId, now);
  if (row?.uid !== uid || row?.inputHash !== inputHash || refused === 'LEASE_LOST'
      || (!allowExpired && refused === 'LEASE_EXPIRED')) throw leaseLostError();
  return row;
}

function safeCompletion(value) {
  const pending = JSON.parse(JSON.stringify(value));
  if (pending?.version !== 'writing-completion-v1' || pending.payload?.ok !== true
      || pending.payload?.status !== 'READY' || typeof pending.payload?.draft !== 'string'
      || !pending.payload.draft || !Number.isInteger(pending.needed) || pending.needed < 0
      || typeof pending.applied !== 'boolean') {
    throw Object.assign(new Error('WRITING_COMPLETION_INVALID'), { code: 'WRITING_COMPLETION_INVALID', status: 500 });
  }
  pending.stageId = crypto.randomBytes(16).toString('hex');
  if (Buffer.byteLength(JSON.stringify(pending), 'utf8') > MAX_STAGED_COMPLETION_BYTES) {
    throw Object.assign(new Error('WRITING_COMPLETION_TOO_LARGE'), { code: 'WRITING_COMPLETION_TOO_LARGE', status: 413 });
  }
  return pending;
}

function billingFromReceipt(intent, receipt) {
  return receipt && typeof receipt.applied === 'boolean'
    ? { ...intent, applied: receipt.applied, credits: receipt.credits, plan: receipt.plan ?? intent.plan }
    : intent;
}

function completionResult(row, supplied) {
  if (!row?.pendingCompletion) return supplied;
  if (row.pendingCompletion.applied && !row.pendingCompletion.billingReceipt) {
    throw Object.assign(new Error('WRITING_BILLING_RECEIPT_REQUIRED'), { code: 'WRITING_BILLING_RECEIPT_REQUIRED', status: 503 });
  }
  const expected = row.pendingCompletion.payload;
  // Usage is finalized after the idempotent daily-cap commit. Every piece of
  // the delivered text, signed context, billing promise and review is fixed.
  const billing = billingFromReceipt(expected.billing, row.pendingCompletion.billingReceipt);
  if (!isDeepStrictEqual({ ...supplied, usage: null }, { ...expected, billing, usage: null })) {
    throw Object.assign(new Error('WRITING_STAGED_RESULT_MISMATCH'), { code: 'WRITING_STAGED_RESULT_MISMATCH', status: 409 });
  }
  return { ...expected, billing, usage: supplied.usage };
}

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/u.test(id)) return '';
  return id;
}

function storageKey(uid, requestId) {
  return crypto.createHash('sha256').update(`${uid}:${requestId}`).digest('hex');
}

async function begin(uid, requestId, inputHash, now = Date.now(), { deadlineMs } = {}) {
  const id = normalizeRequestId(requestId);
  if (!id) return { state: 'INVALID' };
  const key = storageKey(uid, id);
  const lease = newLease(now, deadlineMs);
  if (!db || !admin) return beginMemory(key, uid, id, inputHash, now, lease);
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
    return await settleWithin(() => db.runTransaction(async transaction => {
      const deletionSnapshot = await transaction.get(deletionRef);
      const activitySnapshot = await transaction.get(activityRef);
      const snap = await transaction.get(ref);
      if (deletionSnapshot.exists
        && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
        return { state: 'ACCOUNT_DELETION' };
      }
      const existing = snap.exists ? snap.data() : null;
      if (existing) {
        if (existing.uid !== uid || existing.requestId !== id) return { state: 'FORBIDDEN' };
        if (existing.inputHash !== inputHash) return { state: 'MISMATCH' };
        if (existing.status === 'READY' && existing.result) return { state: 'READY', result: existing.result };
        if (existing.status === 'FAILED' && existing.compensated === true) return responseState(existing);
        if (processingActive(existing, now)) {
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
        if (existing.status === 'PROCESSING') {
          logger.warn('writinglab.job_lease_takeover', { uid, requestId: id, previousLeaseExpiresAtMs: Number(existing.leaseExpiresAtMs) || null });
        }
      }
      transaction.set(ref, {
        uid,
        requestId: id,
        inputHash,
        status: 'PROCESSING',
        createdAtMs: existing?.createdAtMs || now,
        updatedAtMs: now,
        leaseId: lease.leaseId,
        leaseExpiresAtMs: lease.leaseExpiresAtMs,
        deadlineAtMs: lease.deadlineAtMs,
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
      memory.delete(key);
      return { state: 'NEW', ...lease, ...(existing?.pendingCompletion ? { pendingCompletion: existing.pendingCompletion } : {}) };
    }));
  } catch (error) {
    logger.error('writinglab.job_begin_failed', { uid, requestId: id, err: error });
    return { state: 'UNAVAILABLE' };
  }
}

// Store the exact verified result before any debit. A takeover resumes this
// completion; it must never generate a replacement for an already paid draft.
async function stageCompletion(uid, requestId, inputHash, completion, now = Date.now(), { leaseId } = {}) {
  const id = normalizeRequestId(requestId);
  if (!id || !leaseId) throw leaseLostError();
  const key = storageKey(uid, id);
  const pending = safeCompletion(completion);
  if (!db || !admin) {
    const row = ownedRow(memory.get(key), uid, inputHash, leaseId, now);
    row.pendingCompletion ||= pending;
    row.expiresAtMs = now + JOB_TTL_MS;
    return JSON.parse(JSON.stringify(row.pendingCompletion));
  }
  const ref = db.collection('writingLabV2Jobs').doc(key);
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  return db.runTransaction(async transaction => {
    const deletion = await transaction.get(deletionRef);
    const snapshot = await transaction.get(ref);
    if (deletion.exists && accountDeletionBlocksWrites(deletion.data() || {})) throw deletionInProgressError();
    const row = ownedRow(snapshot.exists ? snapshot.data() : null, uid, inputHash, leaseId, Date.now());
    if (row.pendingCompletion) return row.pendingCompletion;
    transaction.set(ref, { pendingCompletion: pending, updatedAtMs: now,
      expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS) }, { merge: true });
    return pending;
  });
}

// Trusted server-only hook, called INSIDE the credit/usage/refund transaction.
// Reading this row makes a takeover conflict with an old owner's side effect.
// No hook or ownership field is accepted from an HTTP request.
async function assertSideEffectOwnership(transaction, uid, requestId, inputHash, leaseId, { restoring = false, stageId } = {}) {
  const id = normalizeRequestId(requestId);
  if (!id || !leaseId) throw leaseLostError();
  const key = storageKey(uid, id);
  let row;
  if (!db || !admin) row = memory.get(key);
  else {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const deletion = await transaction.get(deletionRef);
    if (deletion.exists && accountDeletionBlocksWrites(deletion.data() || {})) throw deletionInProgressError();
    // Match deletion/admission ordering before locking the content row.
    await transaction.get(db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid));
    const snapshot = await transaction.get(ref);
    row = snapshot.exists ? snapshot.data() : null;
  }
  ownedRow(row, uid, inputHash, leaseId, Date.now(), { allowExpired: !!row?.pendingCompletion });
  if (!row.pendingCompletion || (stageId && row.pendingCompletion.stageId !== stageId)) throw leaseLostError();
  if (db && admin && row.pendingCompletion.applied && !restoring) {
    const restored = await transaction.get(db.collection('users').doc(uid).collection('creditHistory')
      .doc(creditHistoryDocumentId('restore', id)));
    if (restored.exists) throw Object.assign(new Error('WRITING_JOB_ALREADY_RESTORED'), {
      code: 'WRITING_JOB_ALREADY_RESTORED', status: 409
    });
  }
  return row.pendingCompletion;
}

async function prepareDebitCompletion(transaction, uid, requestId, inputHash, leaseId, stageId) {
  const pending = await assertSideEffectOwnership(transaction, uid, requestId, inputHash, leaseId, { stageId });
  const key = storageKey(uid, requestId);
  if (db && admin) {
    const previous = await transaction.get(db.collection('users').doc(uid).collection('creditHistory')
      .doc(creditHistoryDocumentId('deduct', requestId)));
    if (previous.exists && (previous.data()?.type !== 'writing_lab_v2_generate'
        || Number(previous.data()?.used) !== pending.needed)) {
      throw Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), { code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    }
  }
  return receipt => {
    const billingReceipt = { applied: receipt.applied === true, credits: Number(receipt.credits) || 0, plan: receipt.plan || null };
    if (!db || !admin) {
      const row = ownedRow(memory.get(key), uid, inputHash, leaseId, Date.now(), { allowExpired: true });
      row.pendingCompletion = { ...pending, billingReceipt };
    } else transaction.set(db.collection('writingLabV2Jobs').doc(key), {
      pendingCompletion: { ...pending, billingReceipt }, updatedAtMs: Date.now()
    }, { merge: true });
  };
}

// Return deferred writes: all refund/history/lot reads must happen before
// this callback runs. Refund and terminalization then commit atomically.
async function prepareCompensatedCompletion(transaction, uid, requestId, inputHash, leaseId, stageId) {
  await assertSideEffectOwnership(transaction, uid, requestId, inputHash, leaseId, { restoring: true, stageId });
  const key = storageKey(uid, requestId);
  const failure = { code: 'DAILY_CAP', message: '이용 한도에 도달해 이번 요청의 결제를 복원했어요.', retryable: false };
  if (!db || !admin) return () => {
    const row = ownedRow(memory.get(key), uid, inputHash, leaseId, Date.now(), { allowExpired: true });
    const terminal = { ...row, status: 'FAILED', compensated: true, error: failure, updatedAtMs: Date.now() };
    delete terminal.pendingCompletion; delete terminal.leaseExpiresAtMs;
    memory.set(key, terminal);
  };
  const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
  const activitySnapshot = await transaction.get(activityRef);
  const activity = activitySnapshot.exists ? activitySnapshot.data() || {} : {};
  return () => {
    const now = Date.now();
    transaction.set(db.collection('writingLabV2Jobs').doc(key), {
      status: 'FAILED', compensated: true, error: failure, updatedAtMs: now,
      pendingCompletion: admin.firestore.FieldValue.delete(),
      leaseExpiresAtMs: admin.firestore.FieldValue.delete(),
      result: admin.firestore.FieldValue.delete(),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS)
    }, { merge: true });
    transaction.set(activityRef, { uid, [WRITING_LANE]: laneWithoutClaim(activity, WRITING_LANE, key, now), updatedAtMs: now }, { merge: true });
  };
}

async function complete(uid, requestId, inputHash, result, now = Date.now(), { leaseId, cost } = {}) {
  const id = normalizeRequestId(requestId);
  if (!id) throw new Error('INVALID_WRITING_JOB_ID');
  const key = storageKey(uid, id);
  let safeResult = JSON.parse(JSON.stringify(result));
  const safeCost = sanitizeCost(cost);
  const row = { uid, requestId: id, inputHash, status: 'READY', result: safeResult, ...(safeCost ? { cost: safeCost } : {}),
    createdAtMs: now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS };
  if (!db || !admin) {
    // A request that lost its lease must not overwrite the current owner.
    const current = memory.get(key);
    if (leaseId) ownedRow(current, uid, inputHash, leaseId, now, { allowExpired: !!current?.pendingCompletion });
    safeResult = completionResult(current, safeResult);
    row.result = safeResult;
    memory.set(key, row);
    return;
  }
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
    const persisted = await db.runTransaction(async transaction => {
      const deletionSnapshot = await transaction.get(deletionRef);
      const activitySnapshot = await transaction.get(activityRef);
      const snap = await transaction.get(ref);
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
      const current = snap.exists ? snap.data() : null;
      if (leaseId) ownedRow(current, uid, inputHash, leaseId, Date.now(), { allowExpired: !!current?.pendingCompletion });
      safeResult = completionResult(current, safeResult);
      transaction.set(ref, {
        uid,
        requestId: id,
        inputHash,
        status: 'READY',
        result: safeResult,
        ...(safeCost ? { cost: safeCost } : {}),
        updatedAtMs: now,
        leaseExpiresAtMs: admin.firestore.FieldValue.delete(),
        pendingCompletion: admin.firestore.FieldValue.delete(),
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
    if (persisted.fenced) throw leaseLostError();
    memory.set(key, { ...row, result: safeResult });
  } catch (error) {
    if (error?.code === 'WRITING_JOB_LEASE_LOST') {
      logger.warn('writinglab.job_complete_fenced', { uid, requestId: id });
      throw error;
    }
    logger.error('writinglab.job_complete_persist_failed', { uid, requestId: id, err: error });
    if (error?.code === 'ACCOUNT_DELETION_IN_PROGRESS') throw error;
    throw Object.assign(new Error('WRITING_JOB_PERSIST_UNAVAILABLE'), {
      code: 'WRITING_JOB_PERSIST_UNAVAILABLE',
      status: 503,
    });
  }
}

async function fail(uid, requestId, inputHash, error, now = Date.now(), { leaseId, cost, discardPendingCompletion = false } = {}) {
  const id = normalizeRequestId(requestId);
  if (!id) return { recorded: false };
  const key = storageKey(uid, id);
  const failure = {
    code: String(error?.code || 'WRITING_ENGINE_FAILED').slice(0, 100),
    message: String(error?.message || '글 생성에 실패했어요.').slice(0, 500),
    retryable: ![400, 403, 409, 422].includes(Number(error?.status || 0))
  };
  const safeCost = sanitizeCost(cost);
  const row = { uid, requestId: id, inputHash, status: 'FAILED', error: failure, ...(safeCost ? { cost: safeCost } : {}),
    ...(['DAILY_CAP', 'WRITING_JOB_ALREADY_RESTORED'].includes(error?.code) && discardPendingCompletion ? { compensated: true } : {}),
    createdAtMs: now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS };
  if (!db || !admin) {
    const current = memory.get(key);
    if (leaseId && leaseRefusal(current, leaseId, now) === 'LEASE_LOST') return { recorded: false, fenced: true };
    if (current?.pendingCompletion && !discardPendingCompletion) {
      memory.set(key, { ...current, status: 'PROCESSING', leaseExpiresAtMs: 0, error: failure, updatedAtMs: now });
      return { recorded: true, resumable: true };
    }
    memory.set(key, row);
    return { recorded: true };
  }
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    const deletionRef = db.collection('accountDeletionJobs').doc(uid);
    const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
    const outcome = await db.runTransaction(async transaction => {
      const deletionSnapshot = await transaction.get(deletionRef);
      const activitySnapshot = await transaction.get(activityRef);
      const snap = await transaction.get(ref);
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
        return { recorded: false };
      }
      // The current owner's claim and activity lane stay untouched.
      if (leaseId && leaseRefusal(snap.exists ? snap.data() : null, leaseId, now) === 'LEASE_LOST') return { recorded: false, fenced: true };
      const current = snap.exists ? snap.data() : null;
      if (current?.pendingCompletion && !discardPendingCompletion) {
        transaction.set(ref, { status: 'PROCESSING', leaseExpiresAtMs: 0, error: failure, updatedAtMs: now }, { merge: true });
        return { recorded: true, resumable: true };
      }
      transaction.set(ref, {
        uid,
        requestId: id,
        inputHash,
        status: 'FAILED',
        ...(['DAILY_CAP', 'WRITING_JOB_ALREADY_RESTORED'].includes(error?.code) && discardPendingCompletion ? { compensated: true } : {}),
        error: failure,
        ...(safeCost ? { cost: safeCost } : {}),
        updatedAtMs: now,
        leaseExpiresAtMs: admin.firestore.FieldValue.delete(),
        pendingCompletion: admin.firestore.FieldValue.delete(),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + JOB_TTL_MS),
        result: admin.firestore.FieldValue.delete()
      }, { merge: true });
      transaction.set(activityRef, release, { merge: true });
      return { recorded: true };
    });
    if (outcome.recorded && !outcome.resumable) memory.set(key, row);
    else memory.delete(key);
    return outcome;
  } catch (storeError) {
    logger.warn('writinglab.job_fail_persist_failed', { uid, requestId: id, err: storeError });
    return { recorded: false, unavailable: true };
  }
}

// Owner heartbeat. Returns { ok, leaseExpiresAtMs } or { ok: false, reason }:
// LEASE_LOST / LEASE_EXPIRED mean stop now; UNAVAILABLE means the owner may
// keep working only until its last confirmed lease expires.
async function renew(uid, requestId, inputHash, leaseId, now = Date.now()) {
  const id = normalizeRequestId(requestId);
  if (!id || !leaseId) return { ok: false, reason: 'LEASE_LOST' };
  const key = storageKey(uid, id);
  const extend = row => Math.min(now + LEASE_TTL_MS,
    Number(row.deadlineAtMs) > 0 ? Number(row.deadlineAtMs) + FINISH_GRACE_MS : now + LEASE_TTL_MS);
  if (!db || !admin) {
    const row = memory.get(key);
    const refused = row && row.inputHash !== inputHash ? 'LEASE_LOST' : leaseRefusal(row, leaseId, now);
    if (refused) return { ok: false, reason: refused };
    row.updatedAtMs = now;
    row.leaseExpiresAtMs = extend(row);
    return { ok: true, leaseExpiresAtMs: row.leaseExpiresAtMs };
  }
  try {
    const ref = db.collection('writingLabV2Jobs').doc(key);
    return await db.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      const row = snap.exists ? snap.data() : null;
      const refused = row && (row.uid !== uid || row.inputHash !== inputHash) ? 'LEASE_LOST' : leaseRefusal(row, leaseId, now);
      if (refused) return { ok: false, reason: refused };
      const leaseExpiresAtMs = extend(row);
      transaction.set(ref, { updatedAtMs: now, leaseExpiresAtMs }, { merge: true });
      return { ok: true, leaseExpiresAtMs };
    });
  } catch (error) {
    logger.warn('writinglab.job_lease_renew_failed', { uid, requestId: id, err: error });
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}

function sanitizeCost(cost) {
  if (!cost || typeof cost !== 'object' || cost.version !== 'writing-cost-v1') return null;
  try { return JSON.parse(JSON.stringify(cost)); } catch { return null; }
}

async function get(uid, requestId) {
  const id = normalizeRequestId(requestId);
  if (!id) return { state: 'INVALID' };
  const key = storageKey(uid, id);
  const local = memory.get(key);
  if (!db) return local && local.expiresAtMs > Date.now() ? responseState(local) : { state: 'NOT_FOUND' };
  try {
    const snap = await settleWithin(() => db.collection('writingLabV2Jobs').doc(key).get());
    if (!snap.exists) return { state: 'NOT_FOUND' };
    const row = snap.data();
    if (row.uid !== uid || row.requestId !== id) return { state: 'FORBIDDEN' };
    return responseState(row);
  } catch (error) {
    logger.error('writinglab.job_read_failed', { uid, requestId: id, err: error });
    return local?.status === 'READY' && local.expiresAtMs > Date.now() ? responseState(local) : { state: 'UNAVAILABLE' };
  }
}

function beginMemory(key, uid, requestId, inputHash, now, lease) {
  const existing = memory.get(key);
  if (existing && existing.expiresAtMs > now) {
    if (existing.uid !== uid || existing.requestId !== requestId) return { state: 'FORBIDDEN' };
    if (existing.inputHash !== inputHash) return { state: 'MISMATCH' };
    if (existing.status === 'READY') return { state: 'READY', result: existing.result };
    if (existing.status === 'FAILED' && existing.compensated === true) return responseState(existing);
    if (processingActive(existing, now)) return { state: 'PROCESSING' };
  }
  memory.set(key, {
    uid, requestId, inputHash, status: 'PROCESSING', ...lease,
    ...(existing?.pendingCompletion ? { pendingCompletion: existing.pendingCompletion } : {}),
    createdAtMs: existing?.createdAtMs || now, updatedAtMs: now, expiresAtMs: now + JOB_TTL_MS
  });
  return { state: 'NEW', ...lease, ...(existing?.pendingCompletion ? { pendingCompletion: JSON.parse(JSON.stringify(existing.pendingCompletion)) } : {}) };
}

// `cost` is the sanitized server-side summary; routes do not return it.
function responseState(row, now = Date.now()) {
  const cost = row.cost ? { cost: row.cost } : {};
  if (row.status === 'READY' && row.result) return { state: 'READY', inputHash: row.inputHash, result: row.result, ...cost };
  if (row.pendingCompletion) return { state: 'PROCESSING', inputHash: row.inputHash,
    leaseExpired: row.status !== 'PROCESSING' || !processingActive(row, now), hasPendingCompletion: true, ...cost };
  if (row.status === 'FAILED') return { state: 'FAILED', inputHash: row.inputHash, error: row.error || null, ...cost };
  if (row.status === 'PROCESSING') {
    // An expired lease means its owner stopped; the same request may resume it.
    return { state: 'PROCESSING', inputHash: row.inputHash, leaseExpired: !processingActive(row, now), hasPendingCompletion: !!row.pendingCompletion };
  }
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
  LEASE_TTL_MS,
  FINISH_GRACE_MS,
  MAX_STAGED_COMPLETION_BYTES,
  normalizeRequestId,
  storageKey,
  begin,
  renew,
  stageCompletion,
  assertSideEffectOwnership,
  prepareDebitCompletion,
  prepareCompensatedCompletion,
  billingFromReceipt,
  complete,
  fail,
  get,
  resetMemoryForTests
};
