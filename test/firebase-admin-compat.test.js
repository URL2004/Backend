'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');

test('firebase-admin 14.1 Firestore·Auth API 호환성', async () => {
  const admin = require('../lib/firebaseAdminCompat');
  assert.equal(packageJson.dependencies['firebase-admin'], '14.1.0');
  const name = `compat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = admin.initializeApp({ projectId: 'demo-humanize-v2' }, name);
  try {
    const firestore = admin.firestore(app);
    const auth = admin.auth(app);
    assert.equal(typeof firestore.collection, 'function');
    assert.equal(typeof firestore.batch, 'function');
    assert.equal(typeof admin.firestore.FieldValue.serverTimestamp, 'function');
    assert.equal(typeof admin.firestore.FieldValue.increment, 'function');
    assert.equal(typeof auth.verifyIdToken, 'function');
    assert.equal(typeof auth.getUser, 'function');
  } finally {
    await app.delete();
  }
});
