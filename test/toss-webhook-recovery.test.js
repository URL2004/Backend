'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const state = require('../lib/tossWebhookState');

function timestamp(ms) {
  return { toMillis: () => ms, toDate: () => new Date(ms) };
}

test('credit webhook routing accepts both legacy and current entropy order IDs', () => {
  for (const orderId of ['order_1234567890', 'order_1760000000000_a1b2c3d4']) {
    assert.equal(state.isCreditOrderId(orderId), true);
    assert.equal(state.retryLaneFor('PAYMENT_STATUS_CHANGED', orderId), 'credit_cancellation');
    assert.equal(state.retryLaneFor('CANCEL_STATUS_CHANGED', orderId), 'credit_cancellation');
  }
  for (const orderId of ['order_123', 'order_1760000000000_x', 'external_order_1760000000000']) {
    assert.equal(state.isCreditOrderId(orderId), false);
    assert.equal(state.retryLaneFor('PAYMENT_STATUS_CHANGED', orderId), 'general');
  }
});

function setPath(target, dotted, value) {
  const parts = String(dotted).split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts.at(-1)] = value;
}

function mergeRow(existing, patch) {
  const next = { ...(existing || {}) };
  for (const [key, value] of Object.entries(patch || {})) setPath(next, key, value);
  return next;
}

function fakeFirestore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  let failDelete = false;
  let autoId = 0;

  function snapshot(ref) {
    const value = rows.get(ref.path);
    return {
      id: ref.id,
      ref,
      exists: value !== undefined,
      data: () => value
    };
  }

  function refFor(collectionName, id) {
    const ref = {
      id,
      path: `${collectionName}/${id}`,
      async get() { return snapshot(ref); },
      async set(value, options = {}) {
        rows.set(ref.path, options.merge ? mergeRow(rows.get(ref.path), value) : mergeRow({}, value));
      },
      async update(value) {
        if (!rows.has(ref.path)) throw Object.assign(new Error('not found'), { code: 5 });
        rows.set(ref.path, mergeRow(rows.get(ref.path), value));
      },
      async delete() { rows.delete(ref.path); },
      collection(childName) {
        const collectionPath = `${ref.path}/${childName}`;
        return {
          doc(id = `auto_${++autoId}`) { return refFor(collectionPath, id); }
        };
      }
    };
    return ref;
  }

  function queryFor(collectionName, filters = [], limitValue = Infinity) {
    return {
      where(field, op, expected) { return queryFor(collectionName, [...filters, [field, op, expected]], limitValue); },
      limit(value) { return queryFor(collectionName, filters, value); },
      async get() {
        const docs = [];
        for (const [key, value] of rows.entries()) {
          if (!key.startsWith(`${collectionName}/`) || key.slice(collectionName.length + 1).includes('/')) continue;
          const matches = filters.every(([field, op, expected]) => {
            const actual = field.split('.').reduce((cursor, part) => cursor?.[part], value);
            if (op === '==') return actual === expected;
            if (op === 'in') return expected.includes(actual);
            throw new Error(`unsupported query op: ${op}`);
          });
          if (!matches) continue;
          docs.push(snapshot(refFor(collectionName, key.slice(collectionName.length + 1))));
          if (docs.length >= limitValue) break;
        }
        return { docs, empty: docs.length === 0, size: docs.length };
      }
    };
  }

  const db = {
    collection(name) {
      return {
        doc(id) { return refFor(name, id); },
        where(field, op, expected) { return queryFor(name, [[field, op, expected]]); },
        limit(value) { return queryFor(name, [], value); }
      };
    },
    async runTransaction(callback) {
      const transaction = {
        async get(ref) { return snapshot(ref); },
        set(ref, value, options = {}) {
          rows.set(ref.path, options.merge ? mergeRow(rows.get(ref.path), value) : mergeRow({}, value));
        },
        update(ref, value) {
          if (!rows.has(ref.path)) throw Object.assign(new Error('not found'), { code: 5 });
          rows.set(ref.path, mergeRow(rows.get(ref.path), value));
        },
        delete(ref) {
          if (failDelete) throw Object.assign(new Error('delete unavailable'), { code: 'DELETE_UNAVAILABLE' });
          rows.delete(ref.path);
        }
      };
      return callback(transaction);
    }
  };

  return {
    db,
    row(pathname) { return rows.get(pathname); },
    setFailDelete(value) { failDelete = value; },
    rows
  };
}

function loadSubscription(initial = {}, options = {}) {
  const store = fakeFirestore(initial);
  const configPath = require.resolve('../config');
  const loggerPath = require.resolve('../lib/logger');
  const outboundPath = require.resolve('../lib/outboundPolicy');
  const routePath = require.resolve('../routes/subscription');
  const prior = new Map([
    [configPath, require.cache[configPath]],
    [loggerPath, require.cache[loggerPath]],
    [outboundPath, require.cache[outboundPath]],
    [routePath, require.cache[routePath]]
  ]);
  const outboundCalls = [];
  const verifyCalls = [];
  const admin = {
    firestore: {
      Timestamp: { fromMillis: timestamp, now: () => timestamp(Date.now()) },
      FieldValue: { serverTimestamp: () => timestamp(Date.now()) }
    },
    auth: () => ({
      verifyIdToken: async (...args) => {
        verifyCalls.push(args);
        return { uid: 'test-user' };
      }
    })
  };
  require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { admin, db: store.db } };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      setLogContext() {}
    }
  };
  require.cache[outboundPath] = {
    id: outboundPath,
    filename: outboundPath,
    loaded: true,
    exports: {
      outboundFetch: async (...args) => {
        outboundCalls.push(args);
        if (typeof options.outboundFetch === 'function') return options.outboundFetch(...args);
        return { ok: true, status: 200, json: async () => ({}) };
      }
    }
  };
  delete require.cache[routePath];
  const router = require('../routes/subscription');

  function cleanup() {
    for (const [key, value] of prior.entries()) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
    // These modules capture config at load time and must not leak the fake DB.
    for (const relative of ['../lib/paymentCancellation', '../lib/accountDeletion']) {
      delete require.cache[require.resolve(relative)];
    }
  }

  return { store, internals: router.__webhookTest, outboundCalls, verifyCalls, cleanup };
}

test('provider key bounds reject oversized or padded identifiers before provider I/O', async t => {
  assert.equal(state.validProviderKey('x'.repeat(300)), true);
  assert.equal(state.validProviderKey('x'.repeat(301)), false);
  assert.equal(state.validProviderKey(' key'), false);
  const loaded = loadSubscription();
  t.after(loaded.cleanup);
  const result = await loaded.internals.verifyTossWebhookEvent('PAYMENT_STATUS_CHANGED', {
    paymentKey: 'x'.repeat(301)
  });
  assert.deepEqual(result, { ok: false, reason: 'payment_key_invalid' });
  assert.equal(loaded.outboundCalls.length, 0);
});

test('provider verification aborts a stalled Toss lookup before acknowledging the webhook', async t => {
  const previousSecret = process.env.TOSS_SECRET_KEY;
  const previousTimeout = process.env.TOSS_WEBHOOK_VERIFY_TIMEOUT_MS;
  process.env.TOSS_SECRET_KEY = 'test-secret';
  process.env.TOSS_WEBHOOK_VERIFY_TIMEOUT_MS = '1000';
  const loaded = loadSubscription({}, {
    outboundFetch: (_purpose, _url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')), { once: true });
    })
  });
  t.after(() => {
    loaded.cleanup();
    if (previousSecret === undefined) delete process.env.TOSS_SECRET_KEY;
    else process.env.TOSS_SECRET_KEY = previousSecret;
    if (previousTimeout === undefined) delete process.env.TOSS_WEBHOOK_VERIFY_TIMEOUT_MS;
    else process.env.TOSS_WEBHOOK_VERIFY_TIMEOUT_MS = previousTimeout;
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => loaded.internals.verifyTossWebhookEvent('PAYMENT_STATUS_CHANGED', { paymentKey: 'valid-payment-key' }),
    /TOSS_WEBHOOK_PAYMENT_QUERY_FAILED/u
  );
  assert.ok(Date.now() - startedAt >= 900);
  assert.equal(loaded.outboundCalls.length, 1);
  assert.equal(loaded.outboundCalls[0][2].signal.aborted, true);
});

test('receipt counters preserve the original receive time and retry budget', () => {
  const first = timestamp(1000);
  const now = timestamp(2000);
  const patch = state.receiptCounterPatch({
    receivedAt: first,
    deliveryCount: 3,
    retryAttempts: 4
  }, now, { isNew: false });
  assert.equal(patch.deliveryCount, 4);
  assert.equal(patch.firstReceivedAt, first);
  assert.equal(Object.hasOwn(patch, 'receivedAt'), false);
  assert.equal(Object.hasOwn(patch, 'retryAttempts'), false);
});

test('general webhook claim accepts received/error/expired lease but not a live lease', () => {
  const base = { eventType: 'BILLING_DELETED', orderId: null };
  assert.equal(state.isGeneralWebhookClaimable({ ...base, status: 'received' }, 10_000), true);
  assert.equal(state.isGeneralWebhookClaimable({ ...base, status: 'error' }, 10_000), true);
  assert.equal(state.isGeneralWebhookClaimable({ ...base, status: 'processing', leaseUntil: timestamp(9_999) }, 10_000), true);
  assert.equal(state.isGeneralWebhookClaimable({ ...base, status: 'processing', leaseUntil: timestamp(10_001) }, 10_000), false);
  assert.equal(state.isGeneralWebhookClaimable({ ...base, status: 'processed' }, 10_000), false);
});

test('claim lease permits one worker and completion requires the same lease token', async t => {
  const loaded = loadSubscription({
    'webhookInbox/claim-once': {
      eventType: 'BILLING_DELETED',
      status: 'received',
      retryLane: 'general',
      generalWebhookCandidate: true,
      retryAttempts: 0
    }
  });
  t.after(loaded.cleanup);
  const doc = { ref: loaded.store.db.collection('webhookInbox').doc('claim-once') };
  const first = await loaded.internals.claimGeneralWebhookDoc(doc, 10_000);
  assert.ok(first?.leaseToken);
  assert.equal(await loaded.internals.claimGeneralWebhookDoc(doc, 10_001), null);
  assert.equal(await loaded.internals.completeGeneralWebhookClaim(doc, 'wrong-token', 10_002), false);
  assert.equal(loaded.store.row('webhookInbox/claim-once').status, 'processing');
  assert.equal(await loaded.internals.completeGeneralWebhookClaim(doc, first.leaseToken, 10_003), true);
  assert.equal(loaded.store.row('webhookInbox/claim-once').status, 'processed');
});

test('a worker crash after the fifth lease is quarantined instead of looping forever', async t => {
  const loaded = loadSubscription({
    'webhookInbox/crashed-five': {
      eventType: 'BILLING_DELETED',
      status: 'processing',
      retryLane: 'general',
      generalWebhookCandidate: true,
      retryAttempts: 5,
      leaseUntil: timestamp(9_000)
    }
  });
  t.after(loaded.cleanup);
  const doc = { ref: loaded.store.db.collection('webhookInbox').doc('crashed-five') };
  const claim = await loaded.internals.claimGeneralWebhookDoc(doc, 10_000);
  assert.equal(claim.manualReview, true);
  assert.equal(loaded.store.row('webhookInbox/crashed-five').status, 'manual_review');
  assert.equal(loaded.store.row('webhookInbox/crashed-five').generalWebhookCandidate, false);
});

test('fifth claimed general attempt becomes terminal manual review on failure', () => {
  const transition = state.nextFailureState({ retryAttempts: 5 }, timestamp(5000), 'TRANSIENT');
  assert.equal(transition.retryAttempts, 5);
  assert.equal(transition.status, 'manual_review');
  assert.equal(transition.generalWebhookCandidate, false);
  assert.equal(transition.manualReviewReason, 'general_webhook_retry_exhausted');
});

test('subscription generation matching prefers exact order id and fails closed without evidence', () => {
  assert.equal(state.subscriptionGenerationMatches({
    subscription: { currentOrderId: 'sub_u_20000000000' },
    order: { cycleStartedAt: timestamp(1000) },
    orderId: 'sub_u_10000000000'
  }), false);
  assert.equal(state.subscriptionGenerationMatches({
    subscription: { currentOrderId: 'sub_u_10000000000' },
    order: {},
    orderId: 'sub_u_10000000000'
  }), true);
  assert.equal(state.subscriptionGenerationMatches({
    subscription: { cycleStartedAt: timestamp(1000) },
    order: { cycleStartedAt: timestamp(1000) },
    orderId: 'sub_legacy_10000000000'
  }), true);
  assert.equal(state.subscriptionGenerationMatches({ subscription: {}, order: {}, orderId: 'sub_unknown_10000000000' }), false);
});

test('historical subscription cancellation updates its order but cannot downgrade a newer subscription', async t => {
  const oldOrder = 'sub_user_10000000000';
  const loaded = loadSubscription({
    [`subscriptionOrders/${oldOrder}`]: { uid: 'user', cycleStartedAt: timestamp(1000), status: 'paid' },
    'users/user': { plan: 'pro', subscription: { status: 'active', currentOrderId: 'sub_user_20000000000' } }
  });
  t.after(loaded.cleanup);
  const result = await loaded.internals.processVerifiedTossWebhook({
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: { orderId: oldOrder, status: 'CANCELED' },
    paymentKeyDigest: 'digest',
    inboxId: 'event-old'
  });
  assert.equal(result.staleGeneration, true);
  assert.equal(loaded.store.row('subscriptionOrders/' + oldOrder).webhookStatus, 'CANCELED');
  assert.equal(loaded.store.row('users/user').subscription.status, 'active');
  assert.equal(loaded.store.row('users/user').plan, 'pro');
});

test('current subscription cancellation closes only the matching generation', async t => {
  const orderId = 'sub_user_10000000000';
  const loaded = loadSubscription({
    [`subscriptionOrders/${orderId}`]: { uid: 'user', cycleStartedAt: timestamp(1000), status: 'paid' },
    'users/user': { plan: 'pro', subscription: { status: 'active', currentOrderId: orderId } }
  });
  t.after(loaded.cleanup);
  const result = await loaded.internals.processVerifiedTossWebhook({
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: { orderId, status: 'CANCELED' },
    paymentKeyDigest: 'digest',
    inboxId: 'event-current'
  });
  assert.equal(result.subscriptionClosed, true);
  assert.equal(loaded.store.row('users/user').subscription.status, 'refunded');
  assert.equal(loaded.store.row('users/user').plan, 'free');
});

test('deleted old billing generation cannot remove a newly issued billing key', async t => {
  const loaded = loadSubscription({
    'billingSecrets/user': { billingKey: 'billing-new' },
    'users/user': { plan: 'pro', subscription: { status: 'active' } }
  });
  t.after(loaded.cleanup);
  const crypto = require('node:crypto');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const stale = await loaded.internals.processVerifiedTossWebhook({
    eventType: 'BILLING_DELETED',
    data: {},
    billingUid: 'user',
    billingKeyDigest: digest('billing-old'),
    inboxId: 'billing-old-event'
  });
  assert.equal(stale.staleGeneration, true);
  assert.equal(loaded.store.row('billingSecrets/user').billingKey, 'billing-new');
  assert.equal(loaded.store.row('users/user').subscription.status, 'active');
});

test('billing secret deletion failure propagates and succeeds on retry', async t => {
  const loaded = loadSubscription({
    'billingSecrets/user': { billingKey: 'billing-current' },
    'users/user': { plan: 'pro', subscription: { status: 'active' } }
  });
  t.after(loaded.cleanup);
  const crypto = require('node:crypto');
  const billingKeyDigest = crypto.createHash('sha256').update('billing-current').digest('hex');
  loaded.store.setFailDelete(true);
  await assert.rejects(() => loaded.internals.processVerifiedTossWebhook({
    eventType: 'BILLING_DELETED', data: {}, billingUid: 'user', billingKeyDigest
  }), /delete unavailable/u);
  assert.equal(loaded.store.row('users/user').subscription.status, 'active');
  loaded.store.setFailDelete(false);
  const retried = await loaded.internals.processVerifiedTossWebhook({
    eventType: 'BILLING_DELETED', data: {}, billingUid: 'user', billingKeyDigest
  });
  assert.equal(retried.billingDeleted, true);
  assert.equal(loaded.store.row('billingSecrets/user'), undefined);
  assert.equal(loaded.store.row('users/user').subscription.status, 'cancelled');
});

test('deterministic cancel log remains one document across retries', async t => {
  const loaded = loadSubscription();
  t.after(loaded.cleanup);
  const request = {
    eventType: 'CANCEL_STATUS_CHANGED',
    data: { orderId: 'external_order_1', status: 'CANCELED', cancelStatus: 'DONE' },
    paymentKeyDigest: 'digest',
    inboxId: 'stable-event-id'
  };
  await loaded.internals.processVerifiedTossWebhook(request);
  await loaded.internals.processVerifiedTossWebhook(request);
  const logPaths = [...loaded.store.rows.keys()].filter(key => key.startsWith('webhookLogs/'));
  assert.deepEqual(logPaths, ['webhookLogs/stable-event-id']);
});

test('general retry lane recovers received rows without being starved by credit rows', async t => {
  const initial = {};
  for (let index = 0; index < 120; index++) {
    initial[`webhookInbox/credit-${index}`] = {
      eventType: 'PAYMENT_STATUS_CHANGED',
      orderId: `order_${1000000000 + index}`,
      status: 'error',
      creditCancellationCandidate: true,
      generalWebhookCandidate: false
    };
  }
  initial['webhookInbox/general-one'] = {
    eventType: 'CANCEL_STATUS_CHANGED',
    orderId: 'external_order_1',
    status: 'received',
    retryLane: 'general',
    generalWebhookCandidate: true,
    providerPayment: { orderId: 'external_order_1', status: 'CANCELED' },
    paymentKeyHash: 'digest',
    retryAttempts: 0,
    receivedAt: timestamp(1000)
  };
  const loaded = loadSubscription(initial);
  t.after(loaded.cleanup);
  const result = await loaded.internals.reconcilePendingGeneralWebhookInboxes({ limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(loaded.store.row('webhookInbox/general-one').status, 'processed');
  assert.equal(loaded.store.row('webhookInbox/general-one').generalWebhookCandidate, false);
});

test('subscription cron forwards its secret only in x-cron-secret header', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'subscription.js'), 'utf8');
  assert.match(source, /'x-cron-secret': internalKey/u);
  assert.match(source, /body: JSON\.stringify\(\{ uid: doc\.id \}\)/u);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ uid: doc\.id, internalKey \}\)/u);
  assert.match(source, /currentOrderId: orderId/u);
  assert.match(source, /AbortController[\s\S]*TOSS_WEBHOOK_VERIFY_TIMEOUT_MS[\s\S]*signal: controller\.signal/u);
  assert.match(source, /res\.ok \|\| res\.status === 404/u);
  assert.match(source, /acquireExpiryClaim\(\{ uid: doc\.id \}\)[\s\S]*tossDeleteBillingKey\(row\.billingKey\)[\s\S]*finalizeExpiryClaim/u);
  assert.match(source, /reconcileChargedSubscriptionStarts\(\{ limit: 20 \}\)/u);
  assert.match(source, /\/cron\/reconcile-payments[\s\S]*'x-cron-secret': internalKey/u);
});

test('existing process-due cron invokes approved payment reconciliation without a second scheduler', async t => {
  const loaded = loadSubscription();
  t.after(loaded.cleanup);
  const result = await loaded.internals.runProcessDue('cron-key');
  const reconciliationCall = loaded.outboundCalls.find(([, url]) => url.endsWith('/cron/reconcile-payments'));
  assert.ok(reconciliationCall);
  assert.equal(reconciliationCall[2].headers['x-cron-secret'], 'cron-key');
  assert.equal(JSON.parse(reconciliationCall[2].body).limit, 25);
  assert.deepEqual(result.paymentReconciliation, {});
});

test('unknown billing-key issuance is time bounded, retries once, then enters terminal manual review', async t => {
  const base = {
    operation: 'start', uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'old-auth',
    orderId: 'sub_user_1000', claimToken: 'old-token', status: 'billing_issuing',
    billingIssueUnknownAttempts: 1, billingIssueRetryAfterMs: 2_000,
    leaseUntil: timestamp(900), updatedAt: timestamp(1_000)
  };
  const loaded = loadSubscription({
    'users/user': { plan: 'free' },
    'subscriptionOperationClaims/user': base
  });
  t.after(loaded.cleanup);
  await assert.rejects(
    () => loaded.internals.acquireSubscriptionStartClaim({
      uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'new-auth', nowMs: 1_500
    }),
    error => error?.code === 'SUBSCRIPTION_START_REVIEW_REQUIRED'
  );
  const recovered = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'new-auth', nowMs: 2_001
  });
  assert.equal(recovered.recoveredUnknownIssuance, true);
  assert.equal(recovered.row.status, 'claimed');
  assert.notEqual(recovered.row.orderId, base.orderId);

  await loaded.store.db.collection('subscriptionOperationClaims').doc('user').set({
    ...base,
    billingIssueUnknownAttempts: 2,
    billingIssueRetryAfterMs: 2_000
  });
  const manual = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'third-auth', nowMs: 2_001
  });
  assert.equal(manual.manualReview, true);
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').status, 'manual_review');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').leaseUntil, null);

  const repeated = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'fourth-auth', nowMs: 9_000
  });
  assert.equal(repeated.manualReview, true);
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').status, 'manual_review');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').orderId, base.orderId);
});

test('provider cancellation closes the exact charged renewal claim and clears its secrets', async t => {
  const loaded = loadSubscription({
    'users/user': {
      plan: 'pro',
      subscription: { status: 'active', currentOrderId: 'sub_user_2000', tier: '1000' }
    },
    'subscriptionOrders/sub_user_2000': {
      uid: 'user', tier: '1000', orderId: 'sub_user_2000', status: 'paid'
    },
    'subscriptionOperationClaims/user': {
      operation: 'renewal', uid: 'user', orderId: 'sub_user_2000', status: 'charged',
      paymentKey: 'payment-secret', billingKey: 'billing-secret', claimToken: 'renew-token'
    }
  });
  t.after(loaded.cleanup);
  const result = await loaded.internals.processVerifiedTossWebhook({
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: { orderId: 'sub_user_2000', status: 'CANCELED' },
    paymentKeyDigest: 'digest'
  });
  assert.equal(result.renewalClaimClosed, true);
  assert.equal(loaded.store.row('users/user').subscription.status, 'refunded');
  const claim = loaded.store.row('subscriptionOperationClaims/user');
  assert.equal(claim.status, 'canceled');
  assert.equal(claim.paymentKey, null);
  assert.equal(claim.billingKey, null);
});

test('subscription auth checks token revocation and every user route uses bearerToken compatibility helper', async t => {
  const loaded = loadSubscription();
  t.after(loaded.cleanup);
  assert.equal(await loaded.internals.verifyToken('firebase-token'), 'test-user');
  assert.deepEqual(loaded.verifyCalls, [['firebase-token', true]]);

  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'subscription.js'), 'utf8');
  assert.match(source, /verifyIdToken\(idToken, true\)/u);
  assert.equal((source.match(/verifyToken\(bearerToken\(req\)\)/gu) || []).length, 4);
  assert.doesNotMatch(source, /const \{ idToken[^}]*\} = req\.body/u);
});

test('first subscription uses one durable per-user claim and reclaims only after lease expiry', async t => {
  const loaded = loadSubscription({ 'users/user': { plan: 'free' } });
  t.after(loaded.cleanup);
  const first = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 1_000
  });
  assert.equal(first.row.operation, 'start');
  assert.equal(first.row.status, 'claimed');
  assert.equal(first.row.orderId, 'sub_user_1000');

  await assert.rejects(
    () => loaded.internals.acquireSubscriptionStartClaim({
      uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 1_001
    }),
    error => error?.code === 'SUBSCRIPTION_START_IN_PROGRESS'
  );
  await assert.rejects(
    () => loaded.internals.acquireSubscriptionStartClaim({
      uid: 'user', tier: '5000', customerKey: 'cust_user', authKeyHash: 'auth-b', nowMs: 999_999
    }),
    error => error?.code === 'SUBSCRIPTION_START_IN_PROGRESS'
  );

  const reclaimed = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 999_999
  });
  assert.equal(reclaimed.resumed, true);
  assert.equal(reclaimed.row.orderId, first.row.orderId);
  assert.notEqual(reclaimed.row.claimToken, first.row.claimToken);
});

test('first subscription refuses an authenticated but uninitialized account before provider work', async t => {
  const loaded = loadSubscription();
  t.after(loaded.cleanup);
  await assert.rejects(
    () => loaded.internals.acquireSubscriptionStartClaim({
      uid: 'missing-user', tier: '1000', customerKey: 'cust_missing-user', authKeyHash: 'auth-a', nowMs: 1_000
    }),
    error => error?.code === 'USER_NOT_FOUND' && error?.status === 404
  );
  assert.equal(loaded.store.row('subscriptionOperationClaims/missing-user'), undefined);
});

test('terminal first-subscription failure clears provider secrets from the claim', async t => {
  const loaded = loadSubscription({ 'users/user': { plan: 'free' } });
  t.after(loaded.cleanup);
  const acquired = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 1_000
  });
  const token = acquired.row.claimToken;
  await loaded.internals.transitionSubscriptionStartClaim({
    uid: 'user', claimToken: token, from: 'claimed', status: 'billing_issuing', nowMs: 1_001
  });
  await loaded.internals.transitionSubscriptionStartClaim({
    uid: 'user', claimToken: token, from: 'billing_issuing', status: 'billing_issued',
    fields: { billingKey: 'billing-secret', paymentKey: 'payment-secret' }, nowMs: 1_002
  });
  await loaded.internals.transitionSubscriptionStartClaim({
    uid: 'user', claimToken: token, from: 'billing_issued', status: 'failed', nowMs: 1_003
  });
  const terminal = loaded.store.row('subscriptionOperationClaims/user');
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.billingKey, null);
  assert.equal(terminal.paymentKey, null);
  assert.equal(terminal.leaseUntil, null);
});

test('cron recovers a charged first subscription after browser loss without the one-time authKey', async t => {
  const loaded = loadSubscription({
    'users/user': { plan: 'free', email: 'user@example.com' },
    'subscriptionOperationClaims/user': {
      operation: 'start', uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'digest',
      orderId: 'sub_user_1000', claimToken: 'browser-token', status: 'charged',
      billingKey: 'billing-key', paymentKey: 'payment-key', cardCompany: 'card', cardNumber: '1234',
      leaseUntil: timestamp(900), createdAt: timestamp(500), updatedAt: timestamp(900)
    }
  });
  t.after(loaded.cleanup);
  const result = await loaded.internals.reconcileChargedSubscriptionStarts({ limit: 20, nowMs: 1_000 });
  assert.deepEqual(result, { scanned: 1, recovered: 1, skipped: 0, failed: 0 });
  assert.equal(loaded.store.row('users/user').subscription.status, 'active');
  assert.equal(loaded.store.row('users/user').subscription.currentOrderId, 'sub_user_1000');
  assert.equal(loaded.store.row('subscriptionOrders/sub_user_1000').status, 'paid');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').status, 'applied');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').billingKey, null);
  assert.equal(loaded.outboundCalls.length, 0);
});

test('cron leaves a live charged-start lease to the browser worker', async t => {
  const loaded = loadSubscription({
    'users/user': { plan: 'free' },
    'subscriptionOperationClaims/user': {
      operation: 'start', uid: 'user', tier: '1000', customerKey: 'cust_user',
      orderId: 'sub_user_1000', claimToken: 'browser-token', status: 'charged',
      billingKey: 'billing-key', paymentKey: 'payment-key', leaseUntil: timestamp(1_001)
    }
  });
  t.after(loaded.cleanup);
  const result = await loaded.internals.reconcileChargedSubscriptionStarts({ limit: 20, nowMs: 1_000 });
  assert.deepEqual(result, { scanned: 1, recovered: 0, skipped: 1, failed: 0 });
  assert.equal(loaded.store.row('subscriptionOrders/sub_user_1000'), undefined);
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').claimToken, 'browser-token');
});

test('subscription claims fail closed while account deletion is active or protected', async t => {
  const loaded = loadSubscription({
    'users/user': { plan: 'free' },
    'accountDeletionJobs/user': { status: 'processing' }
  });
  t.after(loaded.cleanup);
  await assert.rejects(
    () => loaded.internals.acquireSubscriptionStartClaim({
      uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 1_000
    }),
    error => error?.code === 'ACCOUNT_DELETION_IN_PROGRESS'
  );
  await loaded.store.db.collection('accountDeletionJobs').doc('user').set({
    status: 'completed', protectUntilMs: 5_000
  });
  await assert.rejects(
    () => loaded.internals.acquireSubscriptionStartClaim({
      uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 4_999
    }),
    error => error?.code === 'ACCOUNT_DELETION_IN_PROGRESS'
  );
  const allowed = await loaded.internals.acquireSubscriptionStartClaim({
    uid: 'user', tier: '1000', customerKey: 'cust_user', authKeyHash: 'auth-a', nowMs: 5_001
  });
  assert.equal(allowed.row.operation, 'start');
});

test('renewal claim and cancellation serialize on the same user generation', async t => {
  const sub = {
    tier: '1000',
    status: 'active',
    currentOrderId: 'sub_user_1000',
    cycleStartedAt: timestamp(1_000),
    nextBillingAt: timestamp(2_000)
  };
  const loaded = loadSubscription({ 'users/user': { plan: 'pro', subscription: sub } });
  t.after(loaded.cleanup);
  const generation = loaded.internals.subscriptionGeneration(sub);
  const claim = await loaded.internals.acquireRenewalClaim({
    uid: 'user', expectedGeneration: generation, tier: '1000', orderId: 'sub_user_2000', nowMs: 2_001
  });
  assert.equal(claim.row.operation, 'renewal');
  assert.equal(claim.row.status, 'charging');
  await assert.rejects(
    () => loaded.internals.cancelCurrentSubscription('user', 2_002),
    error => error?.code === 'SUBSCRIPTION_RENEWAL_IN_PROGRESS'
  );
  assert.equal(loaded.store.row('users/user').subscription.status, 'active');
});

test('renewal failure quarantines a missing key but never downgrades a newer generation', async t => {
  const oldSub = {
    tier: '1000', status: 'active', currentOrderId: 'sub_user_1000',
    cycleStartedAt: timestamp(1_000), nextBillingAt: timestamp(2_000)
  };
  const loaded = loadSubscription({ 'users/user': { plan: 'pro', subscription: oldSub } });
  t.after(loaded.cleanup);
  const oldGeneration = loaded.internals.subscriptionGeneration(oldSub);
  const first = await loaded.internals.acquireRenewalClaim({
    uid: 'user', expectedGeneration: oldGeneration, tier: '1000', orderId: 'sub_user_2000', nowMs: 2_001
  });
  const failed = await loaded.internals.finalizeRenewalFailure({
    uid: 'user', orderId: 'sub_user_2000', claimToken: first.row.claimToken,
    expectedGeneration: oldGeneration, tier: '1000', amount: 11900, reason: 'billing_key_missing', nowMs: 2_002
  });
  assert.equal(failed.userUpdated, true);
  assert.equal(loaded.store.row('users/user').subscription.status, 'past_due');
  assert.equal(loaded.store.row('users/user').plan, 'free');
  assert.equal(loaded.store.row('subscriptionOrders/sub_user_2000').status, 'failed');

  const newer = {
    tier: '5000', status: 'active', currentOrderId: 'sub_user_3000',
    cycleStartedAt: timestamp(3_000), nextBillingAt: timestamp(4_000)
  };
  await loaded.store.db.collection('users').doc('user').set({ plan: 'pro', subscription: newer });
  await loaded.store.db.collection('subscriptionOperationClaims').doc('user').set({
    operation: 'renewal', uid: 'user', tier: '1000', orderId: 'sub_user_2000',
    generation: oldGeneration, claimToken: 'old-token', status: 'charging'
  });
  const stale = await loaded.internals.finalizeRenewalFailure({
    uid: 'user', orderId: 'sub_user_2000', claimToken: 'old-token',
    expectedGeneration: oldGeneration, tier: '1000', amount: 11900, reason: 'late_failure', nowMs: 3_100
  });
  assert.equal(stale.stale, true);
  assert.equal(loaded.store.row('users/user').subscription.currentOrderId, 'sub_user_3000');
  assert.equal(loaded.store.row('users/user').subscription.status, 'active');
});

test('expiry finalization cannot erase a re-subscribed generation or its billing secret', async t => {
  const cancelled = {
    tier: '1000', status: 'cancelled', currentOrderId: 'sub_user_1000',
    cycleStartedAt: timestamp(1_000), nextBillingAt: timestamp(2_000)
  };
  const loaded = loadSubscription({
    'users/user': { plan: 'pro', subscription: cancelled },
    'billingSecrets/user': { billingKey: 'old-billing-key' }
  });
  t.after(loaded.cleanup);
  const claim = await loaded.internals.acquireExpiryClaim({ uid: 'user', nowMs: 2_001 });
  assert.equal(claim.row.operation, 'expiry');
  assert.equal(claim.row.billingKey, 'old-billing-key');

  await loaded.store.db.collection('users').doc('user').set({
    plan: 'pro',
    subscription: {
      tier: '5000', status: 'active', currentOrderId: 'sub_user_3000',
      cycleStartedAt: timestamp(3_000), nextBillingAt: timestamp(4_000)
    }
  });
  await loaded.store.db.collection('billingSecrets').doc('user').set({ billingKey: 'new-billing-key' });
  const finalized = await loaded.internals.finalizeExpiryClaim({
    uid: 'user', claimToken: claim.row.claimToken, nowMs: 3_100
  });
  assert.equal(finalized.stale, true);
  assert.equal(loaded.store.row('users/user').subscription.currentOrderId, 'sub_user_3000');
  assert.equal(loaded.store.row('billingSecrets/user').billingKey, 'new-billing-key');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').status, 'stale');
});

test('renewal apply is atomic with generation CAS and terminal claim cleanup', async t => {
  const current = {
    tier: '1000', status: 'active', currentOrderId: 'sub_user_1000',
    startedAt: timestamp(500), cycleStartedAt: timestamp(1_000), nextBillingAt: timestamp(2_000)
  };
  const generation = {
    currentOrderId: 'sub_user_1000', tier: '1000', cycleStartedAtMs: 1_000, nextBillingAtMs: 2_000
  };
  const loaded = loadSubscription({
    'users/user': { plan: 'pro', subscription: current },
    'subscriptionOperationClaims/user': {
      operation: 'renewal', uid: 'user', tier: '1000', orderId: 'sub_user_2000',
      generation, claimToken: 'renew-token', status: 'charged',
      paymentKey: 'payment-next', billingKey: 'billing-key'
    }
  });
  t.after(loaded.cleanup);
  const result = await loaded.internals.applySubscriptionCycle({
    uid: 'user',
    tier: '1000',
    plan: { amount: 11900, usesPerCycle: 50, charLimit: 1000, name: 'basic' },
    paymentResult: { paymentKey: 'payment-next', orderId: 'sub_user_2000' },
    billingKey: 'billing-key',
    cardCompany: 'card',
    cardNumber: '1234',
    customerKey: 'cust_user',
    isFirst: false,
    renewalClaim: { claimToken: 'renew-token' },
    expectedGeneration: generation
  });
  assert.equal(result.deduped, false);
  assert.equal(loaded.store.row('users/user').subscription.currentOrderId, 'sub_user_2000');
  assert.equal(loaded.store.row('subscriptionOrders/sub_user_2000').status, 'paid');
  assert.equal(loaded.store.row('billingSecrets/user').billingKey, 'billing-key');
  assert.equal(loaded.store.row('paymentSecrets/sub_user_2000').paymentKey, 'payment-next');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').status, 'applied');
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').billingKey, null);
  assert.equal(loaded.store.row('subscriptionOperationClaims/user').paymentKey, null);
});

test('renewal apply fails closed when account deletion starts before entitlement write', async t => {
  const current = {
    tier: '1000', status: 'active', currentOrderId: 'sub_user_1000',
    cycleStartedAt: timestamp(1_000), nextBillingAt: timestamp(2_000)
  };
  const generation = {
    currentOrderId: 'sub_user_1000', tier: '1000', cycleStartedAtMs: 1_000, nextBillingAtMs: 2_000
  };
  const loaded = loadSubscription({
    'users/user': { plan: 'pro', subscription: current },
    'subscriptionOperationClaims/user': {
      operation: 'renewal', uid: 'user', tier: '1000', orderId: 'sub_user_2000',
      generation, claimToken: 'renew-token', status: 'charged',
      paymentKey: 'payment-next', billingKey: 'billing-key'
    },
    'accountDeletionJobs/user': { status: 'manual_review' }
  });
  t.after(loaded.cleanup);
  await assert.rejects(
    () => loaded.internals.applySubscriptionCycle({
      uid: 'user', tier: '1000',
      plan: { amount: 11900, usesPerCycle: 50, charLimit: 1000, name: 'basic' },
      paymentResult: { paymentKey: 'payment-next', orderId: 'sub_user_2000' },
      billingKey: 'billing-key', customerKey: 'cust_user', isFirst: false,
      renewalClaim: { claimToken: 'renew-token' }, expectedGeneration: generation
    }),
    error => error?.code === 'ACCOUNT_DELETION_IN_PROGRESS'
  );
  assert.equal(loaded.store.row('subscriptionOrders/sub_user_2000'), undefined);
  assert.equal(loaded.store.row('users/user').subscription.currentOrderId, 'sub_user_1000');
});
