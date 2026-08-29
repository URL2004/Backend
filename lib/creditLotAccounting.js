'use strict';

const CREDIT_LOT_POLICY_VERSION = 'credit-lot-v1';
const CREDIT_GRANT_POLICY_VERSION = 'credit-grant-base-v1';

function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return whole(value.toMillis());
  if (typeof value.toDate === 'function') return whole(value.toDate().getTime());
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function hasNumericLotBalances(value) {
  return typeof value?.refundPaidCreditsRemaining === 'number'
    && Number.isFinite(value.refundPaidCreditsRemaining)
    && value.refundPaidCreditsRemaining >= 0
    && typeof value?.refundEventBonusCreditsRemaining === 'number'
    && Number.isFinite(value.refundEventBonusCreditsRemaining)
    && value.refundEventBonusCreditsRemaining >= 0;
}

function normalizeTrackedLot(value) {
  if (!value || String(value.creditGrantPolicyVersion || '') !== CREDIT_GRANT_POLICY_VERSION) return null;
  if (!hasNumericLotBalances(value)) return null;
  const paidRemaining = whole(value.refundPaidCreditsRemaining);
  const bonusRemaining = whole(value.refundEventBonusCreditsRemaining);
  const paidCap = Math.max(
    paidRemaining,
    whole(value.paidCreditsCap ?? value.paidCredits ?? value.baseCredits)
  );
  const bonusCap = Math.max(
    bonusRemaining,
    whole(value.bonusCreditsCap ?? value.eventBonusCreditsCap ?? value.bonusCredits
      ?? value.eventBonusCredits ?? value.promotionalBonusCredits)
  );
  return {
    id: String(value.id || value.orderId || ''),
    ref: value.ref || null,
    createdAtMs: timestampMs(value.createdAt || value.approvedAt),
    paidRemaining,
    bonusRemaining,
    paidCap,
    bonusCap
  };
}

function sortTrackedLots(values) {
  return (Array.isArray(values) ? values : [])
    .map(normalizeTrackedLot)
    .filter(Boolean)
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

function allocateCreditDeduction({ amount, globalBalance, trackedBalance, lots }) {
  const requested = whole(amount);
  const global = whole(globalBalance);
  const tracked = Math.min(global, whole(trackedBalance));
  const untrackedAvailable = Math.max(0, global - tracked);
  const untrackedCredits = Math.min(requested, untrackedAvailable);
  let remaining = Math.max(0, requested - untrackedCredits);
  const allocations = [];
  const lotUpdates = [];

  for (const lot of sortTrackedLots(lots)) {
    if (remaining <= 0) break;
    const paidCredits = Math.min(remaining, lot.paidRemaining);
    remaining -= paidCredits;
    const bonusCredits = Math.min(remaining, lot.bonusRemaining);
    remaining -= bonusCredits;
    if (paidCredits + bonusCredits <= 0) continue;
    allocations.push({
      orderId: lot.id,
      paidCredits,
      bonusCredits,
      totalCredits: paidCredits + bonusCredits
    });
    lotUpdates.push({
      orderId: lot.id,
      ref: lot.ref,
      paidRemaining: lot.paidRemaining - paidCredits,
      bonusRemaining: lot.bonusRemaining - bonusCredits,
      active: lot.paidRemaining - paidCredits + lot.bonusRemaining - bonusCredits > 0
    });
  }

  const trackedCredits = allocations.reduce((sum, row) => sum + row.totalCredits, 0);
  return {
    complete: remaining === 0,
    requestedCredits: requested,
    untrackedCredits,
    trackedCredits,
    unallocatedCredits: remaining,
    allocations,
    lotUpdates,
    newTrackedBalance: Math.max(0, tracked - trackedCredits)
  };
}

function normalizeHistoryAllocations(value) {
  return (Array.isArray(value) ? value : []).map(row => ({
    orderId: String(row?.orderId || ''),
    paidCredits: whole(row?.paidCredits),
    bonusCredits: whole(row?.bonusCredits)
  })).filter(row => row.orderId && row.paidCredits + row.bonusCredits > 0);
}

function allocateCreditRestore({ amount, untrackedCredits, allocations, trackedBalance, lots }) {
  const requested = whole(amount);
  const untrackedRestored = Math.min(requested, whole(untrackedCredits));
  let remaining = Math.max(0, requested - untrackedRestored);
  const byId = new Map(sortTrackedLots(lots).map(lot => [lot.id, lot]));
  const restoredAllocations = [];
  const lotUpdates = [];

  for (const allocation of normalizeHistoryAllocations(allocations)) {
    if (remaining <= 0) break;
    const lot = byId.get(allocation.orderId);
    if (!lot) continue;
    const paidCredits = Math.min(
      remaining,
      allocation.paidCredits,
      Math.max(0, lot.paidCap - lot.paidRemaining)
    );
    remaining -= paidCredits;
    const bonusCredits = Math.min(
      remaining,
      allocation.bonusCredits,
      Math.max(0, lot.bonusCap - lot.bonusRemaining)
    );
    remaining -= bonusCredits;
    if (paidCredits + bonusCredits <= 0) continue;
    restoredAllocations.push({
      orderId: lot.id,
      paidCredits,
      bonusCredits,
      totalCredits: paidCredits + bonusCredits
    });
    lotUpdates.push({
      orderId: lot.id,
      ref: lot.ref,
      paidRemaining: lot.paidRemaining + paidCredits,
      bonusRemaining: lot.bonusRemaining + bonusCredits,
      active: lot.paidRemaining + paidCredits + lot.bonusRemaining + bonusCredits > 0
    });
  }

  const trackedCredits = restoredAllocations.reduce((sum, row) => sum + row.totalCredits, 0);
  return {
    complete: remaining === 0,
    requestedCredits: requested,
    untrackedCredits: untrackedRestored,
    trackedCredits,
    unallocatedCredits: remaining,
    allocations: restoredAllocations,
    lotUpdates,
    newTrackedBalance: whole(trackedBalance) + trackedCredits
  };
}

function allocateProviderCancellation({
  targetCredits,
  accountedCredits,
  globalBalance,
  trackedBalance,
  canceledOrderId,
  canceledLot,
  otherLots,
  usesBaseCreditPolicy
}) {
  const target = whole(targetCredits);
  const accounted = Math.min(target, whole(accountedCredits));
  const global = whole(globalBalance);
  const tracked = Math.min(global, whole(trackedBalance));
  let remainingTarget = Math.max(0, target - accounted);

  if (!usesBaseCreditPolicy) {
    // Legacy refunds may only consume credits that are not owned by any v1 lot.
    const untrackedAvailable = Math.max(0, global - tracked);
    const untrackedCredits = Math.min(remainingTarget, untrackedAvailable);
    return {
      targetCredits: target,
      accountedCredits: accounted,
      balanceDebit: untrackedCredits,
      appliedCredits: accounted + untrackedCredits,
      unrecoveredCredits: Math.max(0, remainingTarget - untrackedCredits),
      untrackedCredits,
      trackedCredits: 0,
      ownLotCredits: 0,
      otherLotCredits: 0,
      allocations: [],
      lotUpdates: [],
      newTrackedBalance: tracked
    };
  }

  let walletAvailable = global;
  const allocations = [];
  const lotUpdates = [];
  let ownLotCredits = 0;
  const own = normalizeTrackedLot(canceledLot);
  if (own && own.id === String(canceledOrderId || '') && remainingTarget > 0 && walletAvailable > 0) {
    // Cancellation revokes all package/event bonus credits before refundable paid credits.
    const bonusCredits = Math.min(remainingTarget, walletAvailable, own.bonusRemaining);
    remainingTarget -= bonusCredits;
    walletAvailable -= bonusCredits;
    const paidCredits = Math.min(remainingTarget, walletAvailable, own.paidRemaining);
    remainingTarget -= paidCredits;
    walletAvailable -= paidCredits;
    ownLotCredits = paidCredits + bonusCredits;
    if (ownLotCredits > 0) {
      allocations.push({
        orderId: own.id,
        paidCredits,
        bonusCredits,
        totalCredits: ownLotCredits,
        source: 'canceled_order'
      });
      lotUpdates.push({
        orderId: own.id,
        ref: own.ref,
        paidRemaining: own.paidRemaining - paidCredits,
        bonusRemaining: own.bonusRemaining - bonusCredits,
        active: own.paidRemaining - paidCredits + own.bonusRemaining - bonusCredits > 0
      });
    }
  }

  const untrackedAvailable = Math.max(0, global - tracked);
  const untrackedCredits = Math.min(remainingTarget, walletAvailable, untrackedAvailable);
  remainingTarget -= untrackedCredits;
  walletAvailable -= untrackedCredits;

  let otherLotCredits = 0;
  for (const lot of sortTrackedLots(otherLots).filter(value => value.id !== String(canceledOrderId || ''))) {
    if (remainingTarget <= 0 || walletAvailable <= 0) break;
    const paidCredits = Math.min(remainingTarget, walletAvailable, lot.paidRemaining);
    remainingTarget -= paidCredits;
    walletAvailable -= paidCredits;
    const bonusCredits = Math.min(remainingTarget, walletAvailable, lot.bonusRemaining);
    remainingTarget -= bonusCredits;
    walletAvailable -= bonusCredits;
    const totalCredits = paidCredits + bonusCredits;
    if (totalCredits <= 0) continue;
    otherLotCredits += totalCredits;
    allocations.push({
      orderId: lot.id,
      paidCredits,
      bonusCredits,
      totalCredits,
      source: 'other_lot'
    });
    lotUpdates.push({
      orderId: lot.id,
      ref: lot.ref,
      paidRemaining: lot.paidRemaining - paidCredits,
      bonusRemaining: lot.bonusRemaining - bonusCredits,
      active: lot.paidRemaining - paidCredits + lot.bonusRemaining - bonusCredits > 0
    });
  }

  const trackedCredits = ownLotCredits + otherLotCredits;
  const balanceDebit = trackedCredits + untrackedCredits;
  return {
    targetCredits: target,
    accountedCredits: accounted,
    balanceDebit,
    appliedCredits: accounted + balanceDebit,
    unrecoveredCredits: remainingTarget,
    untrackedCredits,
    trackedCredits,
    ownLotCredits,
    otherLotCredits,
    allocations,
    lotUpdates,
    newTrackedBalance: Math.max(0, tracked - trackedCredits)
  };
}

function creditHistoryDocumentId(kind, requestId) {
  const safeRequestId = String(requestId || '');
  if (!safeRequestId) return null;
  return kind === 'restore' ? `restore_req_${safeRequestId}` : `req_${safeRequestId}`;
}

module.exports = {
  CREDIT_GRANT_POLICY_VERSION,
  CREDIT_LOT_POLICY_VERSION,
  allocateCreditDeduction,
  allocateProviderCancellation,
  allocateCreditRestore,
  creditHistoryDocumentId,
  hasNumericLotBalances,
  normalizeTrackedLot,
  sortTrackedLots
};
