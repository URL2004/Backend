'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateOrderDocs, formatByAmount, revenueEmbed, revenueField } = require('../lib/revenue');

const ORDERS = [
  { amount: 5900, status: 'paid', isFirstPurchase: true },
  { amount: 5900, status: 'paid', isFirstPurchase: false },
  { amount: 14500, status: 'refund_requested', isFirstPurchase: true },
  { amount: 14500, status: 'partially_refunded', refundedAmount: 1000 },
  { amount: 2900, status: 'refunded', refundedAmount: 2900, isFirstPurchase: true },
  { amount: 58000, status: 'failed' },
  { amount: 29000, status: 'pending' }
];

test('주문 합산은 상품(금액)별 매출·환불과 첫 구매 건수를 함께 낸다', () => {
  const out = aggregateOrderDocs(ORDERS);
  assert.equal(out.paidAmount, 5900 + 5900 + 14500 + (14500 - 1000));
  assert.equal(out.paidCount, 4);
  assert.equal(out.refundAmount, 1000 + 2900);
  assert.equal(out.refundCount, 2);
  assert.equal(out.failCount, 1);
  // 첫 구매: 결제가 유지된 주문만(전액 환불된 2,900 첫 구매는 제외)
  assert.equal(out.firstPurchaseCount, 2);
  assert.deepEqual(out.byAmount, {
    5900: { paidAmount: 11800, paidCount: 2, refundAmount: 0, refundCount: 0 },
    14500: { paidAmount: 14500 + 13500, paidCount: 2, refundAmount: 1000, refundCount: 1 },
    2900: { paidAmount: 0, paidCount: 0, refundAmount: 2900, refundCount: 1 }
  });
  assert.deepEqual(aggregateOrderDocs([]).byAmount, {});
  assert.equal(aggregateOrderDocs(null).paidCount, 0);
});

test('상품별 요약 줄은 금액 오름차순이고 건수 0인 상품은 생략한다', () => {
  const out = aggregateOrderDocs(ORDERS);
  assert.equal(formatByAmount(out.byAmount), '2,900×0(환불 1) · 5,900×2 · 14,500×2(환불 1)');
  assert.equal(formatByAmount({}), '');
  assert.equal(formatByAmount(null), '');
  assert.equal(formatByAmount({ 29000: { paidCount: 0, refundCount: 0 } }), '');
});

test('임베드·필드는 byAmount가 있을 때만 상품별 줄을 붙여 기존 픽스처와 호환된다', () => {
  const legacy = {
    label: '어제', totalPaid: 10000, totalCount: 1, refundAmount: 0, refundCount: 0,
    charge: { paidAmount: 10000, paidCount: 1 }, sub: { paidAmount: 0, paidCount: 0 }
  };
  assert.equal(revenueEmbed(legacy).fields.length, 3);
  assert.doesNotMatch(revenueField(legacy).value, /상품별/u);

  const charge = aggregateOrderDocs(ORDERS);
  const rich = {
    label: '어제', totalPaid: charge.paidAmount, totalCount: charge.paidCount,
    refundAmount: charge.refundAmount, refundCount: charge.refundCount,
    charge, sub: { paidAmount: 0, paidCount: 0 }
  };
  const embed = revenueEmbed(rich);
  const byAmountField = embed.fields.find((field) => field.name === '상품별 충전');
  assert.ok(byAmountField);
  assert.match(byAmountField.value, /5,900×2 · 14,500×2\(환불 1\) · 첫 구매 2건$/u);
  assert.match(revenueField(rich).value, /\n상품별 .* · 첫 구매 2건$/u);
});
