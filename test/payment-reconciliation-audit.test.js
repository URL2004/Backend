'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchCreditLedgers } = require('../scripts/payment-reconciliation-audit');

test('구형 orderId 없는 충전 원장은 전역 최단거리로 배정해 다음 주문의 정확한 짝을 빼앗지 않는다', () => {
  const base = Date.parse('2026-04-01T00:00:00Z');
  const orders = [
    { id: 'order_a', uid: 'u1', safeCredits: 100, createdAt: new Date(base + 300_000) },
    { id: 'order_b', uid: 'u1', safeCredits: 100, createdAt: new Date(base + 590_000) }
  ];
  const charges = [
    { id: 'charge_old', uid: 'u1', type: 'charge', amount: 100, createdAt: new Date(base + 10_000) },
    { id: 'charge_exact', uid: 'u1', type: 'charge', amount: 100, createdAt: new Date(base + 580_000) }
  ];

  const result = matchCreditLedgers(orders, charges);
  assert.equal(result.matches.size, 2);
  assert.equal(result.matches.get('order_a').row.id, 'charge_old');
  assert.equal(result.matches.get('order_b').row.id, 'charge_exact');
  assert.equal(result.unusedCharges.length, 0);
});
