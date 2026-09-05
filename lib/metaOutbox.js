'use strict';

const crypto = require('crypto');
const COLLECTION = 'metaConversionOutbox';
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECEIPT_MS = 30 * 24 * 60 * 60 * 1000;
const LEASE_MS = 60 * 1000;

function documentId(event) {
  return crypto.createHash('sha256').update(`${event.event_name}|${event.event_id}`).digest('hex');
}

function pendingRecord(event, uid, nowMs = Date.now()) {
  if (!event?.event_id || !event?.event_name || !Number.isFinite(event.event_time)) throw new Error('META_OUTBOX_EVENT_INVALID');
  return {
    uid: String(uid || ''), event, status: 'pending', attempts: 0,
    createdAtMs: nowMs, nextAttemptAtMs: nowMs,
    deadlineAtMs: Math.min(nowMs, event.event_time * 1000) + RETRY_WINDOW_MS,
    expiresAtMs: nowMs + RECEIPT_MS
  };
}

// Called inside the same transaction that creates an order. No network call or
// extra read after transaction writes; an existing order never reaches this path.
function stageInTransaction(transaction, db, event, uid, nowMs) {
  transaction.set(db.collection(COLLECTION).doc(documentId(event)), pendingRecord(event, uid, nowMs));
}

function createOutbox({ db, send, now = Date.now, logger = { warn() {} } }) {
  async function enqueue(event, uid) {
    if (!db) return { ok: false, skipped: 'storage_disabled' };
    const ref = db.collection(COLLECTION).doc(documentId(event));
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) return { ok: true, duplicate: true };
      transaction.set(ref, pendingRecord(event, uid, now()));
      return { ok: true, duplicate: false };
    });
  }

  async function finish(ref, token, result) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().leaseToken !== token) return false;
      const row = snapshot.data();
      const terminal = result.ok || result.retryable === false || row.attempts >= 12 || now() >= row.deadlineAtMs;
      const next = { ...row, lastStatus: Number(result.status) || 0, updatedAtMs: now() };
      delete next.leaseToken;
      if (terminal) {
        next.status = result.ok ? 'sent' : 'failed';
        next.eventName = row.event.event_name;
        next.eventId = row.event.event_id;
        next.event = null; // Hashes, click IDs, IP and UA are removed after delivery/final failure.
        delete next.nextAttemptAtMs;
        if (!result.ok) logger.warn('meta.outbox_delivery_exhausted', { eventName: next.eventName, status: next.lastStatus, attempts: row.attempts });
      } else {
        next.status = 'pending';
        next.nextAttemptAtMs = now() + Math.min(3600000, 15000 * 2 ** Math.min(row.attempts, 8));
      }
      transaction.set(ref, next);
      return true;
    });
  }

  async function deliver(ref) {
    const token = crypto.randomUUID();
    const claimed = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;
      const row = snapshot.data();
      if (!row.event || !['pending', 'sending'].includes(row.status) || row.nextAttemptAtMs > now()) return null;
      const next = { ...row, status: 'sending', leaseToken: token, attempts: row.attempts + 1, nextAttemptAtMs: now() + LEASE_MS };
      transaction.set(ref, next);
      return next;
    });
    if (!claimed) return false;
    let result;
    if (now() >= claimed.deadlineAtMs) result = { ok: false, retryable: false };
    else {
      try { result = await send(claimed.event); }
      catch (_) { result = { ok: false, retryable: true }; }
    }
    await finish(ref, token, result);
    return true;
  }

  let running = false;
  let timer = null;
  async function tick() {
    if (!db || running) return { processed: 0 };
    running = true;
    let processed = 0;
    try {
      const due = await db.collection(COLLECTION).where('nextAttemptAtMs', '<=', now()).orderBy('nextAttemptAtMs').limit(10).get();
      for (const doc of due.docs) if (await deliver(doc.ref)) processed++;
      const expired = await db.collection(COLLECTION).where('expiresAtMs', '<=', now()).limit(50).get();
      for (const doc of expired.docs) await doc.ref.delete();
      return { processed };
    } finally { running = false; }
  }
  function start() {
    if (!db || timer) return;
    const run = () => tick().catch(error => logger.warn('meta.outbox_worker_failed', { code: error?.code || 'storage_error' }));
    timer = setInterval(run, 15000);
    timer.unref();
    void run();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { enqueue, tick, start, stop, deliver };
}

module.exports = { COLLECTION, documentId, pendingRecord, stageInTransaction, createOutbox };
