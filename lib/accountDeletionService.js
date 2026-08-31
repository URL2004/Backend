'use strict';

const crypto = require('crypto');
const { accountDeletionPendingReasons } = require('./accountDeletionPolicy');

const TOMBSTONE_VERSION = 1;
const USER_SUBCOLLECTIONS = [
  'history',
  'notifications',
  'serverUsage'
];
const FINANCIAL_COLLECTIONS = ['orders', 'subscriptionOrders', 'paymentIntents', 'paymentSecrets'];

function deletionSecret(env = process.env) {
  return String(
    env.ACCOUNT_DELETION_SECRET
    || env.OPENAI_SAFETY_SALT
    || env.HISTORY_PROVENANCE_SECRET
    || ''
  );
}

function accountDeletionHash(uid, secret = deletionSecret()) {
  if (!uid || secret.length < 16) {
    const error = new Error('ACCOUNT_DELETION_SECRET_MISSING');
    error.code = 'ACCOUNT_DELETION_SECRET_MISSING';
    error.status = 503;
    throw error;
  }
  return crypto.createHmac('sha256', secret).update(`account-deletion:v1:${uid}`).digest('hex');
}

function snapshotRows(snapshot) {
  return snapshot && Array.isArray(snapshot.docs)
    ? snapshot.docs.map(doc => ({ id: doc.id, ref: doc.ref, ...(doc.data() || {}) }))
    : [];
}

async function rowsForUid(db, collectionName, uid) {
  return snapshotRows(await db.collection(collectionName).where('uid', '==', uid).get());
}

async function rowsForField(db, collectionName, field, value) {
  return snapshotRows(await db.collection(collectionName).where(field, '==', value).get());
}

async function accountDeletionPreflight({ db, uid, nowMs = Date.now() }) {
  const userRef = db.collection('users').doc(uid);
  const [
    userSnap,
    paymentIntents,
    orders,
    subscriptionOrders,
    transformJobs,
    inviteeVestings,
    referrerVestings
  ] = await Promise.all([
    userRef.get(),
    rowsForUid(db, 'paymentIntents', uid),
    rowsForUid(db, 'orders', uid),
    rowsForUid(db, 'subscriptionOrders', uid),
    rowsForUid(db, 'transformJobs', uid),
    rowsForField(db, 'referralVestings', 'inviteeUid', uid),
    rowsForField(db, 'referralVestings', 'referrerUid', uid)
  ]);
  const user = userSnap.exists ? (userSnap.data() || {}) : {};
  return {
    userExists: userSnap.exists,
    reasons: accountDeletionPendingReasons({
      user,
      paymentIntents,
      orders,
      subscriptionOrders,
      transformJobs,
      referralVestings: [...inviteeVestings, ...referrerVestings],
      nowMs
    })
  };
}

async function commitInChunks(db, operations, chunkSize = 400) {
  for (let offset = 0; offset < operations.length; offset += chunkSize) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + chunkSize)) operation(batch);
    await batch.commit();
  }
}

async function deleteSnapshotDocs(db, snapshot) {
  const docs = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [];
  await commitInChunks(db, docs.map(doc => batch => batch.delete(doc.ref)));
}

async function deleteUserSubcollections({ db, uid }) {
  const userRef = db.collection('users').doc(uid);
  for (const name of USER_SUBCOLLECTIONS) {
    await deleteSnapshotDocs(db, await userRef.collection(name).get());
  }
}

async function deleteUserGeneratedContent({ db, uid }) {
  const posts = await db.collection('posts').where('authorId', '==', uid).get();
  for (const post of posts.docs || []) {
    await deleteSnapshotDocs(db, await post.ref.collection('comments').get());
  }
  await deleteSnapshotDocs(db, posts);
  await deleteSnapshotDocs(db, await db.collection('qna').where('authorId', '==', uid).get());
  if (typeof db.collectionGroup === 'function') {
    await deleteSnapshotDocs(db, await db.collectionGroup('comments').where('authorId', '==', uid).get());
  }
}

function financialRetentionPatch({ deletedAccountHash, now }) {
  return {
    deletedAccountHash,
    accountDeletedAt: now
  };
}

async function markFinancialRecordsForRetention({ admin, db, uid, deletedAccountHash }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const patch = financialRetentionPatch({ deletedAccountHash, now });
  for (const collectionName of FINANCIAL_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).where('uid', '==', uid).get();
    const operations = (snapshot.docs || []).map(doc => batch => batch.set(doc.ref, patch, { merge: true }));
    await commitInChunks(db, operations);
  }
}

async function minimizeReferralVestingIdentity({ admin, db, uid, deletedAccountHash }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const field of ['inviteeUid', 'referrerUid']) {
    const snapshot = await db.collection('referralVestings').where(field, '==', uid).get();
    const operations = (snapshot.docs || []).map(doc => batch => batch.set(doc.ref, {
      [field]: `deleted:${deletedAccountHash.slice(0, 32)}`,
      [`${field}DeletedHash`]: deletedAccountHash,
      accountDeletedAt: now
    }, { merge: true }));
    await commitInChunks(db, operations);
  }
}

async function deleteAccountData({ admin, db, uid, secret, logger, nowMs = Date.now() }) {
  if (!admin || !db || !uid) throw Object.assign(new Error('ACCOUNT_DELETE_UNAVAILABLE'), { status: 503 });
  const deletedAccountHash = accountDeletionHash(uid, secret);
  const tombstoneRef = db.collection('accountDeletionTombstones').doc(deletedAccountHash);
  const tombstoneSnap = await tombstoneRef.get();
  const tombstone = tombstoneSnap.exists ? (tombstoneSnap.data() || {}) : {};
  if (tombstone.status === 'completed') return { ok: true, alreadyDeleted: true, deletionId: deletedAccountHash.slice(0, 16) };

  const preflight = await accountDeletionPreflight({ db, uid, nowMs });
  if (preflight.reasons.length) {
    const error = new Error('ACCOUNT_DELETE_PENDING_WORK');
    error.code = 'ACCOUNT_DELETE_PENDING_WORK';
    error.status = 409;
    error.reasonCodes = preflight.reasons;
    throw error;
  }

  const completedSteps = new Set(Array.isArray(tombstone.completedSteps) ? tombstone.completedSteps : []);
  await tombstoneRef.set({
    version: TOMBSTONE_VERSION,
    status: 'running',
    completedSteps: [...completedSteps],
    startedAt: tombstone.startedAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const runStage = async (name, task) => {
    if (completedSteps.has(name)) return;
    try {
      await task();
      completedSteps.add(name);
      await tombstoneRef.set({
        status: 'running',
        completedSteps: [...completedSteps],
        failedStep: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      await tombstoneRef.set({
        status: 'failed',
        failedStep: name,
        failureCode: String(error && (error.code || error.message) || 'unknown').slice(0, 120),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      throw error;
    }
  };

  await runStage('user_subcollections_deleted', () => deleteUserSubcollections({ db, uid }));
  await runStage('billing_secret_deleted', () => db.collection('billingSecrets').doc(uid).delete());
  await runStage('ugc_deleted', () => deleteUserGeneratedContent({ db, uid }));
  await runStage('financial_records_retained', () => markFinancialRecordsForRetention({
    admin,
    db,
    uid,
    deletedAccountHash
  }));
  await runStage('referral_identity_minimized', () => minimizeReferralVestingIdentity({
    admin,
    db,
    uid,
    deletedAccountHash
  }));
  await runStage('user_document_deleted', () => db.collection('users').doc(uid).delete());

  // Firebase Auth is deliberately the final destructive step. If it fails, the
  // verified user can retry and the tombstone resumes without repeating stages.
  await tombstoneRef.set({
    status: 'auth_deletion_pending',
    completedSteps: [...completedSteps],
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if (error && error.code !== 'auth/user-not-found') {
      await tombstoneRef.set({
        status: 'failed',
        failedStep: 'firebase_auth_deleted',
        failureCode: String(error.code || error.message || 'unknown').slice(0, 120),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      throw error;
    }
  }
  completedSteps.add('firebase_auth_deleted');
  await tombstoneRef.set({
    status: 'completed',
    completedSteps: [...completedSteps],
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(error => {
    logger?.warn?.('account.delete_tombstone_finalize_failed', {
      deletionId: deletedAccountHash.slice(0, 16),
      err: error
    });
  });

  return { ok: true, alreadyDeleted: false, deletionId: deletedAccountHash.slice(0, 16) };
}

module.exports = {
  TOMBSTONE_VERSION,
  USER_SUBCOLLECTIONS,
  FINANCIAL_COLLECTIONS,
  deletionSecret,
  accountDeletionHash,
  snapshotRows,
  rowsForField,
  accountDeletionPreflight,
  commitInChunks,
  deleteUserSubcollections,
  deleteUserGeneratedContent,
  financialRetentionPatch,
  markFinancialRecordsForRetention,
  minimizeReferralVestingIdentity,
  deleteAccountData
};
