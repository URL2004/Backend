'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const firestoreRules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const storageRules = fs.readFileSync(path.join(root, 'storage.rules'), 'utf8');
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
const firestoreIndexes = JSON.parse(fs.readFileSync(path.join(root, 'firestore.indexes.json'), 'utf8'));
const accountDeletionService = fs.readFileSync(path.join(root, 'lib', 'accountDeletion.js'), 'utf8');

function section(start, end) {
  const startIndex = firestoreRules.indexOf(start);
  const endIndex = firestoreRules.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing rules section: ${start}`);
  assert.notEqual(endIndex, -1, `missing rules section boundary: ${end}`);
  return firestoreRules.slice(startIndex, endIndex);
}

test('firebase config deploys and emulates both Firestore and Storage rules', () => {
  assert.equal(firebaseConfig.firestore.rules, 'firestore.rules');
  assert.equal(firebaseConfig.firestore.indexes, 'firestore.indexes.json');
  assert.equal(firebaseConfig.storage.rules, 'storage.rules');
  assert.equal(firebaseConfig.emulators.firestore.port, 8080);
  assert.equal(firebaseConfig.emulators.storage.port, 9199);
});

test('account deletion collection-group queries have deployable single-field indexes', () => {
  const required = [...accountDeletionService.matchAll(
    /collectionGroup\('([^']+)'\)\s*\.where\('([^']+)',\s*'=='/gu,
  )].map(match => [match[1], match[2]]);
  assert.deepEqual(required.sort(), [
    ['comments', 'authorId'],
    ['notifications', 'actorUid'],
    ['notifications', 'postId'],
  ]);
  for (const [collectionGroup, fieldPath] of required) {
    const override = firestoreIndexes.fieldOverrides.find(row => (
      row.collectionGroup === collectionGroup && row.fieldPath === fieldPath
    ));
    assert.ok(override, `missing collection-group index: ${collectionGroup}.${fieldPath}`);
    assert.ok(override.indexes.some(index => (
      index.queryScope === 'COLLECTION_GROUP' && index.order === 'ASCENDING'
    )), `missing COLLECTION_GROUP ASC index: ${collectionGroup}.${fieldPath}`);
    for (const expected of [
      { queryScope: 'COLLECTION', order: 'ASCENDING' },
      { queryScope: 'COLLECTION', order: 'DESCENDING' },
      { queryScope: 'COLLECTION', arrayConfig: 'CONTAINS' },
    ]) {
      assert.ok(override.indexes.some(index => (
        index.queryScope === expected.queryScope
        && index.order === expected.order
        && index.arrayConfig === expected.arrayConfig
      )), `default collection index must be preserved: ${collectionGroup}.${fieldPath}`);
    }
  }
});

test('versioned index config preserves every pre-existing production index', () => {
  const compositeSignatures = firestoreIndexes.indexes.map(index => [
    index.collectionGroup,
    index.queryScope,
    index.fields.map(field => `${field.fieldPath}:${field.order || field.arrayConfig}`).join('|'),
  ].join(':'));
  assert.deepEqual(compositeSignatures.sort(), [
    'orders:COLLECTION:status:ASCENDING|createdAt:DESCENDING|__name__:DESCENDING',
    'orders:COLLECTION:uid:ASCENDING|createdAt:DESCENDING|__name__:DESCENDING',
    'users:COLLECTION:subscription.status:ASCENDING|subscription.nextBillingAt:ASCENDING|__name__:ASCENDING',
  ]);
  assert.ok(firestoreIndexes.fieldOverrides.some(row => (
    row.collectionGroup === 'analyzeRequests' && row.fieldPath === 'expiresAt' && row.ttl === true
  )));
  assert.ok(firestoreIndexes.fieldOverrides.some(row => (
    row.collectionGroup === 'creditHistory'
    && row.fieldPath === 'createdAt'
    && row.indexes.some(index => index.queryScope === 'COLLECTION_GROUP' && index.order === 'DESCENDING')
  )));
});

test('closed community has no client read or write exception', () => {
  const community = section('match /posts/{postId}', 'match /qna/{questionId}');
  assert.match(community, /allow read, write:\s*if false;/u);
  assert.match(community, /match \/comments\/\{commentId\}[\s\S]*allow read, write:\s*if false;/u);
  assert.doesNotMatch(community, /allow\s+(?:read|create|update|delete):\s*if\s+(?:true|isAdmin|signedIn)/u);
});

test('field allowlists include additions and authentication bindings stay server-only', () => {
  const helper = section('function onlyChanged(keys)', 'function validAttributionTouch');
  assert.match(helper, /affectedKeys\(\)\.hasOnly\(keys\)/u);

  const users = section('match /users/{uid}', 'match /orders/{orderId}');
  assert.match(users, /allow create:\s*if false;/u);
  assert.match(users, /onlyChanged\(\['name', 'refCode'\]\)/u);
  assert.doesNotMatch(users, /onlyChanged\([^\n]*(?:kakaoId|bookmarks)/u);
  assert.match(users, /match \/history\/\{historyId\}[\s\S]*allow create, update, delete:\s*if false;/u);
  assert.match(users, /match \/notifications\/\{notificationId\}[\s\S]*allow create:\s*if false;/u);

  const identityBindings = section('match /authIdentities/{identityId}', 'match /billingSecrets/{uid}');
  assert.match(identityBindings, /allow read, write:\s*if false;/u);
  for (const collectionName of [
    'paymentAccountClaims', 'subscriptionOperationClaims', 'subscriptionRefundClaims',
    'accountActivityClaims'
  ]) {
    assert.match(firestoreRules, new RegExp(`match /${collectionName}/\\{[^}]+\\}\\s*\\{[\\s\\S]*?allow read, write:\\s*if false;`, 'u'));
  }
  assert.match(firestoreRules, /match \/accountSecurity\/\{uid\}\s*\{[\s\S]*?allow read, write:\s*if false;/u);
});

test('Q&A mutations and durable quota counters are server-only while owner reads remain', () => {
  const qna = section('match /qna/{questionId}', 'match /notices/{noticeId}');
  assert.match(qna, /allow create:\s*if false;/u);
  assert.match(qna, /allow update, delete:\s*if false;/u);
  assert.match(qna, /allow get:\s*if isAdmin\(\) \|\| \(signedIn\(\)/u);
  assert.match(qna, /match \/clientWriteQuotas\/\{quotaId\}[\s\S]*allow read, write:\s*if false;/u);
});

test('Storage is default-deny for every client path', () => {
  assert.match(storageRules, /match \/\{allPaths=\*\*\}/u);
  assert.match(storageRules, /allow read, write:\s*if false;/u);
  assert.doesNotMatch(storageRules, /allow\s+(?:read|write):\s*if\s+(?:true|request\.auth)/u);
});
