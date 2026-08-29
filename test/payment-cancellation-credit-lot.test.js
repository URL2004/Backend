'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fakeFirestore(initialRows) {
  const rows = new Map(Object.entries(initialRows).map(([path, value]) => [path, { ...value }]));
  const observations = { queries: [], getAllCount: 0 };
  const deferredAfterMissingRead = new Map();

  class Ref {
    constructor(path) {
      this.path = path;
      this.id = path.split('/').at(-1);
    }
    collection(name) {
      return new Collection(`${this.path}/${name}`);
    }
    async get() {
      return snapshot(this);
    }
    async update(patch) {
      if (!rows.has(this.path)) throw new Error(`missing update target: ${this.path}`);
      rows.set(this.path, applyPatch(rows.get(this.path), patch));
    }
  }

  class Collection {
    constructor(path) {
      this.path = path;
    }
    doc(id) {
      return new Ref(`${this.path}/${id}`);
    }
    where(field, operator, value) {
      return new Query(this.path, field, operator, value);
    }
  }

  class Query {
    constructor(path, field, operator, value) {
      this.path = path;
      this.field = field;
      this.operator = operator;
      this.value = value;
      this.max = Infinity;
    }
    limit(value) {
      this.max = Number(value);
      return this;
    }
    async get() {
      observations.queries.push({ path: this.path, field: this.field, value: this.value, limit: this.max });
      return querySnapshot(this);
    }
  }

  const snapshot = ref => {
    const exists = rows.has(ref.path);
    const value = exists ? rows.get(ref.path) : undefined;
    if (!exists && deferredAfterMissingRead.has(ref.path)) {
      rows.set(ref.path, { ...deferredAfterMissingRead.get(ref.path) });
      deferredAfterMissingRead.delete(ref.path);
    }
    return {
      id: ref.id,
      ref,
      exists,
      data: () => value
    };
  };
  const querySnapshot = query => ({
    docs: [...rows.entries()]
      .filter(([path, value]) => path.startsWith(`${query.path}/`)
        && path.split('/').length === query.path.split('/').length + 1
        && query.operator === '=='
        && value[query.field] === query.value)
      .slice(0, query.max)
      .map(([path]) => snapshot(new Ref(path)))
  });
  const applyPatch = (before, patch) => {
    const next = { ...(before || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && value.__delete === true) delete next[key];
      else next[key] = value;
    }
    return next;
  };

  const transaction = {
    async get(target) {
      if (target instanceof Query) {
        observations.queries.push({ path: target.path, field: target.field, value: target.value, limit: target.max });
        return querySnapshot(target);
      }
      return snapshot(target);
    },
    async getAll(...refs) {
      observations.getAllCount += 1;
      return refs.map(snapshot);
    },
    update(ref, patch) {
      if (!rows.has(ref.path)) throw new Error(`missing update target: ${ref.path}`);
      rows.set(ref.path, applyPatch(rows.get(ref.path), patch));
    },
    set(ref, value, options) {
      rows.set(ref.path, options?.merge ? applyPatch(rows.get(ref.path), value) : { ...value });
    }
  };

  return {
    db: {
      collection(name) {
        return new Collection(name);
      },
      async runTransaction(fn) {
        return fn(transaction);
      }
    },
    observations,
    row(path) {
      return rows.get(path);
    },
    paths() {
      return [...rows.keys()];
    },
    set(path, value) {
      rows.set(path, { ...value });
    },
    materializeAfterMissingRead(path, value) {
      deferredAfterMissingRead.set(path, { ...value });
    }
  };
}

function loadPaymentCancellationWith(fakeDb) {
  const configPath = require.resolve('../config');
  const modulePath = require.resolve('../lib/paymentCancellation');
  const originalConfig = require.cache[configPath];
  const originalModule = require.cache[modulePath];
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      admin: {
        firestore: {
          FieldValue: {
            serverTimestamp: () => ({ __serverTimestamp: true }),
            delete: () => ({ __delete: true })
          }
        }
      },
      db: fakeDb
    }
  };
  delete require.cache[modulePath];
  const paymentCancellation = require('../lib/paymentCancellation');
  return {
    paymentCancellation,
    restore() {
      if (originalConfig) require.cache[configPath] = originalConfig;
      else delete require.cache[configPath];
      if (originalModule) require.cache[modulePath] = originalModule;
      else delete require.cache[modulePath];
    }
  };
}

const MAX_ORDER = 'order_1234567890';

test('신규 주문 외부 부분취소는 자기 lot과 지갑·root mirror를 원자적으로 함께 회수한다', async t => {
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'u1',
      status: 'paid',
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      refundPaidCreditsRemaining: 1500,
      refundEventBonusCreditsRemaining: 500
    },
    'users/u1': { credits: 2000, creditLotV1Balance: 2000 },
    [`users/u1/creditLots/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 1500,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'PARTIAL_CANCELED',
    totalAmount: 58000,
    balanceAmount: 14500
  });

  assert.equal(result.handled, true);
  assert.equal(result.balanceDebit, 2000);
  assert.equal(result.ownLotCredits, 2000);
  assert.equal(result.unrecoveredCredits, 0);
  assert.equal(store.row('users/u1').credits, 0);
  assert.equal(store.row('users/u1').creditLotV1Balance, 0);
  assert.deepEqual([
    store.row(`users/u1/creditLots/${MAX_ORDER}`).refundPaidCreditsRemaining,
    store.row(`users/u1/creditLots/${MAX_ORDER}`).refundEventBonusCreditsRemaining,
    store.row(`users/u1/creditLots/${MAX_ORDER}`).active
  ], [0, 0, false]);
  assert.deepEqual([
    store.row(`orders/${MAX_ORDER}`).refundPaidCreditsRemaining,
    store.row(`orders/${MAX_ORDER}`).refundEventBonusCreditsRemaining,
    store.row(`orders/${MAX_ORDER}`).creditLotActive,
    store.row(`orders/${MAX_ORDER}`).refundedCredits
  ], [0, 0, false, 2000]);
  const ledgerPath = [...storePathKeys(store)].find(path => path.startsWith('systemCreditReconciliations/'));
  assert.ok(ledgerPath);
  assert.deepEqual(store.row(ledgerPath).creditLotAllocations, [{
    orderId: MAX_ORDER,
    paidCredits: 1500,
    bonusCredits: 500,
    totalCredits: 2000,
    source: 'canceled_order'
  }]);
});

test('서버 환불이 lot을 이미 선회수한 주문은 공급자 웹훅에서 이중 차감하지 않는다', async t => {
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'u2',
      status: 'refund_requested',
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      refundedCredits: 2000,
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      refundProcessing: {
        operationId: 'refund-op',
        targetRefundedAmount: 43500,
        targetRefundedCredits: 2000,
        creditsToDeduct: 2000
      }
    },
    'users/u2': { credits: 500, creditLotV1Balance: 500 },
    [`users/u2/creditLots/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      active: false
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'PARTIAL_CANCELED',
    totalAmount: 58000,
    balanceAmount: 14500
  });

  assert.equal(result.handled, true);
  assert.equal(result.balanceDebit, 0);
  assert.equal(result.accountedCredits, 2000);
  assert.equal(store.row('users/u2').credits, 500);
  assert.equal(store.row('users/u2').creditLotV1Balance, 500);
  assert.equal(store.row(`users/u2/creditLots/${MAX_ORDER}`).refundPaidCreditsRemaining, 0);
  assert.equal(store.row(`users/u2/creditLots/${MAX_ORDER}`).refundEventBonusCreditsRemaining, 0);
  assert.equal(store.row(`orders/${MAX_ORDER}`).refundProcessing, undefined);
});

test('신규 전액취소의 잔여 채무는 자기 lot→untracked→다른 lot FIFO 순서로 회수하고 모든 mirror를 맞춘다', async t => {
  const ORDER_A = 'order_2222222222';
  const ORDER_B = 'order_3333333333';
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'u-cross',
      status: 'paid',
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 300
    },
    [`orders/${ORDER_A}`]: {
      uid: 'u-cross', refundPaidCreditsRemaining: 300, refundEventBonusCreditsRemaining: 0
    },
    [`orders/${ORDER_B}`]: {
      uid: 'u-cross', refundPaidCreditsRemaining: 300, refundEventBonusCreditsRemaining: 0
    },
    'users/u-cross': { credits: 1000, creditLotV1Balance: 900 },
    [`users/u-cross/creditLots/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 300,
      active: true
    },
    [`users/u-cross/creditLots/${ORDER_B}`]: {
      orderId: ORDER_B,
      createdAt: '2026-08-29T02:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 300,
      eventBonusCreditsCap: 0,
      refundPaidCreditsRemaining: 300,
      refundEventBonusCreditsRemaining: 0,
      active: true
    },
    [`users/u-cross/creditLots/${ORDER_A}`]: {
      orderId: ORDER_A,
      createdAt: '2026-08-29T01:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 300,
      eventBonusCreditsCap: 0,
      refundPaidCreditsRemaining: 300,
      refundEventBonusCreditsRemaining: 0,
      active: true
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'CANCELED',
    totalAmount: 58000,
    balanceAmount: 0
  });

  assert.equal(result.balanceDebit, 1000);
  assert.equal(result.ownLotCredits, 300);
  assert.equal(result.untrackedCredits, 100);
  assert.equal(result.otherLotCredits, 600);
  assert.equal(result.unrecoveredCredits, 1500);
  assert.deepEqual(result.allocations.map(row => row.orderId), [MAX_ORDER, ORDER_A, ORDER_B]);
  assert.deepEqual([store.row('users/u-cross').credits, store.row('users/u-cross').creditLotV1Balance], [0, 0]);
  for (const orderId of [MAX_ORDER, ORDER_A, ORDER_B]) {
    assert.equal(store.row(`users/u-cross/creditLots/${orderId}`).active, false);
    assert.equal(store.row(`users/u-cross/creditLots/${orderId}`).refundPaidCreditsRemaining, 0);
    assert.equal(store.row(`users/u-cross/creditLots/${orderId}`).refundEventBonusCreditsRemaining, 0);
    assert.equal(store.row(`orders/${orderId}`).refundPaidCreditsRemaining, 0);
    assert.equal(store.row(`orders/${orderId}`).refundEventBonusCreditsRemaining, 0);
    assert.equal(store.row(`orders/${orderId}`).creditLotActive, false);
  }
  assert.equal(store.observations.queries.some(row => row.path === 'users/u-cross/creditLots'), true);
  assert.equal(store.observations.getAllCount, 1);
});

test('레거시 외부 취소는 untracked 잔액만 회수하고 신규 주문 lot은 그대로 둔다', async t => {
  const NEW_ORDER = 'order_9999999999';
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'legacy-user', status: 'paid', amount: 2900, safeCredits: 110
    },
    [`orders/${NEW_ORDER}`]: {
      uid: 'legacy-user',
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500
    },
    'users/legacy-user': { credits: 2600, creditLotV1Balance: 2500 },
    [`users/legacy-user/creditLots/${NEW_ORDER}`]: {
      orderId: NEW_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'CANCELED',
    totalAmount: 2900,
    balanceAmount: 0
  });

  assert.equal(result.balanceDebit, 100);
  assert.equal(result.unrecoveredCredits, 10);
  assert.equal(result.trackedCredits, 0);
  assert.equal(store.row('users/legacy-user').credits, 2500);
  assert.equal(store.row('users/legacy-user').creditLotV1Balance, 2500);
  assert.equal(store.row(`users/legacy-user/creditLots/${NEW_ORDER}`).refundPaidCreditsRemaining, 2000);
  assert.equal(store.row(`users/legacy-user/creditLots/${NEW_ORDER}`).refundEventBonusCreditsRemaining, 500);
  assert.equal(store.observations.queries.some(row => row.path.endsWith('/creditLots')), false);
});

test('tracked remaining이 선언된 신규 주문에서 자기 lot 문서가 없으면 잔액을 임의 차감하지 않는다', async t => {
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'broken-user',
      status: 'paid',
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500
    },
    'users/broken-user': { credits: 2500, creditLotV1Balance: 2500 }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  await assert.rejects(
    loaded.paymentCancellation.reconcileCreditPaymentCancellation({
      orderId: MAX_ORDER,
      status: 'CANCELED',
      totalAmount: 58000,
      balanceAmount: 0
    }),
    error => error.message === 'CREDIT_LOT_INCONSISTENT' && error.status === 503
  );
  assert.equal(store.row('users/broken-user').credits, 2500);
  assert.equal(store.row('users/broken-user').creditLotV1Balance, 2500);
});

test('추적 잔액이 전체 지갑보다 큰 손상 상태에서는 lot 일부만 줄여 불변식을 더 깨뜨리지 않는다', async t => {
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'broken-wallet',
      status: 'paid',
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500
    },
    'users/broken-wallet': { credits: 100, creditLotV1Balance: 2500 },
    [`users/broken-wallet/creditLots/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  await assert.rejects(
    loaded.paymentCancellation.reconcileCreditPaymentCancellation({
      orderId: MAX_ORDER,
      status: 'CANCELED',
      totalAmount: 58000,
      balanceAmount: 0
    }),
    error => error.message === 'CREDIT_LOT_INCONSISTENT' && error.status === 503
  );
  assert.equal(store.row('users/broken-wallet').credits, 100);
  assert.equal(store.row('users/broken-wallet').creditLotV1Balance, 2500);
  assert.equal(store.row(`users/broken-wallet/creditLots/${MAX_ORDER}`).refundPaidCreditsRemaining, 2000);
});

test('전액취소 뒤 늦게 도착한 과거 부분취소 이벤트가 주문 상태·환불액을 되돌리지 않는다', async t => {
  const store = fakeFirestore({
    [`orders/${MAX_ORDER}`]: {
      uid: 'monotonic-user',
      status: 'paid',
      amount: 58000,
      paidCredits: 2000,
      eventBonusCredits: 500,
      totalGrantedCredits: 2500,
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500
    },
    'users/monotonic-user': { credits: 2500, creditLotV1Balance: 2500 },
    [`users/monotonic-user/creditLots/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'CANCELED',
    totalAmount: 58000,
    balanceAmount: 0
  });
  const late = await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'PARTIAL_CANCELED',
    totalAmount: 58000,
    balanceAmount: 14500
  });

  assert.equal(late.stale, true);
  assert.equal(store.row(`orders/${MAX_ORDER}`).status, 'refunded');
  assert.equal(store.row(`orders/${MAX_ORDER}`).refundedAmount, 58000);
  assert.deepEqual([
    store.row('users/monotonic-user').credits,
    store.row('users/monotonic-user').creditLotV1Balance
  ], [0, 0]);
});

test('결제 승인 응답 뒤 주문 적용 전 도착한 취소 웹훅은 order_not_found를 terminal 처리하지 않는다', async t => {
  const store = fakeFirestore({});
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const reconciled = await loaded.paymentCancellation.reconcileCreditPaymentCancellation({
    orderId: MAX_ORDER,
    status: 'CANCELED',
    totalAmount: 58000,
    balanceAmount: 0
  });
  const disposition = loaded.paymentCancellation.classifyCreditCancellationResult(reconciled);

  assert.deepEqual(reconciled, { handled: false, reason: 'order_not_found' });
  assert.deepEqual(disposition, {
    terminal: false,
    inboxStatus: 'received',
    creditCancellationCandidate: true,
    reason: 'order_not_found'
  });
  assert.equal(
    loaded.paymentCancellation.classifyCreditCancellationResult({ handled: false, reason: 'no_canceled_amount' }).terminal,
    true,
    '실제 취소가 없는 DONE 이벤트만 terminal no-op으로 닫는다'
  );
});

test('manual_review로 격리한 동일 웹훅은 재전송돼도 terminal duplicate로 유지한다', async t => {
  const store = fakeFirestore({});
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  assert.equal(loaded.paymentCancellation.isTerminalWebhookInboxStatus('processed'), true);
  assert.equal(loaded.paymentCancellation.isTerminalWebhookInboxStatus('manual_review'), true);
  assert.equal(loaded.paymentCancellation.isTerminalWebhookInboxStatus('received'), false);
  assert.equal(loaded.paymentCancellation.isTerminalWebhookInboxStatus('error'), false);
  const subscriptionSource = fs.readFileSync(path.join(__dirname, '../routes/subscription.js'), 'utf8');
  assert.match(
    subscriptionSource,
    /cur\.exists\s*&&\s*isTerminalWebhookInboxStatus\(cur\.data\(\)\?\.status\)/,
    '웹훅 영속화 트랜잭션도 terminal helper를 사용해야 manual_review가 다시 열리지 않는다'
  );
});

test('cron은 order_not_found inbox를 유지하고 주문 적용 뒤 같은 취소를 다시 처리한다', async t => {
  const inboxPath = 'webhookInbox/cancel-before-order';
  const providerPayment = {
    orderId: MAX_ORDER,
    status: 'CANCELED',
    totalAmount: 58000,
    balanceAmount: 0
  };
  const store = fakeFirestore({
    [inboxPath]: {
      orderId: MAX_ORDER,
      providerPayment,
      status: 'received',
      creditCancellationCandidate: true
    },
    [`paymentIntents/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      status: 'approved_reconciliation_required'
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const first = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 25 });
  assert.equal(first.pending, 1);
  assert.equal(first.processed, 0);
  assert.equal(store.row(inboxPath).status, 'received');
  assert.equal(store.row(inboxPath).creditCancellationCandidate, true);
  assert.equal(store.row(inboxPath).reconciliationReason, 'order_not_found');
  assert.equal(store.row(inboxPath).retryAttempts, 1);

  store.set(`orders/${MAX_ORDER}`, {
    uid: 'race-user',
    status: 'paid',
    amount: 58000,
    paidCredits: 2000,
    eventBonusCredits: 500,
    totalGrantedCredits: 2500,
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    creditLotPolicyVersion: 'credit-lot-v1',
    refundPaidCreditsRemaining: 2000,
    refundEventBonusCreditsRemaining: 500
  });
  store.set('users/race-user', { credits: 2500, creditLotV1Balance: 2500 });
  store.set(`users/race-user/creditLots/${MAX_ORDER}`, {
    orderId: MAX_ORDER,
    createdAt: '2026-08-29T00:00:00+09:00',
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    creditLotPolicyVersion: 'credit-lot-v1',
    paidCreditsCap: 2000,
    eventBonusCreditsCap: 500,
    refundPaidCreditsRemaining: 2000,
    refundEventBonusCreditsRemaining: 500,
    active: true
  });

  const second = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 25 });
  assert.equal(second.processed, 1);
  assert.equal(second.pending, 0);
  assert.equal(store.row(inboxPath).status, 'processed');
  assert.equal(store.row(inboxPath).creditCancellationCandidate, false);
  assert.equal(store.row(inboxPath).reconciliationHandled, true);
  assert.deepEqual([store.row('users/race-user').credits, store.row('users/race-user').creditLotV1Balance], [0, 0]);
  assert.equal(store.row(`orders/${MAX_ORDER}`).status, 'refunded');
});

test('intent가 없는 취소 inbox는 no-credit으로 종결하고 같은 orderId의 뒤늦은 지급을 잠근다', async t => {
  const inboxPath = 'webhookInbox/no-intent-cancellation';
  const store = fakeFirestore({
    [inboxPath]: {
      orderId: MAX_ORDER,
      providerPayment: {
        orderId: MAX_ORDER,
        status: 'CANCELED',
        totalAmount: 58000,
        balanceAmount: 0
      },
      status: 'received',
      creditCancellationCandidate: true
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 25 });

  assert.equal(result.processed, 1);
  assert.equal(result.noCredit, 1);
  assert.equal(store.row(inboxPath).status, 'processed');
  assert.equal(store.row(inboxPath).creditCancellationCandidate, false);
  assert.equal(store.row(inboxPath).reconciliationReason, 'order_not_found_missing_no_credit');
  assert.equal(store.row(`paymentIntents/${MAX_ORDER}`).status, 'cancellation_no_credit');
  assert.equal(store.row(`paymentIntents/${MAX_ORDER}`).creditCancellationLocked, true);
});

test('승인 미적용 취소는 세 번째 시도에 manual-review로 격리하고 결제 지급을 잠근다', async t => {
  const inboxPath = 'webhookInbox/retry-exhausted-cancellation';
  const store = fakeFirestore({
    [inboxPath]: {
      orderId: MAX_ORDER,
      providerPayment: {
        orderId: MAX_ORDER,
        status: 'CANCELED',
        totalAmount: 58000,
        balanceAmount: 0
      },
      status: 'received',
      creditCancellationCandidate: true,
      retryAttempts: 2,
      receivedAt: new Date().toISOString()
    },
    [`paymentIntents/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      status: 'approved_reconciliation_required'
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 25 });

  assert.equal(result.manualReview, 1);
  assert.equal(result.pending, 0);
  assert.equal(store.row(inboxPath).status, 'manual_review');
  assert.equal(store.row(inboxPath).creditCancellationCandidate, false);
  assert.equal(store.row(inboxPath).retryAttempts, 3);
  assert.equal(store.row(`paymentIntents/${MAX_ORDER}`).status, 'cancellation_review_required');
  assert.equal(store.row(`paymentIntents/${MAX_ORDER}`).creditCancellationLocked, true);
  assert.equal(store.row(`paymentIntents/${MAX_ORDER}`).cancellationReviewRequired, true);
});

test('24시간 TTL이 지난 confirming 취소는 재시도 횟수가 적어도 manual-review로 격리한다', async t => {
  const inboxPath = 'webhookInbox/expired-cancellation';
  const store = fakeFirestore({
    [inboxPath]: {
      orderId: MAX_ORDER,
      providerPayment: {
        orderId: MAX_ORDER,
        status: 'CANCELED',
        totalAmount: 58000,
        balanceAmount: 0
      },
      status: 'received',
      creditCancellationCandidate: true,
      retryAttempts: 0,
      receivedAt: new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString()
    },
    [`paymentIntents/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      status: 'confirming'
    }
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 25 });

  assert.equal(result.manualReview, 1);
  assert.equal(store.row(inboxPath).status, 'manual_review');
  assert.equal(store.row(`paymentIntents/${MAX_ORDER}`).status, 'cancellation_review_required');
});

test('retryAttempts가 낮은 새 취소는 앞쪽의 오래된 영구 후보들에 굶지 않는다', async t => {
  const rows = {};
  for (let index = 0; index < 8; index += 1) {
    const orderId = `order_${7000000000 + index}`;
    rows[`webhookInbox/old-${index}`] = {
      orderId,
      providerPayment: { orderId, status: 'CANCELED', totalAmount: 58000, balanceAmount: 0 },
      status: 'received',
      creditCancellationCandidate: true,
      retryAttempts: 2,
      receivedAt: new Date(Date.now() - (60 * 60 * 1000)).toISOString()
    };
    rows[`paymentIntents/${orderId}`] = { orderId, status: 'confirming' };
  }
  const freshOrderId = 'order_8888888888';
  rows['webhookInbox/z-fresh'] = {
    orderId: freshOrderId,
    providerPayment: { orderId: freshOrderId, status: 'CANCELED', totalAmount: 58000, balanceAmount: 0 },
    status: 'received',
    creditCancellationCandidate: true,
    retryAttempts: 0,
    receivedAt: new Date().toISOString()
  };
  rows[`paymentIntents/${freshOrderId}`] = { orderId: freshOrderId, status: 'confirming' };
  const store = fakeFirestore(rows);
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 1 });

  assert.equal(result.pending, 1);
  assert.equal(store.row('webhookInbox/z-fresh').retryAttempts, 1);
  assert.equal(store.row('webhookInbox/z-fresh').creditCancellationCandidate, true);
  assert.equal(store.row('webhookInbox/old-0').retryAttempts, 2);
});

test('applied intent 직후 주문이 보이면 같은 cron 실행에서 즉시 한 번 재시도해 취소를 적용한다', async t => {
  const inboxPath = 'webhookInbox/applied-order-race';
  const store = fakeFirestore({
    [inboxPath]: {
      orderId: MAX_ORDER,
      providerPayment: {
        orderId: MAX_ORDER,
        status: 'CANCELED',
        totalAmount: 58000,
        balanceAmount: 0
      },
      status: 'received',
      creditCancellationCandidate: true
    },
    [`paymentIntents/${MAX_ORDER}`]: { orderId: MAX_ORDER, status: 'applied' },
    'users/immediate-race': { credits: 2500, creditLotV1Balance: 2500 },
    [`users/immediate-race/creditLots/${MAX_ORDER}`]: {
      orderId: MAX_ORDER,
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      creditLotPolicyVersion: 'credit-lot-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  store.materializeAfterMissingRead(`orders/${MAX_ORDER}`, {
    uid: 'immediate-race',
    status: 'paid',
    amount: 58000,
    paidCredits: 2000,
    eventBonusCredits: 500,
    totalGrantedCredits: 2500,
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    creditLotPolicyVersion: 'credit-lot-v1',
    refundPaidCreditsRemaining: 2000,
    refundEventBonusCreditsRemaining: 500
  });
  const loaded = loadPaymentCancellationWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.paymentCancellation.reconcilePendingCreditCancellationInboxes({ limit: 25 });

  assert.equal(result.processed, 1);
  assert.equal(result.manualReview, 0);
  assert.equal(store.row(inboxPath).status, 'processed');
  assert.equal(store.row(`orders/${MAX_ORDER}`).status, 'refunded');
  assert.equal(store.row('users/immediate-race').credits, 0);
});

// Keep the fake store intentionally tiny while still allowing assertions over
// deterministic reconciliation IDs that are generated inside the module.
function storePathKeys(store) {
  // row() is the public accessor; the fake exposes this test-only list lazily.
  return store.paths();
}
