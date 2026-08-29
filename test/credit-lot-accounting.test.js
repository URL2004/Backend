'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  allocateCreditDeduction,
  allocateProviderCancellation,
  allocateCreditRestore,
  creditHistoryDocumentId,
  normalizeTrackedLot
} = require('../lib/creditLotAccounting');

function lot(id, createdAt, paidRemaining, bonusRemaining, paidCap = paidRemaining, bonusCap = bonusRemaining) {
  return {
    id,
    createdAt,
    creditGrantPolicyVersion: 'credit-grant-base-v1',
    paidCredits: paidCap,
    eventBonusCredits: bonusCap,
    refundPaidCreditsRemaining: paidRemaining,
    refundEventBonusCreditsRemaining: bonusRemaining
  };
}

function applyLotUpdates(lots, updates) {
  const byId = new Map(updates.map(row => [row.orderId, row]));
  return lots.map(value => {
    const update = byId.get(value.id);
    return update ? {
      ...value,
      refundPaidCreditsRemaining: update.paidRemaining,
      refundEventBonusCreditsRemaining: update.bonusRemaining
    } : value;
  });
}

test('단일 맥스 lot에서 500을 사용하면 유료 기준 크레딧부터 500이 줄어든다', () => {
  const plan = allocateCreditDeduction({
    amount: 500,
    globalBalance: 2500,
    trackedBalance: 2500,
    lots: [lot('max', 1, 2000, 500)]
  });
  assert.equal(plan.complete, true);
  assert.equal(plan.untrackedCredits, 0);
  assert.equal(plan.trackedCredits, 500);
  assert.deepEqual(plan.allocations, [{
    orderId: 'max', paidCredits: 500, bonusCredits: 0, totalCredits: 500
  }]);
  assert.equal(plan.lotUpdates[0].paidRemaining, 1500);
  assert.equal(plan.lotUpdates[0].bonusRemaining, 500);
  assert.equal(plan.newTrackedBalance, 2000);
});

test('기존 미추적 크레딧 100을 먼저 사용한 뒤 tracked lot을 차감한다', () => {
  const plan = allocateCreditDeduction({
    amount: 150,
    globalBalance: 2600,
    trackedBalance: 2500,
    lots: [lot('max', 1, 2000, 500)]
  });
  assert.equal(plan.untrackedCredits, 100);
  assert.equal(plan.trackedCredits, 50);
  assert.deepEqual(plan.allocations, [{
    orderId: 'max', paidCredits: 50, bonusCredits: 0, totalCredits: 50
  }]);
  assert.equal(plan.newTrackedBalance, 2450);
});

test('A/B 다중 주문은 createdAt·id FIFO로, 각 lot 안에서 paid 후 bonus 순서로 사용한다', () => {
  const plan = allocateCreditDeduction({
    amount: 200,
    globalBalance: 435,
    trackedBalance: 435,
    // 입력 순서를 뒤집어도 시간순 FIFO여야 한다.
    lots: [lot('B', 2, 300, 30), lot('A', 1, 100, 5)]
  });
  assert.deepEqual(plan.allocations, [
    { orderId: 'A', paidCredits: 100, bonusCredits: 5, totalCredits: 105 },
    { orderId: 'B', paidCredits: 95, bonusCredits: 0, totalCredits: 95 }
  ]);
  assert.equal(plan.lotUpdates[0].paidRemaining, 0);
  assert.equal(plan.lotUpdates[0].bonusRemaining, 0);
  assert.equal(plan.lotUpdates[0].active, false);
  assert.equal(plan.lotUpdates[1].paidRemaining, 205);
  assert.equal(plan.lotUpdates[1].bonusRemaining, 30);
});

test('차감 원장의 order별 paid/bonus allocation대로 restore하면 lot과 tracked 잔액이 정확히 원복된다', () => {
  const originalLots = [lot('B', 2, 300, 30), lot('A', 1, 100, 5)];
  const deducted = allocateCreditDeduction({
    amount: 250,
    globalBalance: 535,
    trackedBalance: 435,
    lots: originalLots
  });
  assert.equal(deducted.untrackedCredits, 100);
  assert.equal(deducted.trackedCredits, 150);
  assert.equal(deducted.newTrackedBalance, 285);

  const afterDeduction = applyLotUpdates(originalLots, deducted.lotUpdates);
  const restored = allocateCreditRestore({
    amount: 250,
    untrackedCredits: deducted.untrackedCredits,
    allocations: deducted.allocations,
    trackedBalance: deducted.newTrackedBalance,
    lots: afterDeduction
  });
  assert.equal(restored.complete, true);
  assert.equal(restored.untrackedCredits, 100);
  assert.equal(restored.trackedCredits, 150);
  assert.equal(restored.newTrackedBalance, 435);
  assert.deepEqual(restored.allocations, deducted.allocations);
  assert.deepEqual(
    applyLotUpdates(afterDeduction, restored.lotUpdates)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(value => [value.id, value.refundPaidCreditsRemaining, value.refundEventBonusCreditsRemaining]),
    [['A', 100, 5], ['B', 300, 30]]
  );
});

test('동일 requestId는 항상 같은 차감·복원 원장 ID로 수렴해 멱등성을 유지한다', () => {
  assert.equal(creditHistoryDocumentId('deduct', 'same-request'), 'req_same-request');
  assert.equal(creditHistoryDocumentId('deduct', 'same-request'), 'req_same-request');
  assert.equal(creditHistoryDocumentId('restore', 'same-request'), 'restore_req_same-request');
  assert.notEqual(creditHistoryDocumentId('deduct', 'other-request'), 'req_same-request');
});

test('명시적 v1 표식과 두 remaining 숫자 필드가 모두 있는 주문만 tracked lot이다', () => {
  assert.ok(normalizeTrackedLot(lot('tracked', 1, 100, 5)));
  assert.equal(normalizeTrackedLot({
    ...lot('missing', 1, 100, 5),
    refundEventBonusCreditsRemaining: undefined
  }), null);
  assert.equal(normalizeTrackedLot({
    ...lot('legacy', 1, 100, 5),
    creditGrantPolicyVersion: 'legacy'
  }), null);
});

test('신규 주문 공급자 취소는 취소 주문의 보너스와 paid 잔여분부터 회수한다', () => {
  const plan = allocateProviderCancellation({
    targetCredits: 1500,
    accountedCredits: 0,
    globalBalance: 2500,
    trackedBalance: 2500,
    canceledOrderId: 'max',
    canceledLot: lot('max', 1, 2000, 500),
    otherLots: [],
    usesBaseCreditPolicy: true
  });

  assert.equal(plan.balanceDebit, 1500);
  assert.equal(plan.unrecoveredCredits, 0);
  assert.equal(plan.ownLotCredits, 1500);
  assert.equal(plan.untrackedCredits, 0);
  assert.deepEqual(plan.allocations, [{
    orderId: 'max',
    paidCredits: 1000,
    bonusCredits: 500,
    totalCredits: 1500,
    source: 'canceled_order'
  }]);
  assert.deepEqual(
    [plan.lotUpdates[0].paidRemaining, plan.lotUpdates[0].bonusRemaining, plan.lotUpdates[0].active],
    [1000, 0, true]
  );
  assert.equal(plan.newTrackedBalance, 1000);
});

test('신규 주문의 자기 lot이 부족하면 untracked 뒤 다른 주문 lot을 FIFO로 회수한다', () => {
  const plan = allocateProviderCancellation({
    targetCredits: 2500,
    accountedCredits: 0,
    globalBalance: 1000,
    trackedBalance: 900,
    canceledOrderId: 'max',
    canceledLot: lot('max', 1, 0, 300, 2000, 500),
    otherLots: [lot('B', 3, 300, 0), lot('A', 2, 300, 0)],
    usesBaseCreditPolicy: true
  });

  assert.equal(plan.balanceDebit, 1000);
  assert.equal(plan.ownLotCredits, 300);
  assert.equal(plan.untrackedCredits, 100);
  assert.equal(plan.otherLotCredits, 600);
  assert.equal(plan.unrecoveredCredits, 1500);
  assert.deepEqual(plan.allocations.map(row => [row.orderId, row.paidCredits, row.bonusCredits, row.source]), [
    ['max', 0, 300, 'canceled_order'],
    ['A', 300, 0, 'other_lot'],
    ['B', 300, 0, 'other_lot']
  ]);
  assert.equal(plan.newTrackedBalance, 0);
});

test('서버 환불에서 이미 예약·회수한 크레딧은 공급자 취소에서 다시 차감하지 않는다', () => {
  const plan = allocateProviderCancellation({
    targetCredits: 2000,
    accountedCredits: 2000,
    globalBalance: 500,
    trackedBalance: 500,
    canceledOrderId: 'max',
    canceledLot: lot('max', 1, 0, 500, 2000, 500),
    otherLots: [],
    usesBaseCreditPolicy: true
  });

  assert.equal(plan.balanceDebit, 0);
  assert.equal(plan.appliedCredits, 2000);
  assert.equal(plan.unrecoveredCredits, 0);
  assert.deepEqual(plan.allocations, []);
  assert.deepEqual(plan.lotUpdates, []);
  assert.equal(plan.newTrackedBalance, 500);
});

test('레거시 공급자 취소는 신규 tracked lot을 침범하지 않고 untracked 잔액만 회수한다', () => {
  const protectedOnly = allocateProviderCancellation({
    targetCredits: 110,
    accountedCredits: 0,
    globalBalance: 2500,
    trackedBalance: 2500,
    canceledOrderId: 'legacy',
    canceledLot: null,
    otherLots: [lot('new-order', 1, 2000, 500)],
    usesBaseCreditPolicy: false
  });
  assert.equal(protectedOnly.balanceDebit, 0);
  assert.equal(protectedOnly.unrecoveredCredits, 110);
  assert.equal(protectedOnly.newTrackedBalance, 2500);
  assert.deepEqual(protectedOnly.lotUpdates, []);

  const mixed = allocateProviderCancellation({
    targetCredits: 110,
    accountedCredits: 0,
    globalBalance: 2600,
    trackedBalance: 2500,
    canceledOrderId: 'legacy',
    canceledLot: null,
    otherLots: [lot('new-order', 1, 2000, 500)],
    usesBaseCreditPolicy: false
  });
  assert.equal(mixed.balanceDebit, 100);
  assert.equal(mixed.untrackedCredits, 100);
  assert.equal(mixed.unrecoveredCredits, 10);
  assert.equal(mixed.trackedCredits, 0);
  assert.equal(mixed.newTrackedBalance, 2500);
});
