'use strict';
const { randomUUID, createHash } = require('node:crypto');
const COLLECTION = 'transformExecutionLeases';
const DOCUMENT = 'active';
const LEASE_MS = 90000;
const keyOf = id => createHash('sha256').update(String(id)).digest('hex');
const live = (slots, now) => Object.fromEntries(Object.entries(slots || {}).filter(([, v]) => v.expiresAtMs > now));

function createExecutionCoordinator({ db, caps, totalCap = Infinity, clock = Date.now }) {
  let local = {};
  let chain = Promise.resolve();
  async function change(fn, beforeRead = null) {
    if (!db) {
      const operation = chain.then(async () => { const r = await fn(local, null); local = r.slots; return r.value; });
      chain = operation.catch(() => {});
      return operation;
    }
    const ref = db.collection(COLLECTION).doc(DOCUMENT);
    return db.runTransaction(async tx => {
      const context = beforeRead ? await beforeRead(tx) : null;
      const snap = await tx.get(ref);
      const r = await fn(snap.exists ? snap.data().slots || {} : {}, tx, context);
      if (r.write !== false) tx.set(ref, { slots: r.slots, updatedAtMs: clock() });
      return r.value;
    });
  }
  async function acquireJob(job, feature, ephemeralAdmin = false) {
    const token = randomUUID(), key = keyOf(job.id), pool = job.mode === 'formal' ? 'formal' : 'short';
    return change(async (stored, tx, deletion) => {
      const now = clock(), slots = live(stored, now), rows = Object.values(slots);
      let persisted;
      const rejected = () => ({ slots, value: null, write: false });
      if (rows.some(s => s.uid === job.uid || s.jobId === job.id)) return rejected();
      if (rows.length >= totalCap) return rejected();
      if (rows.filter(s => s.pool === pool).length >= caps[pool]) return rejected();
      if (tx) {
        if (deletion.exists && require('./accountActivityClaims').accountDeletionBlocksWrites(deletion.data(), now)) return rejected();
      }
      if (tx && !ephemeralAdmin) {
        const ref = db.collection('transformJobs').doc(job.id);
        const snapshot = await tx.get(ref);
        const allowed = feature === 'refine' ? ['done'] : feature === 'fallback' ? ['blocked'] : ['queued', 'running'];
        if (!snapshot.exists || snapshot.data().uid !== job.uid || !allowed.includes(snapshot.data().status)) return rejected();
        persisted = snapshot.data();
        tx.set(ref, { executionToken: token }, { merge: true });
      }
      slots[key] = { uid: job.uid, jobId: job.id, pool, feature, token, expiresAtMs: now + LEASE_MS };
      return { slots, value: { key, token, persisted, jobId: job.id, ephemeralAdmin, expiresAtMs: now + LEASE_MS } };
    // Match persistence's lock order: deletion -> activity (when used) ->
    // execution lease -> job. Taking the lease before deletion can deadlock
    // against a concurrent persistence transaction holding the deletion lock.
    }, tx => tx.get(db.collection('accountDeletionJobs').doc(job.uid)));
  }
  function acquire(job, feature) {
    return acquireJob(job, feature);
  }
  function acquireAdmin({ uid }) {
    // Only the verified admin route uses this server-generated reservation.
    // No caller-supplied job ID or feature can bypass persisted job checks.
    if (!db) return Promise.resolve(null);
    if (typeof uid !== 'string' || !uid.trim()) throw new TypeError('Admin uid is required');
    return acquireJob({ id: 'admin_runtime_' + randomUUID(), uid, mode: 'polish' }, 'admin_runtime', true);
  }
  async function renew(lease) {
    const result = await change(async (stored, tx) => {
      const slots = live(stored, clock());
      const owned = slots[lease.key]?.token === lease.token;
      if (!owned) return { slots, value: { owned: false }, write: false };
      if (tx && !lease.ephemeralAdmin) {
        const snapshot = await tx.get(db.collection('transformJobs').doc(lease.jobId));
        if (!snapshot.exists || snapshot.data().status === 'cancelled') {
          // Keep the slot until the owner has actually stopped and releases it.
          return { slots, value: { owned: false, cancelled: snapshot.exists }, write: false };
        }
      }
      const expiresAtMs = clock() + LEASE_MS;
      slots[lease.key].expiresAtMs = expiresAtMs;
      return { slots, value: { owned: true, expiresAtMs } };
    });
    if (result.cancelled) lease.cancelled = true;
    if (result.owned) lease.expiresAtMs = result.expiresAtMs;
    return result.owned;
  }
  async function release(lease) {
    return change(stored => {
      const slots = live(stored, clock());
      const owned = slots[lease.key]?.token === lease.token;
      if (owned) delete slots[lease.key];
      return { slots, value: true, write: owned };
    });
  }
  return { acquire, acquireAdmin, renew, release };
}
module.exports = { createExecutionCoordinator, COLLECTION, DOCUMENT, keyOf, live };
