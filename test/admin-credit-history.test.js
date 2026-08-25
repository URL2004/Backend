'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const payment = require('../routes/payment');

const { creditLedgerDelta, serializeOrderDoc, splitAdminCreditHistory } = payment.adminHistoryPolicy;

test('관리자 사용자 원장은 사용 내역과 충전 내역을 중복 없이 분리한다', () => {
  const charge = { id: 'charge-1', type: 'charge', amount: 110 };
  const usage = { id: 'usage-1', type: 'humanize', used: 10 };
  const restore = { id: 'restore-1', type: 'humanize_restore', used: -10 };
  const orders = [{ id: 'order-1', kind: 'order', safeCredits: 110 }];

  const split = splitAdminCreditHistory([charge, usage, restore], orders);

  assert.deepEqual(split.creditUsageHistory, [usage, restore]);
  assert.deepEqual(split.chargeHistory, orders);
  assert.equal(split.creditUsageHistory.some(row => row.type === 'charge'), false);
});

test('신규 결제의 paymentKeyPresent와 구형 credits 필드를 관리자 충전 내역에 호환한다', () => {
  const doc = {
    id: 'legacy-order',
    data: () => ({
      uid: 'user-1',
      amount: 2900,
      credits: 110,
      paymentKeyPresent: true,
      status: 'paid'
    })
  };

  const row = serializeOrderDoc(doc, 'order');

  assert.equal(row.safeCredits, 110);
  assert.equal(row.paymentKey, 'present');
});

test('관리자 차감 원장은 실제 잔액 변화량만 감사 합계에 반영한다', () => {
  assert.equal(creditLedgerDelta({ type: 'admin_adjust', amount: -30, used: 30 }), -30);
});
