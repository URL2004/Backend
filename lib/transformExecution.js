'use strict';
const { randomUUID, createHash } = require('node:crypto');
const COLLECTION = 'transformExecutionLeases';
const DOCUMENT = 'active';
const LEASE_MS = 90000;
const keyOf = id => createHash('sha256').update(String(id)).digest('hex');
const live = (slots, now) => Object.fromEntries(Object.entries(slots || {}).filter(([, v]) => v.expiresAtMs > now));

function createExecutionCoordinator({ db, caps, clock = Date.now }) {
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
  async function acquire(job, feature) {
    const token = randomUUID(), key = keyOf(job.id), pool = job.mode === 'formal' ? 'formal' : 'short';
    return change(async (stored, tx, deletion) => {
      const now = clock(), slots = live(stored, now), rows = Object.values(slots);
      let persisted;
      const rejected = () => ({ slots, value: null, write: false });
      if (rows.some(s => s.uid === job.uid || s.jobId === job.id)) return rejected();
      if (rows.filter(s => s.pool === pool).length >= caps[pool]) return rejected();
      if (tx) {
        const ref = db.collection('transformJobs').doc(job.id);
        const snapshot = await tx.get(ref);
        if (deletion.exists && require('./accountActivityClaims').accountDeletionBlocksWrites(deletion.data(), now)) return rejected();
        const allowed = feature === 'refine' ? ['done'] : feature === 'fallback' ? ['blocked'] : ['queued', 'running'];
        if (!snapshot.exists || snapshot.data().uid !== job.uid || !allowed.includes(snapshot.data().status)) return rejected();
        persisted = snapshot.data();
        tx.set(ref, { executionToken: token }, { merge: true });
      }
      slots[key] = { uid: job.uid, jobId: job.id, pool, feature, token, expiresAtMs: now + LEASE_MS };
      return { slots, value: { key, token, persisted } };
    // Match persistence's lock order: deletion -> activity (when used) ->
    // execution lease -> job. Taking the lease before deletion can deadlock
    // against a concurrent persistence transaction holding the deletion lock.
    }, tx => tx.get(db.collection('accountDeletionJobs').doc(job.uid)));
  }
  async function renew(lease) {
    return change(stored => {
      const slots = live(stored, clock());
      const owned = slots[lease.key]?.token === lease.token;
      if (owned) slots[lease.key].expiresAtMs = clock() + LEASE_MS;
      return { slots, value: owned, write: owned };
    });
  }
  async function release(lease) {
    return change(stored => {
      const slots = live(stored, clock());
      const owned = slots[lease.key]?.token === lease.token;
      if (owned) delete slots[lease.key];
      return { slots, value: true, write: owned };
    });
  }
  return { acquire, renew, release };
}
module.exports = { createExecutionCoordinator, COLLECTION, DOCUMENT, keyOf, live };
