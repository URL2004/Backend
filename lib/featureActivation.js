'use strict';
const meta = require('./metaConversions');
const { stageInTransaction } = require('./metaOutbox');
const COLLECTION = 'featureActivations';
const SCOPE = 'since_20260905';

// First observed success since instrumentation, not a returning user's lifetime.
// Only authenticated server completion paths call this; browser claims are never accepted.
async function recordFirstSuccess({ db, uid, runId, feature, chars, mode, context, isInternal = false, nowMs = Date.now() }) {
  if (!db || !uid || !runId || isInternal || !['detect', 'humanize'].includes(feature)) return null;
  const firstRef = db.collection(COLLECTION).doc(uid);
  const userRef = db.collection('users').doc(uid);
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  return db.runTransaction(async tx => {
    const [first, user, deletion] = await Promise.all([tx.get(firstRef), tx.get(userRef), tx.get(deletionRef)]);
    if (!user.exists || deletion.exists) return null;
    if (first.exists) {
      const row = first.data();
      return { firstSuccess: row.runId === runId && row.feature === feature, scope: SCOPE, eventId: row.eventId };
    }
    const eventId = 'gp_activation_' + meta.sha256(uid).slice(0, 32);
    const source = user.data()?.signupAttribution?.last_touch || {};
    tx.set(firstRef, {
      uid, runId, feature, mode: String(mode || '').slice(0, 40), eventId, scope: SCOPE,
      chars: Math.max(0, Number(chars) || 0), occurredAtMs: nowMs,
      signupAt: user.data()?.createdAt || null,
      signupSource: String(source.source || 'unknown').slice(0, 100),
      signupCampaign: String(source.campaign || '').slice(0, 150)
    });
    if (meta.enabled()) stageInTransaction(tx, db, meta.buildActivation({
      eventId, eventTime: Math.floor(nowMs / 1000), externalId: uid,
      email: user.data()?.email, context,
      clientIp: context?.clientIp, userAgent: context?.userAgent,
      feature, mode, chars, scope: SCOPE
    }), uid, nowMs);
    return { firstSuccess: true, scope: SCOPE, eventId };
  });
}
module.exports = { COLLECTION, SCOPE, recordFirstSuccess };
