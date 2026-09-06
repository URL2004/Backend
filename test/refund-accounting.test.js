'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { amount, pendingRefund, confirmedRefundAmount } = require('../lib/refundAccounting');
const { aggregateOrderDocs } = require('../lib/revenue');
const { serializeOrderDoc } = require('../routes/payment').adminHistoryPolicy;
const order = () => ({ status: 'refund_requested', amount: 14500, paidCredits: 500,
  totalGrantedCredits: 650, creditGrantPolicyVersion: 'credit-grant-base-v1',
  creditLotPolicyVersion: 'credit-lot-v1', refundPaidCreditsRemaining: 0, refundEventBonusCreditsRemaining: 0,
  requestedRefundAmount: 11600, requestedRefundCredits: 550,
  refundProcessing: { kind: 'credit', phase: 'requested_reserved', operationId: 'server-private-operation',
    priorRefundedAmount: 0, refundAmount: 11600, creditsToDeduct: 550,
    creditLotPolicyVersion: 'credit-lot-v1', reservedPaidCredits: 400, reservedBonusCredits: 150 } });

test('reserved credits do not become used credits or a zero-won refund', () => {
  const q = pendingRefund(order());
  assert.equal(q.amount, 11600);assert.equal(q.credits, 550);assert.equal(q.usedCredits, 100);
  assert.equal(q.paidUsedCredits, 100);assert.equal(q.refundablePaidCredits, 400);assert.equal(q.reserved, true);
});
test('current operation takes precedence over an older request snapshot', () => {
  const o=order();o.refundRequestSnapshot={requestedRefundAmount:14500,requestedRefundCredits:650};
  assert.equal(pendingRefund(o).amount,11600);
  delete o.refundProcessing;o.refundRequestSnapshot={requestedRefundAmount:11600,requestedRefundCredits:550};
  assert.equal(pendingRefund(o).amount,11600);assert.equal(pendingRefund(o).reserved,false);
});
test('zero, missing and invalid snapshot amounts stay distinct, including subscriptions', () => {
  assert.equal(pendingRefund({status:'refund_requested',amount:1000,requestedRefundAmount:0},'subscription').amount,0);
  assert.equal(pendingRefund({status:'refund_requested',amount:1000},'subscription').amount,null);
  assert.equal(pendingRefund({...order(),refundProcessing:{refundAmount:20000,creditsToDeduct:550}}).amount,null);
  for(const v of [null,undefined,'', ' ',false,{},Infinity,-1])assert.equal(amount(v),null);
});
test('provider cancellation target is excluded from settled refunds and net revenue', () => {
  const o={status:'partially_refunded',amount:10000,refundedAmount:8000,refundAmount:8000,
    refundProcessing:{priorRefundedAmount:2000,refundAmount:6000}};
  assert.equal(confirmedRefundAmount(o),2000);
  const sums=aggregateOrderDocs([o]);assert.equal(sums.paidAmount,8000);assert.equal(sums.refundAmount,2000);
  delete o.refundProcessing;assert.equal(confirmedRefundAmount(o),8000);
});
test('processing subscriptions remain revenue until finalized; explicit zero beats stale legacy amount', () => {
  assert.equal(aggregateOrderDocs([{status:'refund_processing',amount:10000,subscriptionRefundProcessing:{refundAmount:10000}}]).paidAmount,10000);
  assert.equal(confirmedRefundAmount({status:'refunded',amount:1000,refundedAmount:0,refundAmount:900}),0);
  assert.equal(confirmedRefundAmount({status:'refunded',amount:1000}),1000);
});
test('admin serializer exposes safe presentation without provider keys or operation identifiers', () => {
  const row=serializeOrderDoc({id:'test-order',data:()=>({...order(),paymentKey:'private-provider-key'})},'order');
  assert.equal(row.refundPresentation.amount,11600);assert.equal(row.confirmedRefundAmount,0);
  assert.equal(row.paymentKey,'present');assert(!JSON.stringify(row).includes('server-private-operation'));
  assert(!JSON.stringify(row).includes('private-provider-key'));
  const missing=serializeOrderDoc({id:'legacy',data:()=>({status:'refund_requested',amount:1000})},'order');
  assert.equal(missing.requestedRefundAmount,null);assert.equal(missing.refundPresentation.amount,null);
  const nullable=serializeOrderDoc({id:'nullable',data:()=>({refundPaidCreditsRemaining:null,refundEventBonusCreditsRemaining:null})},'order');
  assert.equal(nullable.refundPaidCreditsRemaining,null);assert.equal(nullable.refundEventBonusCreditsRemaining,null);
});
