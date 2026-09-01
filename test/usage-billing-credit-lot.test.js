'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { creditLedgerDelta } = require('../lib/paymentReconciliation');
const { EVENT_RETENTION_MS, SIGNUP_CREDIT_EVENT_COLLECTION } = require('../lib/signupCreditMonitoring');

function fakeFirestore(initialRows) {
  const rows = new Map(Object.entries(initialRows).map(([path, value]) => [path, { ...value }]));
  let anonymousId = 0;
  const observations = { queryCount: 0, queries: [], getAllCount: 0 };

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
  }

  class Collection {
    constructor(path) {
      this.path = path;
    }
    doc(id) {
      return new Ref(`${this.path}/${id || `auto_${++anonymousId}`}`);
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
  }

  const snapshot = ref => ({
    id: ref.id,
    ref,
    exists: rows.has(ref.path),
    data: () => rows.get(ref.path)
  });

  const transaction = {
    async get(target) {
      if (target instanceof Query) {
        observations.queryCount += 1;
        observations.queries.push({
          path: target.path,
          field: target.field,
          operator: target.operator,
          value: target.value,
          limit: target.max
        });
        const docs = [...rows.entries()]
          .filter(([path, value]) => path.startsWith(`${target.path}/`)
            && path.split('/').length === target.path.split('/').length + 1
            && target.operator === '=='
            && value[target.field] === target.value)
          .slice(0, target.max)
          .map(([path]) => snapshot(new Ref(path)));
        return { docs };
      }
      return snapshot(target);
    },
    async getAll(...refs) {
      observations.getAllCount += 1;
      return refs.map(snapshot);
    },
    update(ref, patch) {
      rows.set(ref.path, { ...(rows.get(ref.path) || {}), ...patch });
    },
    set(ref, value) {
      rows.set(ref.path, { ...value });
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
    entries() {
      return [...rows.entries()];
    }
  };
}

function loadUsageBillingWith(fakeDb) {
  const configPath = require.resolve('../config');
  const billingPath = require.resolve('../lib/usageBilling');
  const originalConfig = require.cache[configPath];
  const originalBilling = require.cache[billingPath];
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      admin: {
        auth: () => ({ verifyIdToken: async () => ({ uid: 'unused' }) }),
        firestore: {
          FieldValue: {
            serverTimestamp: () => ({ serverTimestamp: true }),
            increment: value => ({ increment: value })
          }
        }
      },
      db: fakeDb
    }
  };
  delete require.cache[billingPath];
  const billing = require('../lib/usageBilling');
  return {
    billing,
    restore() {
      if (originalConfig) require.cache[configPath] = originalConfig;
      else delete require.cache[configPath];
      if (originalBilling) require.cache[billingPath] = originalBilling;
      else delete require.cache[billingPath];
    }
  };
}

test('detect 차감 원장은 operation·cost·text fingerprint에 결합되고 동일 payload만 replay한다', async t => {
  const store = fakeFirestore({
    'users/detect-bound': { credits: 10, creditLotV1Balance: 0, plan: 'free' }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);
  const input = { opType: 'detect', needed: 3, text: '같은 감지 입력 원문' };
  const fingerprint = loaded.billing.creditRequestPayloadFingerprint(input);
  const otherFingerprint = loaded.billing.creditRequestPayloadFingerprint({ ...input, text: '다른 감지 입력 원문' });
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.notEqual(fingerprint, otherFingerprint);

  const before = await loaded.billing.precheckCreditDeductIdempotency(
    'detect-bound', 3, 'detect', 'detect-bound-request', fingerprint
  );
  assert.deepEqual(before, { state: 'NEW', remainingCredits: 10 });

  const first = await loaded.billing.commitCreditDeduct(
    'detect-bound', 3, 'detect', 'detect-bound-request', { requestPayloadFingerprint: fingerprint }
  );
  assert.equal(first.next, 7);
  const ledger = store.row('users/detect-bound/creditHistory/req_detect-bound-request');
  assert.equal(ledger.type, 'detect');
  assert.equal(ledger.used, 3);
  assert.equal(ledger.requestPayloadFingerprintVersion, 'credit-request-v1');
  assert.equal(ledger.requestPayloadFingerprint, fingerprint);

  const replay = await loaded.billing.precheckCreditDeductIdempotency(
    'detect-bound', 3, 'detect', 'detect-bound-request', fingerprint
  );
  assert.deepEqual(replay, { state: 'DUPLICATE', remainingCredits: 7, chargedCredits: 3 });
  const duplicateCommit = await loaded.billing.commitCreditDeduct(
    'detect-bound', 3, 'detect', 'detect-bound-request', { requestPayloadFingerprint: fingerprint }
  );
  assert.deepEqual(duplicateCommit, { duplicate: true, current: 7, next: 7 });
  assert.equal(store.row('users/detect-bound').credits, 7);

  await assert.rejects(
    loaded.billing.precheckCreditDeductIdempotency(
      'detect-bound', 3, 'detect', 'detect-bound-request', otherFingerprint
    ),
    error => error?.code === 'IDEMPOTENCY_KEY_REUSED' && error?.status === 409
  );
  await assert.rejects(
    loaded.billing.commitCreditDeduct(
      'detect-bound', 3, 'detect', 'detect-bound-request', { requestPayloadFingerprint: otherFingerprint }
    ),
    error => error?.code === 'IDEMPOTENCY_KEY_REUSED' && error?.status === 409
  );
  assert.equal(store.row('users/detect-bound').credits, 7, 'payload mismatch는 잔액을 바꾸면 안 된다');
  assert.equal(store.row('users/detect-bound/creditHistory/req_detect-bound-request').requestPayloadFingerprint, fingerprint);
});

test('usageBilling은 order lot 차감·복원을 원장에 남기고 동일 requestId를 중복 적용하지 않는다', async t => {
  const store = fakeFirestore({
    'users/u1': { credits: 2500, creditLotV1Balance: 2500, plan: 'free' },
    'orders/order_max': {
      uid: 'u1',
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500
    },
    'users/u1/creditLots/order_max': {
      orderId: 'order_max',
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 2000,
      eventBonusCreditsCap: 500,
      refundPaidCreditsRemaining: 2000,
      refundEventBonusCreditsRemaining: 500,
      active: true
    }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  await loaded.billing.commitCreditDeduct('u1', 500, 'humanize', 'job-1');
  assert.equal(store.row('users/u1').credits, 2000);
  assert.equal(store.row('users/u1').creditLotV1Balance, 2000);
  assert.equal(store.row('users/u1/creditLots/order_max').refundPaidCreditsRemaining, 1500);
  assert.equal(store.row('users/u1/creditLots/order_max').refundEventBonusCreditsRemaining, 500);
  assert.equal(store.row('orders/order_max').refundPaidCreditsRemaining, 1500);
  assert.equal(store.row('orders/order_max').refundEventBonusCreditsRemaining, 500);
  assert.deepEqual(store.row('users/u1/creditHistory/req_job-1').creditLotAllocations, [{
    orderId: 'order_max', paidCredits: 500, bonusCredits: 0, totalCredits: 500
  }]);
  assert.deepEqual(store.observations.queries[0], {
    path: 'users/u1/creditLots', field: 'active', operator: '==', value: true, limit: Infinity
  });

  await loaded.billing.commitCreditDeduct('u1', 500, 'humanize', 'job-1');
  assert.equal(store.row('users/u1').credits, 2000, '동일 차감 요청은 무시된다');
  assert.equal(store.observations.queryCount, 1, '중복 확인 후에는 lot query도 실행하지 않는다');

  await loaded.billing.commitCreditRestore('u1', 500, 'humanize', 'job-1');
  assert.equal(store.row('users/u1').credits, 2500);
  assert.equal(store.row('users/u1').creditLotV1Balance, 2500);
  assert.equal(store.row('users/u1/creditLots/order_max').refundPaidCreditsRemaining, 2000);
  assert.equal(store.row('users/u1/creditLots/order_max').refundEventBonusCreditsRemaining, 500);
  assert.equal(store.row('orders/order_max').refundPaidCreditsRemaining, 2000);
  assert.equal(store.row('orders/order_max').refundEventBonusCreditsRemaining, 500);
  assert.deepEqual(store.row('users/u1/creditHistory/restore_req_job-1').creditLotAllocations, [{
    orderId: 'order_max', paidCredits: 500, bonusCredits: 0, totalCredits: 500
  }]);

  await loaded.billing.commitCreditRestore('u1', 500, 'humanize', 'job-1');
  assert.equal(store.row('users/u1').credits, 2500, '동일 복원 요청도 무시된다');
  assert.equal(store.observations.queryCount, 1, 'restore는 active query를 사용하지 않는다');
  assert.equal(store.observations.getAllCount, 1, '중복 복원은 lot 직접 조회를 추가하지 않는다');
});

test('전부 사용해 active=false가 된 lot도 차감 원장의 orderId로 직접 읽어 복원한다', async t => {
  const store = fakeFirestore({
    'users/u2': { credits: 105, creditLotV1Balance: 105, plan: 'free' },
    'orders/order_starter': {
      uid: 'u2',
      refundPaidCreditsRemaining: 100,
      refundEventBonusCreditsRemaining: 5
    },
    'users/u2/creditLots/order_starter': {
      orderId: 'order_starter',
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 100,
      eventBonusCreditsCap: 5,
      refundPaidCreditsRemaining: 100,
      refundEventBonusCreditsRemaining: 5,
      active: true
    }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  await loaded.billing.commitCreditDeduct('u2', 105, 'humanize', 'all-used');
  assert.equal(store.row('users/u2/creditLots/order_starter').active, false);
  assert.equal(store.row('users/u2').creditLotV1Balance, 0);

  await loaded.billing.commitCreditRestore('u2', 105, 'humanize', 'all-used');
  assert.equal(store.row('users/u2/creditLots/order_starter').active, true);
  assert.equal(store.row('users/u2/creditLots/order_starter').refundPaidCreditsRemaining, 100);
  assert.equal(store.row('users/u2/creditLots/order_starter').refundEventBonusCreditsRemaining, 5);
  assert.equal(store.row('orders/order_starter').refundPaidCreditsRemaining, 100);
  assert.equal(store.row('orders/order_starter').refundEventBonusCreditsRemaining, 5);
  assert.equal(store.row('users/u2').creditLotV1Balance, 105);
  assert.equal(store.observations.queryCount, 1);
  assert.equal(store.observations.getAllCount, 1);
});

test('creditLotV1Balance가 0인 기존 사용자는 orders query 없이 기존 차감·복원 흐름을 유지한다', async t => {
  const store = fakeFirestore({
    'users/legacy': { credits: 100, plan: 'free' }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  await loaded.billing.commitCreditDeduct('legacy', 10, 'humanize', 'legacy-job');
  assert.equal(store.row('users/legacy').credits, 90);
  assert.equal(store.observations.queryCount, 0);
  assert.equal(store.row('users/legacy/creditHistory/req_legacy-job').creditLotUntrackedUsed, 10);

  await loaded.billing.commitCreditRestore('legacy', 10, 'humanize', 'legacy-job');
  assert.equal(store.row('users/legacy').credits, 100);
  assert.equal(store.observations.queryCount, 0);
  assert.equal(store.row('users/legacy/creditHistory/restore_req_legacy-job').creditLotUntrackedRestored, 10);
});

test('가입 무료분은 untracked 범위에서만 먼저 소진되고 원 차감 allocation만 멱등 복구한다', async t => {
  const store = fakeFirestore({
    'users/signup-user': {
      credits: 105,
      creditLotV1Balance: 100,
      plan: 'free',
      signupCreditGrant: {
        schemaVersion: 1,
        grantCredits: 25,
        remainingCredits: 5,
        netUsedCredits: 20,
        spendEventCount: 2,
        restoreEventCount: 0,
        grantedAtMs: 1,
        lastEventAtMs: 1,
        source: 'account_initialize_v1'
      }
    },
    'orders/order_paid': {
      refundPaidCreditsRemaining: 100,
      refundEventBonusCreditsRemaining: 0,
      creditLotActive: true
    },
    'users/signup-user/creditLots/order_paid': {
      orderId: 'order_paid',
      createdAt: '2026-08-30T00:00:00.000Z',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 100,
      eventBonusCreditsCap: 0,
      refundPaidCreditsRemaining: 100,
      refundEventBonusCreditsRemaining: 0,
      active: true
    }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  const deducted = await loaded.billing.commitCreditDeduct('signup-user', 10, 'humanize', 'signup-mixed', {
    mode: 'basic',
    textLength: 500
  });
  assert.equal(deducted.signupGrantCreditsUsed, 5);
  assert.equal(store.row('users/signup-user').credits, 95);
  assert.equal(store.row('users/signup-user').creditLotV1Balance, 95, '나머지 5만 기존 lot 정책으로 차감한다');
  assert.equal(store.row('users/signup-user').signupCreditGrant.remainingCredits, 0);
  const deductHistory = store.row('users/signup-user/creditHistory/req_signup-mixed');
  assert.equal(deductHistory.creditLotUntrackedUsed, 5);
  assert.equal(deductHistory.creditLotTrackedUsed, 5);
  assert.equal(deductHistory.signupGrantCreditsUsed, 5);

  await loaded.billing.commitCreditDeduct('signup-user', 10, 'humanize', 'signup-mixed', { mode: 'basic' });
  let measurementRows = store.entries().filter(([path]) => path.startsWith(`${SIGNUP_CREDIT_EVENT_COLLECTION}/`));
  assert.equal(measurementRows.length, 1, '중복 차감은 측정 이벤트도 중복 생성하지 않는다');
  assert.equal(measurementRows[0][1].creditAmount, 5);
  assert.match(measurementRows[0][1].accountKey, /^account_v1_[a-f0-9]{32}$/u);
  assert.ok(measurementRows[0][1].expireAt instanceof Date);
  assert.equal(measurementRows[0][1].expireAt.getTime() - measurementRows[0][1].occurredAtMs, EVENT_RETENTION_MS);
  assert.equal(measurementRows[0][1].uid, undefined);
  assert.equal(measurementRows[0][1].requestId, undefined);
  assert.equal(measurementRows[0][1].textLength, undefined);
  assert.doesNotMatch(JSON.stringify(measurementRows[0][1]), /signup-user|signup-mixed/u);

  const restored = await loaded.billing.commitCreditRestore('signup-user', 10, 'humanize', 'signup-mixed');
  assert.equal(restored.signupGrantCreditsRestored, 5);
  assert.equal(store.row('users/signup-user').credits, 105);
  assert.equal(store.row('users/signup-user').creditLotV1Balance, 100, 'tracked 5도 원 allocation대로 복구한다');
  assert.equal(store.row('users/signup-user').signupCreditGrant.remainingCredits, 5);
  assert.equal(store.row('users/signup-user/creditHistory/req_signup-mixed').signupGrantCreditsRestored, 5);
  assert.equal(store.row('users/signup-user/creditHistory/restore_req_signup-mixed').signupGrantCreditsRestored, 5);

  await loaded.billing.commitCreditRestore('signup-user', 10, 'humanize', 'signup-mixed');
  measurementRows = store.entries().filter(([path]) => path.startsWith(`${SIGNUP_CREDIT_EVENT_COLLECTION}/`));
  assert.equal(measurementRows.length, 2, '중복 복구도 restore 측정 이벤트를 늘리지 않는다');
  assert.deepEqual(new Set(measurementRows.map(([, row]) => row.eventType)), new Set(['spend', 'restore']));
});

test('관리자 음수 조정은 unlimited 사용자도 lot 회계를 지키고 응답·감사 메타를 반환한다', async t => {
  const store = fakeFirestore({
    'users/admin-target': { credits: 105, creditLotV1Balance: 105, plan: 'unlimited' },
    'orders/order_admin': {
      refundPaidCreditsRemaining: 100,
      refundEventBonusCreditsRemaining: 5,
      creditLotActive: true
    },
    'users/admin-target/creditLots/order_admin': {
      orderId: 'order_admin',
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 100,
      eventBonusCreditsCap: 5,
      refundPaidCreditsRemaining: 100,
      refundEventBonusCreditsRemaining: 5,
      active: true
    }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.billing.commitCreditDeduct(
    'admin-target', 10, 'admin_adjust', null,
    { respectUnlimited: false, adminUid: 'admin-1', detail: '오지급 정정' }
  );
  assert.deepEqual([result.current, result.next], [105, 95]);
  assert.equal(store.row('users/admin-target').creditLotV1Balance, 95);
  assert.equal(store.row('orders/order_admin').refundPaidCreditsRemaining, 90);
  const adminHistory = store.entries()
    .map(([, value]) => value)
    .find(value => value.type === 'admin_adjust');
  assert.equal(adminHistory.adminUid, 'admin-1');
  assert.equal(adminHistory.detail, '오지급 정정');
  assert.equal(adminHistory.amount, 0);
  assert.equal(adminHistory.used, 10);
  assert.equal(creditLedgerDelta(adminHistory), -10, '실제 lot-aware 관리자 원장은 감사 합계에서 한 번 차감된다');
});

test('관리자 orphan 복원은 원 차감 allocation대로 inactive lot과 추적 잔액을 원복하고 원장을 함께 닫는다', async t => {
  const store = fakeFirestore({
    'users/orphan': { credits: 0, creditLotV1Balance: 0, plan: 'free' },
    'orders/order_orphan': {
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      creditLotActive: false
    },
    'users/orphan/creditLots/order_orphan': {
      orderId: 'order_orphan',
      createdAt: '2026-08-29T00:00:00+09:00',
      creditGrantPolicyVersion: 'credit-grant-base-v1',
      paidCreditsCap: 100,
      eventBonusCreditsCap: 5,
      refundPaidCreditsRemaining: 0,
      refundEventBonusCreditsRemaining: 0,
      active: false
    },
    'users/orphan/creditHistory/debit-1': {
      type: 'humanize',
      used: 105,
      creditLotUntrackedUsed: 0,
      creditLotAllocations: [{ orderId: 'order_orphan', paidCredits: 100, bonusCredits: 5 }]
    }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.billing.commitCreditRestoreFromHistory(
    'orphan', 105, 'humanize', 'debit-1', 'orphan_restore_debit-1',
    { orphanDebitResolved: true, requireUnresolved: true, adminUid: 'admin-1', detail: '결과 미저장 환급' }
  );
  assert.equal(result.restoredCredits, 105);
  assert.deepEqual([store.row('users/orphan').credits, store.row('users/orphan').creditLotV1Balance], [105, 105]);
  assert.equal(store.row('users/orphan/creditLots/order_orphan').active, true);
  assert.equal(store.row('orders/order_orphan').creditLotActive, true);
  assert.equal(store.row('users/orphan/creditHistory/debit-1').orphanDebitResolved, true);
  assert.equal(store.row('users/orphan/creditHistory/orphan_restore_debit-1').adminUid, 'admin-1');
});

test('orphan mark가 먼저 끝난 경합에서는 뒤늦은 restore가 크레딧을 되살리지 않는다', async t => {
  const store = fakeFirestore({
    'users/orphan-race': { credits: 0, plan: 'free' },
    'users/orphan-race/creditHistory/debit-race': {
      type: 'humanize',
      used: 10,
      orphanDebitResolved: true,
      orphanDebitResolution: 'manual_handled',
      resolvedAt: '2026-08-29T00:00:00+09:00'
    }
  });
  const loaded = loadUsageBillingWith(store.db);
  t.after(loaded.restore);

  const result = await loaded.billing.commitCreditRestoreFromHistory(
    'orphan-race', 10, 'humanize', 'debit-race', 'orphan_restore_debit-race',
    { orphanDebitResolved: true, requireUnresolved: true }
  );
  assert.equal(result.alreadyHandled, true);
  assert.equal(store.row('users/orphan-race').credits, 0);
  assert.equal(store.row('users/orphan-race/creditHistory/orphan_restore_debit-race'), undefined);
});
