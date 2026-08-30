'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('administrator verification is centralized and always checks revocation', () => {
  const config = source('config.js');
  assert.match(config, /async function verifyAdminToken\(idToken\)/);
  assert.match(config, /verifyFirebaseIdToken\(idToken,\s*\{\s*checkRevoked:\s*true\s*\}\)/);
  assert.match(config, /ADMIN_UIDS\.includes\(decoded\.uid\)/);
  assert.match(config, /\? decoded\.uid : false/);
});

test('high-impact admin routes use the revocation-aware verifier', () => {
  for (const relative of ['routes/coupon.js', 'routes/payment.js', 'routes/opsLogs.js']) {
    const body = source(relative);
    assert.match(body, /verifyAdminToken\(idToken\)/, relative);
    assert.doesNotMatch(body, /ADMIN_UIDS\.includes\(adminUid\)/, relative);
  }
  assert.match(source('routes/transform.js'), /adminLabUid\s*=\s*await verifyAdminToken\(idToken\)/);
  assert.match(source('routes/writinglab.js'), /adminAccess\s*=\s*\(await verifyAdminToken\(idToken\)\)\s*===\s*uid/);
});

test('coupon and payment credentials prefer Authorization bearer tokens', () => {
  const coupon = source('routes/coupon.js');
  const payment = source('routes/payment.js');
  for (const body of [coupon, payment]) {
    assert.match(body, /require\('\.\.\/lib\/reqtoken'\)/u);
    assert.match(body, /const idToken = bearerToken\(req\)/u);
  }
  assert.doesNotMatch(coupon, /const \{ idToken, (?:credits|limit|batchId)/u);
  assert.doesNotMatch(payment, /const \{ orderId, idToken, (?:kind|rejectReason)/u);
});

test('client event credentials prefer Authorization bearer tokens', () => {
  const events = source('routes/events.js');
  assert.match(events, /require\('\.\.\/lib\/reqtoken'\)/u);
  assert.match(events, /const idToken = bearerToken\(req\)/u);
  assert.doesNotMatch(events, /const \{ idToken, type \} = req\.body/u);
});

test('operations admin credentials use the shared bearer compatibility helper', () => {
  const ops = source('routes/opsLogs.js');
  assert.match(ops, /require\('\.\.\/lib\/reqtoken'\)/u);
  assert.match(ops, /const idToken = bearerToken\(req\)/u);
  assert.doesNotMatch(ops, /req\.body\s*&&\s*req\.body\.idToken/u);
});

test('payment mutation tokens are checked for revocation', () => {
  const payment = source('routes/payment.js');
  assert.match(payment, /verifyFirebaseIdToken\(idToken, \{ checkRevoked: true \}\)/u);
  assert.match(payment, /verifyToken\(idToken, \{ checkRevoked: true \}\)/u);
});
