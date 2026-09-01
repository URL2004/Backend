'use strict';

const {
  COLLECTION: ACCOUNT_ACTIVITY_COLLECTION,
  activeAccountActivityClaims,
} = require('./accountActivityClaims');

const MAX_ATTEMPTS = 5;
const LEASE_MS = 15 * 60 * 1000;
const COMPLETED_PROTECTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE_BUCKET = 'url88-d1d27.firebasestorage.app';
const USER_SUBCOLLECTIONS = Object.freeze([
  'creditGrants', 'creditHistory', 'couponHistory', 'creditLots', 'history', 'notifications',
]);
const USER_OPERATIONAL_COLLECTIONS = Object.freeze([
  'analyzeRequests',
  'transformJobs',
  'transformJobArchive',
  'writingLabV2Jobs',
  'writingLabDailyUsage',
  'writingLabGenerationCommits',
]);
const RETAINED_FINANCIAL_COLLECTIONS = Object.freeze([
  'orders',
  'subscriptionOrders',
  'paymentSecrets',
  'paymentIntents',
  'subscriptionRefundClaims',
  'systemCreditReconciliations',
  // Redeemed coupon rows are immutable credit-issuance evidence. The user's
  // spendable coupon/credit history is removed, while this server-only ledger
  // remains available for duplicate-redemption and accounting review.
  'couponCodes',
  'webhookInbox',
  'webhookLogs',
]);
const UNRESOLVED_REFUND_STATUSES = new Set(['refund_requested', 'refund_processing']);
const FINANCIAL_SCAN_LIMIT = 500;
const INDEX_RECOVERABLE_ERROR_CODES = new Set(['9', 'ACCOUNT_COLLECTION_GROUP_INDEX_REQUIRED']);
const ACCOUNT_DELETION_INDEX_PROBES = Object.freeze([
  Object.freeze({ collectionGroup: 'comments', fieldPath: 'authorId' }),
  Object.freeze({ collectionGroup: 'notifications', fieldPath: 'actorUid' }),
  Object.freeze({ collectionGroup: 'notifications', fieldPath: 'postId' }),
]);

function deletionError(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return Number(value._seconds) > 0 ? Number(value._seconds) * 1000 : 0;
}

function activeSubscription(user, nowMs = Date.now()) {
  const sub = user && user.subscription;
  if (!sub) return false;
  if (sub.status === 'active') return true;
  return sub.status === 'cancelled' && timestampMs(sub.nextBillingAt) > nowMs;
}

function activeSubscriptionOperation(row) {
  const operation = String(row?.operation || '');
  const status = String(row?.status || '');
  if (operation === 'start') {
    return ['claimed', 'billing_issuing', 'billing_issued', 'charging', 'charge_unknown', 'charged']
      .includes(status);
  }
  if (operation === 'renewal') return ['charging', 'charged'].includes(status);
  if (operation === 'expiry') return status === 'deleting';
  return false;
}

function activePaymentAccountClaims(row) {
  const value = row && typeof row === 'object' ? row : {};
  // payment.js keeps only unsettled operations in maps whose names start with
  // "active". Treat an unknown future active lane as blocking too so a schema
  // extension cannot silently reopen the deletion/payment race.
  return Object.entries(value).some(([key, lane]) => (
    key.startsWith('active')
    && lane && typeof lane === 'object' && !Array.isArray(lane)
    && Object.keys(lane).length > 0
  ));
}

function activeDeletionLease(row, nowMs = Date.now()) {
  return String(row?.status || '') === 'processing' && Number(row?.leaseUntilMs || 0) > nowMs;
}

function unresolvedRefundDocuments(snapshot) {
  return (snapshot?.docs || []).filter(doc => {
    const row = doc.data() || {};
    return UNRESOLVED_REFUND_STATUSES.has(String(row.status || ''))
      || !!row.refundProcessing
      || !!row.subscriptionRefundProcessing;
  });
}

function financialQueryTruncated(snapshot) {
  return Array.isArray(snapshot?.docs) && snapshot.docs.length >= FINANCIAL_SCAN_LIMIT;
}

async function acquireDeletionLease({ admin, db, uid, source, nowMs = Date.now() }) {
  const jobRef = db.collection('accountDeletionJobs').doc(uid);
  const userRef = db.collection('users').doc(uid);
  const subscriptionClaimRef = db.collection('subscriptionOperationClaims').doc(uid);
  const paymentClaimRef = db.collection('paymentAccountClaims').doc(uid);
  const activityClaimRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid);
  const ordersQuery = db.collection('orders').where('uid', '==', uid).limit(FINANCIAL_SCAN_LIMIT);
  const subscriptionOrdersQuery = db.collection('subscriptionOrders').where('uid', '==', uid).limit(FINANCIAL_SCAN_LIMIT);

  return db.runTransaction(async transaction => {
    const [
      jobSnapshot,
      userSnapshot,
      subscriptionClaimSnapshot,
      paymentClaimSnapshot,
      activityClaimSnapshot,
      ordersSnapshot,
      subscriptionOrdersSnapshot,
    ] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(userRef),
      transaction.get(subscriptionClaimRef),
      transaction.get(paymentClaimRef),
      transaction.get(activityClaimRef),
      transaction.get(ordersQuery),
      transaction.get(subscriptionOrdersQuery),
    ]);
    const job = jobSnapshot.exists ? jobSnapshot.data() || {} : {};
    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
    const subscriptionClaim = subscriptionClaimSnapshot.exists ? subscriptionClaimSnapshot.data() || {} : {};
    const paymentClaim = paymentClaimSnapshot.exists ? paymentClaimSnapshot.data() || {} : {};
    const activityClaim = activityClaimSnapshot.exists ? activityClaimSnapshot.data() || {} : {};
    const pendingRefunds = [
      ...unresolvedRefundDocuments(ordersSnapshot),
      ...unresolvedRefundDocuments(subscriptionOrdersSnapshot),
    ];

    if (String(job.status || '') === 'completed') {
      const protectionActive = Number(job.protectUntilMs || 0) > nowMs;
      // Repeated deletion of an already removed account is idempotent. If the
      // same UID is legitimately initialized again after the protection window,
      // however, the old tombstone must not turn the new deletion into a no-op.
      if (!userSnapshot.exists || protectionActive) {
        return { alreadyCompleted: true, protectionActive, jobRef, userRef };
      }
    }
    if (String(job.status || '') === 'manual_review') {
      throw deletionError('ACCOUNT_DELETION_MANUAL_REVIEW', 503, '탈퇴 정리를 운영팀이 확인하고 있어요. 사이트 내 고객센터로 문의해 주세요.');
    }
    if (source === 'request' && String(job.status || '') === 'retry_pending') {
      throw deletionError('ACCOUNT_DELETION_PENDING', 202, '탈퇴 데이터 정리를 자동으로 이어서 처리하고 있어요. 잠시만 기다려 주세요.');
    }
    if (activeDeletionLease(job, nowMs)) {
      throw deletionError('ACCOUNT_DELETION_IN_PROGRESS', 409, '회원 탈퇴 처리가 이미 진행 중이에요.');
    }
    if (userSnapshot.exists && activeSubscription(user, nowMs)) {
      throw deletionError('ACCOUNT_ACTIVE_SUBSCRIPTION', 409, '진행 중이거나 해지 예정인 구독이 있어 탈퇴할 수 없어요.');
    }
    if (activeSubscriptionOperation(subscriptionClaim)) {
      throw deletionError('ACCOUNT_SUBSCRIPTION_OPERATION_PENDING', 409, '구독 결제 처리가 끝난 뒤 다시 시도해 주세요.');
    }
    if (activePaymentAccountClaims(paymentClaim)) {
      throw deletionError('ACCOUNT_PAYMENT_OPERATION_PENDING', 409, '결제 또는 환불 처리가 끝난 뒤 다시 시도해 주세요.');
    }
    if (activeAccountActivityClaims(activityClaim, nowMs).active) {
      throw deletionError('ACCOUNT_CONTENT_OPERATION_PENDING', 409, '진행 중인 글 처리가 끝난 뒤 다시 시도해 주세요.');
    }
    if (pendingRefunds.length) {
      throw deletionError('ACCOUNT_REFUND_OPERATION_PENDING', 409, '접수된 환불 처리가 끝난 뒤 다시 시도해 주세요.');
    }
    if (financialQueryTruncated(ordersSnapshot) || financialQueryTruncated(subscriptionOrdersSnapshot)) {
      throw deletionError('ACCOUNT_FINANCIAL_REVIEW_REQUIRED', 409, '결제 기록이 많아 탈퇴 전 운영팀 확인이 필요해요. 사이트 내 고객센터로 문의해 주세요.');
    }

    const patch = {
      status: 'processing',
      source,
      attempts: Math.max(0, Number(job.attempts) || 0) + 1,
      leaseUntilMs: nowMs + LEASE_MS,
      protectUntilMs: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!jobSnapshot.exists) patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
    transaction.set(jobRef, patch, { merge: true });
    return { alreadyCompleted: false, jobRef, userRef };
  });
}

function storageObjectFromUrl(value, expectedBucket = '') {
  let url;
  let bucket = '';
  let object = '';
  try {
    url = new URL(String(value || ''));
    if (url.hostname === 'firebasestorage.googleapis.com') {
      const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/u);
      if (!match) return null;
      bucket = decodeURIComponent(match[1]);
      object = decodeURIComponent(match[2]);
    } else if (url.hostname === 'storage.googleapis.com') {
      const parts = url.pathname.replace(/^\//u, '').split('/');
      bucket = decodeURIComponent(parts.shift() || '');
      object = parts.map(part => decodeURIComponent(part)).join('/');
    } else {
      return null;
    }
  } catch {
    // Malformed percent encodings are user-controlled legacy data. Treat them
    // as non-deletable instead of trapping the account in an endless retry.
    return null;
  }
  if (!bucket || !object || object.includes('\0')) return null;
  if (expectedBucket && bucket !== expectedBucket) return null;
  // Account deletion only owns the retired community uploader namespace.
  // Never follow a forged Firebase URL into another product object.
  if (!object.startsWith('community_photos/')) return null;
  return { bucket, object };
}

async function exclusiveStoragePhotos(db, uid, photos, expectedBucket) {
  // Download-token/query variants can point at the same object, so raw URL
  // equality is not a safe ownership boundary. Community is closed and account
  // deletion is rare; scan the retired collection once and compare canonical
  // bucket/object identities before deleting any legacy object.
  const allPosts = await db.collection('posts').select('authorId', 'photos').get();
  const referencedByOtherAuthors = new Set();
  for (const post of allPosts.docs) {
    const row = post.data() || {};
    if (String(row.authorId || '') === String(uid)) continue;
    for (const photo of Array.isArray(row.photos) ? row.photos : []) {
      const parsed = storageObjectFromUrl(photo, expectedBucket);
      if (parsed) referencedByOtherAuthors.add(`${parsed.bucket}/${parsed.object}`);
    }
  }
  return [...new Set(photos.map(value => String(value || '')).filter(Boolean))].filter(photo => {
    const parsed = storageObjectFromUrl(photo, expectedBucket);
    return parsed && !referencedByOtherAuthors.has(`${parsed.bucket}/${parsed.object}`);
  });
}

async function deleteRefs(db, refs) {
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = db.batch();
    refs.slice(offset, offset + 400).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

async function removeUidFromLikedPosts({ admin, db, uid }) {
  const snapshot = await db.collection('posts').where('likes', 'array-contains', uid).get();
  for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
    const batch = db.batch();
    for (const doc of snapshot.docs.slice(offset, offset + 400)) {
      batch.update(doc.ref, { likes: admin.firestore.FieldValue.arrayRemove(uid) });
    }
    await batch.commit();
  }
  return snapshot.docs.length;
}

function withoutDeletedParentMention(body, authorName) {
  const text = String(body || '');
  const name = String(authorName || '').trim();
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^@${escaped}\\s*`, 'u'), '');
}

async function detachRepliesToDeletedComments({ admin, db, uid, comments }) {
  let updated = 0;
  for (const comment of comments) {
    const data = comment.data() || {};
    const replies = await comment.ref.parent.where('parentCommentId', '==', comment.id).get();
    const targets = replies.docs.filter(reply => String(reply.data()?.authorId || '') !== String(uid));
    for (let offset = 0; offset < targets.length; offset += 400) {
      const batch = db.batch();
      for (const reply of targets.slice(offset, offset + 400)) {
        const replyData = reply.data() || {};
        batch.update(reply.ref, {
          body: withoutDeletedParentMention(replyData.body, data.authorName),
          parentCommentId: admin.firestore.FieldValue.delete(),
          parentDeleted: true,
        });
        updated++;
      }
      await batch.commit();
    }
  }
  return updated;
}

async function deleteLegacyCommentNotifications({ db, uid, comments }) {
  // The retired community notification schema did not store actorUid. Recover a
  // safe link only when the deleted author's display label is unique within the
  // same post; otherwise keep the row rather than erase another person's alert.
  const byCommentCollection = new Map();
  for (const comment of comments) {
    const collectionRef = comment.ref?.parent;
    const postId = collectionRef?.parent?.id;
    const authorName = String(comment.data()?.authorName || '').trim();
    if (!collectionRef?.path || !postId || !authorName) continue;
    const group = byCommentCollection.get(collectionRef.path) || {
      collectionRef, postId, deletedNames: new Set(),
    };
    group.deletedNames.add(authorName);
    byCommentCollection.set(collectionRef.path, group);
  }

  const notificationRefs = new Map();
  for (const group of byCommentCollection.values()) {
    const allComments = await group.collectionRef.get();
    const ambiguousNames = new Set();
    for (const row of allComments.docs) {
      const data = row.data() || {};
      const name = String(data.authorName || '').trim();
      if (name && group.deletedNames.has(name) && String(data.authorId || '') !== String(uid)) {
        ambiguousNames.add(name);
      }
    }
    const safeMessages = new Set([...group.deletedNames]
      .filter(name => !ambiguousNames.has(name))
      .map(name => `${name}님이 내 글에 댓글을 달았어요`));
    if (!safeMessages.size) continue;
    const notifications = await db.collectionGroup('notifications')
      .where('postId', '==', group.postId)
      .get();
    for (const notification of notifications.docs) {
      if (safeMessages.has(String(notification.data()?.message || ''))) {
        notificationRefs.set(notification.ref.path, notification.ref);
      }
    }
  }
  await deleteRefs(db, [...notificationRefs.values()]);
  return notificationRefs.size;
}

async function deleteSubcollection(db, userRef, name) {
  while (true) {
    const snapshot = await userRef.collection(name).limit(400).get();
    if (!snapshot.docs.length) return;
    await deleteRefs(db, snapshot.docs.map(doc => doc.ref));
  }
}

async function deleteStoragePhotos(admin, photos, expectedBucket) {
  const configuredBucket = String(expectedBucket || '').trim();
  const hasFirebaseStoragePhoto = photos.some((photo) => {
    try {
      const url = new URL(String(photo || ''));
      return url.hostname === 'firebasestorage.googleapis.com'
        || url.hostname === 'storage.googleapis.com';
    } catch {
      return false;
    }
  });
  // A missing bucket must never widen deletion to an arbitrary bucket encoded in
  // user-controlled legacy photo URLs. Keep the account job retryable until the
  // exact production bucket is configured.
  if (hasFirebaseStoragePhoto && !configuredBucket) {
    throw deletionError(
      'ACCOUNT_STORAGE_BUCKET_UNCONFIGURED',
      503,
      'Firebase Storage bucket is not configured',
    );
  }
  const objects = new Map();
  for (const photo of photos) {
    const parsed = storageObjectFromUrl(photo, configuredBucket);
    if (parsed) objects.set(`${parsed.bucket}/${parsed.object}`, parsed);
  }
  for (const parsed of objects.values()) {
    await admin.storage().bucket(parsed.bucket).file(parsed.object).delete({ ignoreNotFound: true });
  }
  return objects.size;
}

async function deleteUserGeneratedContent({ admin, db, uid, storageBucket }) {
  const posts = await db.collection('posts').where('authorId', '==', uid).get();
  const postRefs = [];
  const photos = [];
  for (const post of posts.docs) {
    const data = post.data() || {};
    if (Array.isArray(data.photos)) photos.push(...data.photos);
    const comments = await post.ref.collection('comments').get();
    await deleteRefs(db, comments.docs.map(doc => doc.ref));
    postRefs.push(post.ref);
  }
  if (photos.length) {
    const exclusivePhotos = await exclusiveStoragePhotos(db, uid, photos, storageBucket);
    await deleteStoragePhotos(admin, exclusivePhotos, storageBucket);
  }
  await deleteRefs(db, postRefs);

  const questions = await db.collection('qna').where('authorId', '==', uid).get();
  await deleteRefs(db, questions.docs.map(doc => doc.ref));
  const comments = await db.collectionGroup('comments').where('authorId', '==', uid).get();
  const detachedReplies = await detachRepliesToDeletedComments({ admin, db, uid, comments: comments.docs });
  const legacyCommentNotifications = await deleteLegacyCommentNotifications({ db, uid, comments: comments.docs });
  await deleteRefs(db, comments.docs.map(doc => doc.ref));
  const likedPosts = await removeUidFromLikedPosts({ admin, db, uid });
  const actorNotifications = await db.collectionGroup('notifications').where('actorUid', '==', uid).get();
  await deleteRefs(db, actorNotifications.docs.map(doc => doc.ref));
  return {
    posts: postRefs.length,
    qna: questions.docs.length,
    comments: comments.docs.length,
    detachedReplies,
    likedPosts,
    legacyCommentNotifications,
    actorNotifications: actorNotifications.docs.length,
  };
}

async function deleteAuthenticationBindings(db, uid) {
  const identities = await db.collection('authIdentities').where('uid', '==', uid).get();
  await deleteRefs(db, identities.docs.map(doc => doc.ref));
  return identities.docs.length;
}

async function deleteCollectionRowsForUid(db, collectionName, uid, uidField = 'uid') {
  let deleted = 0;
  while (true) {
    const snapshot = await db.collection(collectionName)
      .where(uidField, '==', uid)
      .limit(400)
      .get();
    if (!snapshot.docs.length) return deleted;
    await deleteRefs(db, snapshot.docs.map(doc => doc.ref));
    deleted += snapshot.docs.length;
  }
}

async function deleteUserOperationalData(db, uid) {
  const counts = {};
  for (const collectionName of USER_OPERATIONAL_COLLECTIONS) {
    counts[collectionName] = await deleteCollectionRowsForUid(db, collectionName, uid);
  }
  // Short anti-abuse counters are no longer useful after the inviter account is
  // closed. Financial referral ledgers already materialized on orders/user
  // ledgers are handled under their own retention policy.
  counts.referralDaily = await deleteCollectionRowsForUid(db, 'referralDaily', uid, 'inviterUid');
  return counts;
}

async function deleteServerSidePersonalState(db, uid) {
  const quotaSnapshot = await db.collection('clientWriteQuotas').where('uid', '==', uid).get();
  await deleteRefs(db, quotaSnapshot.docs.map(doc => doc.ref));
  await Promise.all([
    db.collection('accountSecurity').doc(uid).delete(),
    db.collection('paymentAccountClaims').doc(uid).delete(),
    db.collection('subscriptionOperationClaims').doc(uid).delete(),
    db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid).delete(),
  ]);
  return { clientWriteQuotas: quotaSnapshot.docs.length };
}

function safeFailureCode(error) {
  const grpcCode = String(error && error.code || '').toLowerCase();
  const message = String(error && (error.message || error.details) || '');
  if (
    ['9', 'failed-precondition', 'failed_precondition'].includes(grpcCode)
    && /(?:requires?|needed).{0,80}(?:collection[_ -]?group.{0,40})?index|create_exemption=/iu.test(message)
  ) {
    return 'ACCOUNT_COLLECTION_GROUP_INDEX_REQUIRED';
  }
  const value = String(error && error.code || 'ACCOUNT_DELETION_FAILED');
  return /^[A-Z0-9_./-]{1,80}$/u.test(value) ? value : 'ACCOUNT_DELETION_FAILED';
}

async function accountDeletionIndexesReady(db) {
  const sentinel = '__account_deletion_index_probe__';
  await Promise.all(ACCOUNT_DELETION_INDEX_PROBES.map(({ collectionGroup, fieldPath }) => (
    db.collectionGroup(collectionGroup).where(fieldPath, '==', sentinel).limit(1).get()
  )));
  return true;
}

function indexBlockedManualReview(row) {
  return String(row?.status || '') === 'manual_review'
    && String(row?.lastFailurePhase || '') === 'user_generated_content'
    && INDEX_RECOVERABLE_ERROR_CODES.has(String(row?.lastErrorCode || ''))
    && Math.max(0, Number(row?.indexRecoveryCount) || 0) < 1;
}

async function requeueIndexBlockedAccountDeletions({ admin, db, logger, limit = 10 }) {
  if (!admin || !db) return { indexesReady: false, examined: 0, requeued: 0 };
  const snapshot = await db.collection('accountDeletionJobs')
    .where('status', '==', 'manual_review')
    .limit(Math.min(25, Math.max(1, Number(limit) || 10)))
    .get();
  const candidates = snapshot.docs.filter(job => indexBlockedManualReview(job.data() || {}));
  if (!candidates.length) {
    return { indexesReady: null, examined: snapshot.docs.length, requeued: 0 };
  }
  try {
    await accountDeletionIndexesReady(db);
  } catch {
    return { indexesReady: false, examined: snapshot.docs.length, requeued: 0 };
  }
  let requeued = 0;
  for (const job of candidates) {
    const changed = await db.runTransaction(async transaction => {
      const currentSnapshot = await transaction.get(job.ref);
      const current = currentSnapshot.exists ? currentSnapshot.data() || {} : {};
      if (!indexBlockedManualReview(current)) return false;
      transaction.set(job.ref, {
        status: 'retry_pending',
        attempts: 0,
        leaseUntilMs: 0,
        indexRecoveryCount: Math.max(0, Number(current.indexRecoveryCount) || 0) + 1,
        indexRecoveryFromCode: String(current.lastErrorCode || '').slice(0, 80),
        indexRecoveryAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (!changed) continue;
    requeued++;
    logger.info('account.deletion_index_requeued', { uid: job.id });
  }
  return { indexesReady: true, examined: snapshot.docs.length, requeued };
}

async function executeAccountDeletion({ admin, db, logger, uid, source = 'request' }) {
  if (!admin || !db || !uid) throw deletionError('ACCOUNT_DELETION_UNAVAILABLE', 503);
  const now = Date.now();
  const lease = await acquireDeletionLease({ admin, db, uid, source, nowMs: now });
  const { jobRef, userRef } = lease;
  if (lease.alreadyCompleted) {
    return {
      ok: true,
      alreadyCompleted: true,
      protectionActive: lease.protectionActive === true,
      progress: { phase: 'completed', cleanupStarted: false, userDeleted: true, authDeleted: true },
    };
  }

  const progress = {
    phase: 'lease_acquired',
    cleanupStarted: false,
    userDeleted: false,
    authDeleted: false,
  };

  try {
    progress.cleanupStarted = true;
    progress.phase = 'user_subcollections';
    for (const name of USER_SUBCOLLECTIONS) await deleteSubcollection(db, userRef, name);
    progress.phase = 'billing_secrets';
    await db.collection('billingSecrets').doc(uid).delete();
    progress.phase = 'user_generated_content';
    const ugc = await deleteUserGeneratedContent({
      admin,
      db,
      uid,
      // The bucket name is a public Firebase project identifier, not a secret.
      // Keep an environment override for migrations while making production
      // deletion safe even when the optional Render variable is absent.
      storageBucket: String(process.env.FIREBASE_STORAGE_BUCKET || DEFAULT_STORAGE_BUCKET).trim(),
    });
    progress.phase = 'operational_content';
    const operationalData = await deleteUserOperationalData(db, uid);
    progress.phase = 'authentication_bindings';
    const authenticationBindings = await deleteAuthenticationBindings(db, uid);
    progress.phase = 'server_personal_state';
    const serverSidePersonalState = await deleteServerSidePersonalState(db, uid);
    // 법정 보존 대상인 주문·환불 원장은 서버 전용 컬렉션에 유지한다.
    progress.phase = 'user_document';
    await userRef.delete();
    progress.userDeleted = true;
    progress.phase = 'firebase_auth';
    try {
      await admin.auth().deleteUser(uid);
      progress.authDeleted = true;
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      progress.authDeleted = true;
    }
    // Keep a server-only tombstone so late Toss callbacks and webhook retries
    // cannot recreate credits or a subscription after Auth/user deletion.
    const protectUntilMs = Date.now() + COMPLETED_PROTECTION_MS;
    progress.phase = 'tombstone';
    await jobRef.set({
      status: 'completed',
      source,
      leaseUntilMs: 0,
      protectUntilMs,
      expireAt: admin.firestore.Timestamp?.fromMillis
        ? admin.firestore.Timestamp.fromMillis(protectUntilMs)
        : new Date(protectUntilMs),
      retainedFinancialCollections: RETAINED_FINANCIAL_COLLECTIONS,
      retentionReasonCode: 'LEGAL_FINANCIAL_RECORD',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastErrorCode: admin.firestore.FieldValue.delete(),
      lastFailurePhase: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    progress.phase = 'completed';
    logger.info('account.deleted', {
      uid, source, deletedSubcollections: USER_SUBCOLLECTIONS, billingSecrets: true,
      authenticationBindings, ugc,
      operationalData,
      serverSidePersonalState,
      retainedFinancialCollections: RETAINED_FINANCIAL_COLLECTIONS,
      retentionReasonCode: 'LEGAL_FINANCIAL_RECORD',
    });
    return {
      ok: true,
      authenticationBindings,
      serverSidePersonalState,
      operationalData,
      ugc,
      progress,
      retainedFinancialCollections: RETAINED_FINANCIAL_COLLECTIONS,
    };
  } catch (error) {
    await jobRef.set({
      status: 'retry_pending',
      lastErrorCode: safeFailureCode(error),
      lastFailurePhase: progress.phase,
      leaseUntilMs: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    error.deletionProgress = { ...progress };
    throw error;
  }
}

async function reconcilePendingAccountDeletions({ admin, db, logger, limit = 10 }) {
  if (!admin || !db) return { processed: 0, completed: 0, failed: 0, manualReview: 0 };
  const now = Date.now();
  const indexRecovery = await requeueIndexBlockedAccountDeletions({ admin, db, logger, limit });
  const snapshot = await db.collection('accountDeletionJobs')
    .where('status', 'in', ['retry_pending', 'processing'])
    .limit(Math.min(25, Math.max(1, Number(limit) || 10)))
    .get();
  const result = {
    processed: 0,
    completed: 0,
    failed: 0,
    manualReview: 0,
    indexRecovered: indexRecovery.requeued,
  };
  for (const job of snapshot.docs) {
    const data = job.data() || {};
    if (data.status === 'processing' && Number(data.leaseUntilMs) > now) continue;
    if (Number(data.attempts) >= MAX_ATTEMPTS) {
      result.manualReview++;
      await job.ref.set({ status: 'manual_review', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      logger.error('account.deletion_manual_review_required', {
        uid: job.id,
        attempts: Number(data.attempts) || 0,
        lastErrorCode: String(data.lastErrorCode || 'ACCOUNT_DELETION_FAILED').slice(0, 80),
        lastFailurePhase: String(data.lastFailurePhase || 'unknown').slice(0, 80),
      });
      continue;
    }
    result.processed++;
    try {
      await executeAccountDeletion({ admin, db, logger, uid: job.id, source: 'cron_retry' });
      result.completed++;
    } catch (error) {
      result.failed++;
      logger.warn('account.deletion_retry_failed', { uid: job.id, code: safeFailureCode(error) });
    }
  }
  return result;
}

module.exports = {
  COMPLETED_PROTECTION_MS,
  MAX_ATTEMPTS,
  DEFAULT_STORAGE_BUCKET,
  RETAINED_FINANCIAL_COLLECTIONS,
  USER_SUBCOLLECTIONS,
  USER_OPERATIONAL_COLLECTIONS,
  activeSubscription,
  activeSubscriptionOperation,
  activePaymentAccountClaims,
  acquireDeletionLease,
  deleteAuthenticationBindings,
  deleteUserOperationalData,
  deleteServerSidePersonalState,
  exclusiveStoragePhotos,
  deleteStoragePhotos,
  executeAccountDeletion,
  reconcilePendingAccountDeletions,
  requeueIndexBlockedAccountDeletions,
  safeFailureCode,
  storageObjectFromUrl,
  unresolvedRefundDocuments,
};
