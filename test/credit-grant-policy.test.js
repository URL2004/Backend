'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const paymentRouter = require('../routes/payment');
const { getCreditProduct } = require('../lib/conversionOffers');

const {
  assertPaymentIntentAllowsCreditGrant,
  paymentIntentGrant
} = paymentRouter.creditGrantPolicy;

test('new payment grants never create a first-purchase bonus', () => {
  const product = getCreditProduct(58000, {
    nowMs: Date.parse('2026-09-15T12:00:00+09:00'),
    env: { EXTRA_CREDIT_EVENT_ENABLED: '1' }
  });
  const grant = paymentIntentGrant(null, product);
  assert.equal(grant.paidCredits, 2000);
  assert.equal(grant.packageBonusCredits, 900);
  assert.equal(grant.eventBonusCredits, 100);
  assert.equal(grant.totalCredits, 3000);
  assert.equal(grant.firstPurchaseBonusCredits, 0);
  assert.equal(grant.grantPolicyVersion, 'credit-grant-base-v1');
});

test('5,900원 스타터(2026-09 정책 v4)의 새 지급은 기준 200·상시 0·이벤트 0이다', () => {
  const product = getCreditProduct(5900, {
    nowMs: Date.parse('2026-09-15T12:00:00+09:00'),
    env: { EXTRA_CREDIT_EVENT_ENABLED: '1' }
  });
  const grant = paymentIntentGrant(null, product);
  assert.equal(grant.paidCredits, 200);
  assert.equal(grant.packageBonusCredits, 0);
  assert.equal(grant.eventBonusCredits, 0);
  assert.equal(grant.eventBonusRate, 0);
  assert.equal(grant.eventId, null);
  assert.equal(grant.totalCredits, 200);
  assert.equal(grant.offerPolicyVersion, 'credit-offer-v4-202609');
  assert.equal(grant.grantPolicyVersion, 'credit-grant-base-v1');
});

test('정책 v3에서 선점한 5,900원 intent는 v4 배포 뒤에도 약속한 210크레딧을 보존한다', () => {
  const existing = {
    amount: 5900,
    paidCredits: 200,
    packageBonusCredits: 0,
    eventBonusCredits: 10,
    totalGrantedCredits: 210,
    packageBonusRate: 0,
    eventBonusRate: 5,
    eventId: 'extra-credit-2026-09',
    eventEndsAtMs: Date.parse('2026-10-01T00:00:00+09:00'),
    grantPolicyVersion: 'credit-grant-base-v1',
    offerPolicyVersion: 'credit-offer-v3-202609'
  };
  const grant = paymentIntentGrant(existing, getCreditProduct(5900, {
    nowMs: Date.parse('2026-09-15T12:00:00+09:00'),
    env: { EXTRA_CREDIT_EVENT_ENABLED: '1' }
  }));
  assert.equal(grant.paidCredits, 200);
  assert.equal(grant.eventBonusCredits, 10);
  assert.equal(grant.eventBonusRate, 5);
  assert.equal(grant.totalCredits, 210);
  assert.equal(grant.offerPolicyVersion, 'credit-offer-v3-202609');
});

test('a pre-deploy intent keeps its package grant but receives no first-purchase bonus', () => {
  const intent = { amount: 58000, baseCredits: 3300, status: 'approved_reconciliation_required' };
  assert.deepEqual(paymentIntentGrant(intent, getCreditProduct(58000)), {
    paidCredits: 3300,
    packageBonusCredits: 0,
    eventBonusCredits: 0,
    bonusCredits: 0,
    totalCredits: 3300,
    packageBonusRate: 0,
    eventBonusRate: 0,
    eventId: null,
    eventEndsAtMs: 0,
    grantPolicyVersion: 'legacy-total-grant-v1',
    offerPolicyVersion: null,
    purchaseKind: 'credit_package',
    sourceOrderId: null,
    targetAmount: 0,
    firstPurchaseBonusCredits: 0
  });
});

test('migrated event intents stay immutable while retired first-purchase amounts are removed', () => {
  const existing = {
    paidCredits: 2000,
    eventBonusCredits: 500,
    totalGrantedCredits: 2500,
    eventBonusRate: 25,
    eventId: 'extra-credit-2026-09',
    eventEndsAtMs: 1790780400000,
    grantPolicyVersion: 'credit-grant-base-v1'
  };
  const first = paymentIntentGrant(existing, getCreditProduct(58000));
  const retry = paymentIntentGrant(existing, getCreditProduct(58000));
  assert.equal(first.firstPurchaseBonusCredits, 0);
  assert.deepEqual(retry, first);

  const legacyRetry = paymentIntentGrant({
    paidCredits: 3300,
    eventBonusCredits: 0,
    firstPurchaseBonusCredits: 495,
    totalGrantedCredits: 3795,
    grantPolicyVersion: 'legacy-total-grant-v1'
  }, getCreditProduct(58000));
  assert.equal(legacyRetry.firstPurchaseBonusCredits, 0);
  assert.equal(legacyRetry.totalCredits, 3300);
  assert.equal(
    legacyRetry.paidCredits + legacyRetry.eventBonusCredits + legacyRetry.firstPurchaseBonusCredits,
    legacyRetry.totalCredits
  );
  assert.equal(
    legacyRetry.paidCredits + legacyRetry.packageBonusCredits + legacyRetry.eventBonusCredits,
    legacyRetry.totalCredits
  );
});

test('취소 격리된 payment intent는 prepare/apply 공통 guard에서 크레딧 지급을 거부한다', () => {
  for (const intent of [
    { status: 'cancellation_no_credit' },
    { status: 'cancellation_review_required' },
    { status: 'confirming', creditCancellationLocked: true }
  ]) {
    assert.throws(
      () => assertPaymentIntentAllowsCreditGrant(intent),
      error => error.code === 'PAYMENT_CANCELLATION_LOCKED' && error.status === 409
    );
  }
  assert.equal(assertPaymentIntentAllowsCreditGrant({ status: 'confirming' }), true);
  assert.equal(assertPaymentIntentAllowsCreditGrant({ status: 'applied' }), true);
});
