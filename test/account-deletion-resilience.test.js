'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  COMPLETED_PROTECTION_MS,
  DEFAULT_STORAGE_BUCKET,
  RETAINED_FINANCIAL_COLLECTIONS,
  USER_SUBCOLLECTIONS,
  USER_OPERATIONAL_COLLECTIONS,
  activePaymentAccountClaims,
  activeSubscription,
  activeSubscriptionOperation,
  acquireDeletionLease,
  deleteUserOperationalData,
  deleteStoragePhotos,
  exclusiveStoragePhotos,
  requeueIndexBlockedAccountDeletions,
  safeFailureCode,
  storageObjectFromUrl,
} = require('../lib/accountDeletion');
const {
  TRANSFORM_LANE,
  WRITING_LANE,
  accountDeletionBlocksWrites,
  activeAccountActivityClaims,
  laneWithClaim,
  laneWithoutClaim,
} = require('../lib/accountActivityClaims');

test('account deletion includes tracked credit lots and blocks live subscriptions', () => {
  assert.ok(USER_SUBCOLLECTIONS.includes('creditLots'));
  assert.equal(activeSubscription({ subscription: { status: 'active' } }), true);
  assert.equal(activeSubscription({ subscription: { status: 'expired' } }), false);
  assert.equal(activeSubscription({
    subscription: { status: 'cancelled', nextBillingAt: { toMillis: () => Date.now() + 60_000 } },
  }), true);
});

test('account deletion blocks every unsettled payment and subscription operation lane', () => {
  assert.equal(activeSubscriptionOperation({ operation: 'start', status: 'charging' }), true);
  assert.equal(activeSubscriptionOperation({ operation: 'renewal', status: 'charged' }), true);
  assert.equal(activeSubscriptionOperation({ operation: 'expiry', status: 'deleting' }), true);
  assert.equal(activeSubscriptionOperation({ operation: 'start', status: 'applied' }), false);
  assert.equal(activePaymentAccountClaims({ activeCreditIntents: { o1: { status: 'confirming' } } }), true);
  assert.equal(activePaymentAccountClaims({ activeSubscriptionRefunds: { s1: { status: 'provider_canceling' } } }), true);
  assert.equal(activePaymentAccountClaims({ activeCreditIntents: {}, updatedAtMs: 1 }), false);
  assert.equal(COMPLETED_PROTECTION_MS, 30 * 24 * 60 * 60 * 1000);
});

function deletionLeaseFixture(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const ref = path => ({ path, id: path.split('/').at(-1) });
  const querySnapshot = target => {
    const prefix = `${target.collectionName}/`;
    const docs = [];
    for (const [pathName, value] of rows) {
      if (!pathName.startsWith(prefix) || pathName.slice(prefix.length).includes('/')) continue;
      const matches = target.filters.every(filter => (
        filter.op === '==' && value?.[filter.field] === filter.value
      ));
      if (matches) docs.push({ ref: ref(pathName), id: pathName.slice(prefix.length), data: () => value });
      if (docs.length >= target.limitValue) break;
    }
    return { docs, size: docs.length, empty: docs.length === 0 };
  };
  const query = (collectionName, filters = [], limitValue = Infinity) => ({
    query: true,
    collectionName,
    filters,
    limitValue,
    where(field, op, value) { return query(collectionName, [...filters, { field, op, value }], limitValue); },
    limit(value) { return query(collectionName, filters, value); },
    async get() { return querySnapshot(this); },
  });
  const db = {
    collection(name) {
      return {
        doc(id) { return ref(`${name}/${id}`); },
        where(field, op, value) { return query(name, [{ field, op, value }]); },
        limit(value) { return query(name, [], value); },
      };
    },
    async runTransaction(callback) {
      return callback({
        async get(target) {
          if (target.query) return querySnapshot(target);
          const exists = rows.has(target.path);
          return { exists, data: () => rows.get(target.path) || {} };
        },
        set(target, value, options) {
          const previous = options?.merge ? rows.get(target.path) || {} : {};
          rows.set(target.path, { ...previous, ...value });
        },
      });
    },
    batch() {
      const deletes = [];
      return {
        delete(target) { deletes.push(target.path); },
        async commit() { deletes.forEach(pathName => rows.delete(pathName)); },
      };
    },
  };
  const admin = { firestore: { FieldValue: { serverTimestamp: () => 'server-ts' } } };
  return { admin, db, rows };
}

test('deletion lease atomically refuses unsettled payment claims before creating a job', async () => {
  const fixture = deletionLeaseFixture({
    'users/u1': { credits: 10 },
    'paymentAccountClaims/u1': { activeCreditIntents: { o1: { status: 'confirming' } } },
  });
  await assert.rejects(
    acquireDeletionLease({ ...fixture, uid: 'u1', source: 'request', nowMs: 1_000 }),
    error => error.code === 'ACCOUNT_PAYMENT_OPERATION_PENDING' && error.status === 409,
  );
  assert.equal(fixture.rows.has('accountDeletionJobs/u1'), false);
});

test('deletion lease records one processing owner only after account operations are clear', async () => {
  const fixture = deletionLeaseFixture({ 'users/u1': { credits: 10 } });
  const result = await acquireDeletionLease({ ...fixture, uid: 'u1', source: 'request', nowMs: 1_000 });
  assert.equal(result.alreadyCompleted, false);
  assert.deepEqual(fixture.rows.get('accountDeletionJobs/u1'), {
    status: 'processing',
    source: 'request',
    attempts: 1,
    leaseUntilMs: 1_000 + (15 * 60 * 1000),
    protectUntilMs: 0,
    updatedAt: 'server-ts',
    createdAt: 'server-ts',
  });
});

test('repeated user clicks cannot consume the retry budget after deletion is pending', async () => {
  const fixture = deletionLeaseFixture({
    'users/u1': { credits: 10 },
    'accountDeletionJobs/u1': { status: 'retry_pending', attempts: 1, leaseUntilMs: 0 },
  });
  await assert.rejects(
    acquireDeletionLease({ ...fixture, uid: 'u1', source: 'request', nowMs: 2_000 }),
    error => error.code === 'ACCOUNT_DELETION_PENDING' && error.status === 202,
  );
  assert.deepEqual(fixture.rows.get('accountDeletionJobs/u1'), {
    status: 'retry_pending', attempts: 1, leaseUntilMs: 0,
  });
  const cronLease = await acquireDeletionLease({ ...fixture, uid: 'u1', source: 'cron_retry', nowMs: 2_000 });
  assert.equal(cronLease.alreadyCompleted, false);
  assert.equal(fixture.rows.get('accountDeletionJobs/u1').attempts, 2);
  assert.equal(fixture.rows.get('accountDeletionJobs/u1').status, 'processing');
});

test('deletion lease blocks active content work and unresolved refund rows', async () => {
  const nowMs = 10_000;
  const activity = {
    [TRANSFORM_LANE]: laneWithClaim({}, TRANSFORM_LANE, {
      id: 'job-1', status: 'running', ttlMs: 60_000,
    }, nowMs),
  };
  assert.equal(activeAccountActivityClaims(activity, nowMs).active, true);
  const activeFixture = deletionLeaseFixture({
    'users/u1': { credits: 10 },
    'accountActivityClaims/u1': activity,
  });
  await assert.rejects(
    acquireDeletionLease({ ...activeFixture, uid: 'u1', source: 'request', nowMs }),
    error => error.code === 'ACCOUNT_CONTENT_OPERATION_PENDING',
  );

  const refundFixture = deletionLeaseFixture({
    'users/u2': { credits: 10 },
    'orders/order-1': { uid: 'u2', status: 'refund_requested' },
  });
  await assert.rejects(
    acquireDeletionLease({ ...refundFixture, uid: 'u2', source: 'request', nowMs }),
    error => error.code === 'ACCOUNT_REFUND_OPERATION_PENDING',
  );
});

test('completed tombstone is idempotent until protection ends but does not mask a re-created user later', async () => {
  const protectedFixture = deletionLeaseFixture({
    'accountDeletionJobs/u1': { status: 'completed', protectUntilMs: 20_000 },
  });
  const repeated = await acquireDeletionLease({ ...protectedFixture, uid: 'u1', source: 'request', nowMs: 10_000 });
  assert.equal(repeated.alreadyCompleted, true);
  assert.equal(repeated.protectionActive, true);

  const recreatedFixture = deletionLeaseFixture({
    'users/u1': { credits: 10 },
    'accountDeletionJobs/u1': { status: 'completed', protectUntilMs: 5_000 },
  });
  const fresh = await acquireDeletionLease({ ...recreatedFixture, uid: 'u1', source: 'request', nowMs: 10_000 });
  assert.equal(fresh.alreadyCompleted, false);
  assert.equal(recreatedFixture.rows.get('accountDeletionJobs/u1').status, 'processing');
});

test('activity lanes expire, release independently, and completed tombstones block only during protection', () => {
  const nowMs = 50_000;
  let row = {
    [TRANSFORM_LANE]: laneWithClaim({}, TRANSFORM_LANE, {
      id: 'transform-1', status: 'running', ttlMs: 60_000,
    }, nowMs),
    [WRITING_LANE]: laneWithClaim({}, WRITING_LANE, {
      id: 'writing-1', status: 'PROCESSING', ttlMs: 60_000,
    }, nowMs),
  };
  assert.deepEqual(activeAccountActivityClaims(row, nowMs), {
    active: true, transformCount: 1, writingCount: 1,
  });
  row = { ...row, [TRANSFORM_LANE]: laneWithoutClaim(row, TRANSFORM_LANE, 'transform-1', nowMs) };
  assert.deepEqual(activeAccountActivityClaims(row, nowMs), {
    active: true, transformCount: 0, writingCount: 1,
  });
  assert.equal(activeAccountActivityClaims(row, nowMs + 60_001).active, false);
  assert.equal(accountDeletionBlocksWrites({ status: 'processing' }, nowMs), true);
  assert.equal(accountDeletionBlocksWrites({ status: 'completed', protectUntilMs: nowMs + 1 }, nowMs), true);
  assert.equal(accountDeletionBlocksWrites({ status: 'completed', protectUntilMs: nowMs }, nowMs), false);
});

test('operational user content and counters are deleted while financial ledgers are explicitly retained', async () => {
  const initial = {};
  for (const collectionName of USER_OPERATIONAL_COLLECTIONS) {
    initial[`${collectionName}/${collectionName}-owned`] = { uid: 'u1', value: 'private' };
    initial[`${collectionName}/${collectionName}-other`] = { uid: 'u2', value: 'keep' };
  }
  initial['referralDaily/u1_2026-08-30'] = { inviterUid: 'u1', count: 1 };
  initial['orders/order-retained'] = { uid: 'u1', status: 'paid' };
  const fixture = deletionLeaseFixture(initial);
  const counts = await deleteUserOperationalData(fixture.db, 'u1');
  for (const collectionName of USER_OPERATIONAL_COLLECTIONS) {
    assert.equal(counts[collectionName], 1);
    assert.equal(fixture.rows.has(`${collectionName}/${collectionName}-owned`), false);
    assert.equal(fixture.rows.has(`${collectionName}/${collectionName}-other`), true);
  }
  assert.equal(counts.referralDaily, 1);
  assert.equal(fixture.rows.has('orders/order-retained'), true);
  for (const collectionName of ['orders', 'subscriptionOrders', 'paymentSecrets', 'paymentIntents']) {
    assert.equal(RETAINED_FINANCIAL_COLLECTIONS.includes(collectionName), true);
  }
});

test('storage cleanup accepts only exact Firebase Storage object URLs and expected bucket', () => {
  const bucket = 'url88-d1d27.firebasestorage.app';
  assert.deepEqual(
    storageObjectFromUrl(`https://firebasestorage.googleapis.com/v0/b/${bucket}/o/community_photos%2Fu1%2Fphoto.jpg?alt=media`, bucket),
    { bucket, object: 'community_photos/u1/photo.jpg' },
  );
  assert.equal(storageObjectFromUrl('https://evil.example/v0/b/x/o/y', bucket), null);
  assert.equal(storageObjectFromUrl('https://firebasestorage.googleapis.com/v0/b/other/o/a', bucket), null);
  assert.equal(
    storageObjectFromUrl(`https://firebasestorage.googleapis.com/v0/b/${bucket}/o/profile_photos%2Fu1.jpg`, bucket),
    null,
  );
  assert.doesNotThrow(() => storageObjectFromUrl(
    `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/community_photos%2Fbad%ZZ`,
    bucket,
  ));
});

test('storage cleanup excludes a photo referenced by another author', async () => {
  const bucket = DEFAULT_STORAGE_BUCKET;
  const shared = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/community_photos%2Fshared.jpg?alt=media&token=owner-copy`;
  const sharedVariant = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/community_photos%2Fshared.jpg?alt=media&token=other-copy`;
  const owned = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/community_photos%2Fowned.jpg?alt=media`;
  const db = {
    collection(name) {
      assert.equal(name, 'posts');
      return {
        select(...fields) {
          assert.deepEqual(fields, ['authorId', 'photos']);
          return { get: async () => ({ docs: [
            { data: () => ({ authorId: 'owner', photos: [shared, owned] }) },
            { data: () => ({ authorId: 'other', photos: [sharedVariant] }) },
          ] }) };
        }
      };
    },
  };
  assert.deepEqual(
    await exclusiveStoragePhotos(db, 'owner', [shared, owned, owned], bucket),
    [owned],
  );
});

test('storage URL parser never treats non-Firebase hosts as deletable objects', () => {
  const bucket = 'url88-d1d27.firebasestorage.app';
  assert.equal(storageObjectFromUrl('https://storage.googleapis.com.evil.example/bucket/object', bucket), null);
  assert.equal(storageObjectFromUrl('javascript:alert(1)', bucket), null);
  assert.equal(storageObjectFromUrl('https://storage.googleapis.com/other/object', bucket), null);
});

test('account deletion reaches the Firebase Admin 14 storage adapter with the fixed production bucket', async () => {
  const deleted = [];
  const admin = {
    storage() {
      return {
        bucket(bucketName) {
          assert.equal(bucketName, DEFAULT_STORAGE_BUCKET);
          return {
            file(objectName) {
              return {
                async delete(options) { deleted.push({ objectName, options }); }
              };
            }
          };
        }
      };
    }
  };
  const count = await deleteStoragePhotos(admin, [
    `https://firebasestorage.googleapis.com/v0/b/${DEFAULT_STORAGE_BUCKET}/o/community_photos%2Fu1%2Fphoto.jpg?alt=media`,
    `https://firebasestorage.googleapis.com/v0/b/${DEFAULT_STORAGE_BUCKET}/o/community_photos%2Fu1%2Fphoto.jpg?alt=media&token=duplicate`,
    'https://evil.example/not-a-storage-object'
  ], DEFAULT_STORAGE_BUCKET);
  assert.equal(count, 1);
  assert.deepEqual(deleted, [{
    objectName: 'community_photos/u1/photo.jpg',
    options: { ignoreNotFound: true }
  }]);
});

test('route reports pending cleanup instead of silently completing partial deletion', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'account.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accountDeletion.js'), 'utf8');
  assert.match(route, /ACCOUNT_DELETION_PENDING/);
  assert.match(route, /account\.delete_retry_pending/);
  assert.match(route, /ACCOUNT_DELETION_MANUAL_REVIEW/);
  assert.match(route, /account\.delete_manual_review_waiting/);
  assert.match(route, /partial:\s*progress\.cleanupStarted === true/);
  assert.match(route, /accountDeleted:\s*progress\.authDeleted === true/);
  assert.match(route, /ACCOUNT_DELETION_CONFIRMATION_REQUIRED/);
  assert.match(service, /status:\s*'retry_pending'/);
  assert.match(service, /subscriptionOperationClaims/);
  assert.match(service, /paymentAccountClaims/);
  assert.match(service, /status:\s*'completed'/);
  assert.match(service, /const protectUntilMs = Date\.now\(\) \+ COMPLETED_PROTECTION_MS/);
  assert.match(service, /reconcilePendingAccountDeletions/);
  assert.match(service, /authIdentities.*where\('uid', '==', uid\)/s);
  assert.match(service, /clientWriteQuotas.*where\('uid', '==', uid\)/s);
  assert.match(service, /accountSecurity/);
  assert.match(service, /paymentAccountClaims/);
  assert.match(service, /subscriptionOperationClaims/);
  for (const collectionName of [
    'transformJobs', 'transformJobArchive', 'writingLabV2Jobs',
    'writingLabDailyUsage', 'writingLabGenerationCommits'
  ]) {
    assert.match(service, new RegExp(`['"]${collectionName}['"]`, 'u'));
  }
  assert.match(service, /where\('likes', 'array-contains', uid\)/u);
  assert.match(service, /collectionGroup\('notifications'\).*where\('actorUid', '==', uid\)/s);
  assert.match(service, /collectionGroup\('notifications'\).*where\('postId', '==', group\.postId\)/s);
  assert.match(service, /ambiguousNames\.has\(name\)/u);
  assert.match(service, /safeMessages\.has\(String\(notification\.data\(\)\?\.message/u);
  assert.match(service, /parentCommentId:\s*admin\.firestore\.FieldValue\.delete\(\)/u);
  assert.doesNotMatch(service, /ugc_cleanup_failed/);
});

test('Firestore missing-index failures are stored with an actionable account-deletion code', () => {
  assert.equal(safeFailureCode({
    code: 9,
    message: 'FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index for collection comments and field authorId. You can create it here: create_exemption=x',
  }), 'ACCOUNT_COLLECTION_GROUP_INDEX_REQUIRED');
  assert.equal(safeFailureCode({
    code: 'failed-precondition',
    details: 'The query requires an index. You can create it here.',
  }), 'ACCOUNT_COLLECTION_GROUP_INDEX_REQUIRED');
  assert.equal(safeFailureCode({ code: 9, message: 'A different failed precondition' }), '9');
  assert.equal(safeFailureCode({ code: 'auth/internal-error' }), 'ACCOUNT_DELETION_FAILED');
});

function indexRecoveryFixture({ probeFailure = false, row = {} } = {}) {
  const probes = [];
  const writes = [];
  const jobRef = { id: 'user-1', path: 'accountDeletionJobs/user-1' };
  const current = {
    status: 'manual_review',
    attempts: 5,
    lastErrorCode: '9',
    lastFailurePhase: 'user_generated_content',
    ...row,
  };
  const db = {
    collectionGroup(collectionGroup) {
      return {
        where(fieldPath, operator, value) {
          return {
            limit(limit) {
              probes.push({ collectionGroup, fieldPath, operator, value, limit });
              return {
                async get() {
                  if (probeFailure) throw Object.assign(new Error('index building'), { code: 9 });
                  return { docs: [] };
                },
              };
            },
          };
        },
      };
    },
    collection(name) {
      assert.equal(name, 'accountDeletionJobs');
      return {
        where(fieldPath, operator, value) {
          assert.deepEqual([fieldPath, operator, value], ['status', '==', 'manual_review']);
          return {
            limit() {
              return { get: async () => ({ docs: [{ id: jobRef.id, ref: jobRef, data: () => current }] }) };
            },
          };
        },
      };
    },
    async runTransaction(callback) {
      return callback({
        get: async () => ({ exists: true, data: () => current }),
        set(target, patch, options) { writes.push({ target, patch, options }); },
      });
    },
  };
  const admin = { firestore: { FieldValue: { serverTimestamp: () => 'server-ts' } } };
  const events = [];
  const logger = { info(event, payload) { events.push({ event, payload }); } };
  return { admin, db, logger, probes, writes, events };
}

test('ready collection-group indexes requeue only the matching manual-review deletion once', async () => {
  const fixture = indexRecoveryFixture();
  const result = await requeueIndexBlockedAccountDeletions(fixture);
  assert.deepEqual(result, { indexesReady: true, examined: 1, requeued: 1 });
  assert.deepEqual(fixture.probes.map(probe => [probe.collectionGroup, probe.fieldPath]), [
    ['comments', 'authorId'],
    ['notifications', 'actorUid'],
    ['notifications', 'postId'],
  ]);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.writes[0].patch, {
    status: 'retry_pending',
    attempts: 0,
    leaseUntilMs: 0,
    indexRecoveryCount: 1,
    indexRecoveryFromCode: '9',
    indexRecoveryAt: 'server-ts',
    updatedAt: 'server-ts',
  });
  assert.equal(fixture.events[0].event, 'account.deletion_index_requeued');
});

test('index recovery fails closed while an index is building and ignores unrelated manual review', async () => {
  const building = indexRecoveryFixture({ probeFailure: true });
  assert.deepEqual(
    await requeueIndexBlockedAccountDeletions(building),
    { indexesReady: false, examined: 1, requeued: 0 },
  );
  assert.equal(building.writes.length, 0);

  const unrelated = indexRecoveryFixture({ row: { lastErrorCode: 'ACCOUNT_STORAGE_BUCKET_UNCONFIGURED' } });
  assert.deepEqual(
    await requeueIndexBlockedAccountDeletions(unrelated),
    { indexesReady: null, examined: 1, requeued: 0 },
  );
  assert.equal(unrelated.probes.length, 0);
  assert.equal(unrelated.writes.length, 0);
});

test('transform and writing persistence serialize every durable user-content write with deletion tombstones', () => {
  const transform = fs.readFileSync(path.join(__dirname, '..', 'routes', 'transform.js'), 'utf8');
  const writingJobs = fs.readFileSync(path.join(__dirname, '..', 'engine-writing-v1', 'jobStore.js'), 'utf8');
  const writingUsage = fs.readFileSync(path.join(__dirname, '..', 'engine-writing-v1', 'usage.js'), 'utf8');

  assert.match(transform, /function persistJob[\s\S]*db\.runTransaction[\s\S]*transaction\.get\(deletionRef\)[\s\S]*transaction\.get\(activityRef\)/u);
  assert.match(transform, /accountDeletionBlocksWrites[\s\S]*transaction\.set\(primaryRef[\s\S]*transaction\.set\(archiveRef/u);
  assert.match(transform, /const initialPersistence = await persistJob\(job, \{ requireClaim: true \}\)[\s\S]*jobs\.set\(id, job\)/u);
  assert.match(transform, /laneWithoutClaim\(activity, TRANSFORM_LANE, job\.id, nowMs\)/u);
  assert.doesNotMatch(transform, /compatibilityFallback:\s*true/u);

  assert.match(writingJobs, /async function begin[\s\S]*transaction\.get\(deletionRef\)[\s\S]*laneWithClaim/u);
  assert.match(writingJobs, /async function complete[\s\S]*accountDeletionBlocksWrites[\s\S]*laneWithoutClaim/u);
  assert.match(writingUsage, /writingLabGenerationCommits[\s\S]*accountDeletionJobs[\s\S]*accountDeletionBlocksWrites/u);
});
