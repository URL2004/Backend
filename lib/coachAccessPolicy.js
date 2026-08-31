'use strict';

function boundedCap(value, fallback = 20) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : fallback;
}

function coachQuotaWindow(nowMs = Date.now()) {
  const startMs = Math.floor(Number(nowMs) / 3600000) * 3600000;
  return {
    startMs,
    endMs: startMs + 3600000,
    key: `coach_suggest_${new Date(startMs).toISOString().slice(0, 13).replace(/[-T:]/g, '')}`
  };
}

async function consumeCoachQuota({ admin, db, uid, cap = 20, nowMs = Date.now() } = {}) {
  if (!db || !uid || typeof db.runTransaction !== 'function') {
    const error = new Error('COACH_QUOTA_STORE_UNAVAILABLE');
    error.code = 'COACH_QUOTA_STORE_UNAVAILABLE';
    throw error;
  }
  if (!admin?.firestore?.Timestamp?.fromMillis) {
    const error = new Error('COACH_QUOTA_TIMESTAMP_UNAVAILABLE');
    error.code = 'COACH_QUOTA_STORE_UNAVAILABLE';
    throw error;
  }
  const limit = boundedCap(cap);
  const window = coachQuotaWindow(nowMs);
  const ref = db.collection('users').doc(uid).collection('serverUsage').doc(window.key);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const previous = snap.exists ? Math.max(0, Number(snap.data()?.count) || 0) : 0;
    if (previous >= limit) {
      return {
        allowed: false,
        count: previous,
        limit,
        retryAfterSeconds: Math.max(1, Math.ceil((window.endMs - nowMs) / 1000))
      };
    }
    const count = previous + 1;
    transaction.set(ref, {
      kind: 'coach_suggest',
      count,
      windowStartMs: window.startMs,
      // Firestore TTL policies only delete Timestamp fields, not numeric ms.
      expiresAt: admin.firestore.Timestamp.fromMillis(window.endMs + 24 * 3600000),
      updatedAtMs: Number(nowMs)
    }, { merge: false });
    return { allowed: true, count, limit, retryAfterSeconds: 0 };
  });
}

module.exports = { boundedCap, coachQuotaWindow, consumeCoachQuota };
