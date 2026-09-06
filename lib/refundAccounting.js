(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GPRefundAccounting = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function amount(value) {
    if (value === null || value === undefined || typeof value === 'boolean'
        || (typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  function confirmedRefundAmount(order) {
    const total = amount(order.amount) || 0;
    const processing = order.refundProcessing || order.subscriptionRefundProcessing;
    // Cancellation targets may be written before the provider confirms them.
    // Only the prior settled total is revenue while an operation is pending.
    if (processing) return Math.min(total, amount(processing.priorRefundedAmount) || 0);
    const recorded = amount(order.refundedAmount) ?? amount(order.refundAmount);
    return Math.min(total, recorded ?? (order.status === 'refunded' ? total : 0));
  }
  function pendingRefund(order, kind) {
    const processing = order.refundProcessing || order.subscriptionRefundProcessing;
    if (!processing && !['refund_requested', 'refund_processing'].includes(order.status)) return null;
    const snapshot = order.refundRequestSnapshot || {};
    const isSub = kind === 'subscription' || kind === 'sub';
    const total = amount(order.totalGrantedCredits ?? order.safeCredits ?? order.credits);
    const paid = amount(order.paidCredits);
    const base = !isSub && order.creditGrantPolicyVersion === 'credit-grant-base-v1'
      && paid > 0 && total >= paid;
    const expected = processing ? amount(processing.refundAmount)
      : amount(snapshot.requestedRefundAmount) ?? amount(order.requestedRefundAmount);
    const credits = processing ? amount(processing.creditsToDeduct)
      : amount(snapshot.requestedRefundCredits) ?? amount(order.requestedRefundCredits);
    const remainingMoney = Math.max(0, (amount(order.amount) || 0) - confirmedRefundAmount(order));
    const validAmount = expected !== null && expected <= remainingMoney;
    const validCredits = !isSub && credits !== null && total !== null && credits <= total;
    const used = validCredits ? total - credits : null;
    const remainingPaid = base && used !== null ? Math.max(0, paid - used) : null;
    // A tracked reservation carries its exact paid/bonus split. Do not derive
    // this from the wallet or zeroed order-lot balances after reservation.
    const trackedPaid = processing?.creditLotPolicyVersion === 'credit-lot-v1'
      ? amount(processing.reservedPaidCredits) : null;
    const trackedBonus = processing?.creditLotPolicyVersion === 'credit-lot-v1'
      ? amount(processing.reservedBonusCredits) : null;
    const splitValid = base && validCredits && trackedPaid !== null && trackedBonus !== null
      && trackedPaid <= paid && trackedBonus <= total - paid && trackedPaid + trackedBonus === credits;
    const refundablePaid = splitValid ? trackedPaid : remainingPaid;
    return {
      amount: validAmount ? expected : null,
      credits: validCredits ? credits : null,
      policy: isSub ? 'subscription' : base ? 'base' : 'legacy',
      totalGrantedCredits: isSub ? null : total,
      paidCredits: base ? paid : null,
      bonusCredits: base ? total - paid : null,
      usedCredits: used,
      refundablePaidCredits: refundablePaid,
      paidUsedCredits: base && refundablePaid !== null ? paid - refundablePaid : null,
      reserved: !!processing && !isSub,
      phase: processing ? (processing.phase === 'requested_reserved' ? 'requested_reserved' : 'provider_canceling') : 'requested',
      source: processing ? 'reservation' : 'request_snapshot',
      reviewRequired: !validAmount || (!isSub && !validCredits)
    };
  }
  return { amount, confirmedRefundAmount, pendingRefund };
});
