const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');

test('config exports both Firebase token verification contracts', async () => {
  assert.equal(typeof config.verifyFirebaseIdToken, 'function');
  assert.equal(typeof config.verifyToken, 'function');

  assert.equal(await config.verifyToken(), null);
  await assert.rejects(
    config.verifyFirebaseIdToken(),
    error => error?.code === 'auth/id-token-required'
  );
});
