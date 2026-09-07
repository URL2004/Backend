'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../routes/payment').refundPolicy;
const source = fs.readFileSync(require.resolve('../routes/payment'), 'utf8').replace(/\r\n/g, '\n');
const ts = ms => ({ toMillis: () => ms });
const start = Date.parse('2026-08-01T10:00:00+09:00');
const end = policy.refundWindowLegalDeadlineMs(start);
const order = (extra = {}) => ({ uid: 'synthetic', status: 'refund_requested', amount: 10000,
  createdAt: ts(start), refundRequestedAt: ts(end), ...extra });
const review = { eligibilityReviewed: true, statutoryExceptionCode: 'remaining_balance_settlement', eligibilityReviewNote: '고객센터에서 잔액 환급 근거 확인' };
const denied = fn => assert.throws(fn, error => error.code === 'REFUND_ELIGIBILITY_REVIEW_REQUIRED' && error.status === 409);

test('approval honors receipt deadline, not approval date, and rederives missing legacy flags', () => {
  assert.equal(policy.requireRefundApprovalReview(order(), 'order', {}, { nowMs: end + 100000 }).required, false);
  denied(() => policy.requireRefundApprovalReview(order({ refundRequestedAt: ts(end + 1) }), 'order'));
  denied(() => policy.requireRefundApprovalReview(order({ refundRequestedAt: null }), 'order'));
  denied(() => policy.requireRefundApprovalReview(order({ createdAt: null }), 'order'));
  assert.equal(policy.requireRefundApprovalReview(order({ refundRequestedAt: ts(end + 1) }), 'order', review).accepted, true);
});

test('direct refunds use execution time and full subscription cancellation requires exception review', () => {
  const paid = order({ status: 'paid' });
  assert.equal(policy.requireRefundApprovalReview(paid, 'order', {}, { direct: true, nowMs: end }).required, false);
  denied(() => policy.requireRefundApprovalReview(paid, 'order', {}, { direct: true, nowMs: end + 1 }));
  denied(() => policy.requireRefundApprovalReview(paid, 'subscription', {}, { direct: true, nowMs: end }));
  assert.equal(policy.requireRefundApprovalReview(paid, 'subscription', review, { direct: true }).accepted, true);
});

test('an exception needs all fields, and stale or unaudited saved reviews cannot authorize another request', () => {
  const expired = order({ refundRequestedAt: ts(end + 1) });
  for (const body of [{}, { ...review, eligibilityReviewed: false }, { ...review, statutoryExceptionCode: 'unknown' }, { ...review, eligibilityReviewNote: ' ' }]) {
    denied(() => policy.requireRefundApprovalReview(expired, 'order', body));
  }
  const recorded = policy.refundEligibilityReviewUpdate(policy.requireRefundApprovalReview(expired, 'order', review), 'admin', ts(end + 2));
  assert.equal(policy.requireRefundApprovalReview({ ...expired, ...recorded }, 'order').persisted, true);
  denied(() => policy.requireRefundApprovalReview({ ...expired, ...recorded, refundRequestedAt: ts(end + 3) }, 'order'));
  denied(() => policy.requireRefundApprovalReview({ ...expired, ...recorded, refundEligibilityReviewedBy: '' }, 'order'));
});

test('a reserved request still needs review; an already-started provider operation can recover without a second review', () => {
  const processing = { kind: 'credit', operationId: 'synthetic-op', refundAmount: 100,
    creditsToDeduct: 10, priorRefundedAmount: 0, priorRefundedCredits: 0,
    targetRefundedAmount: 100, targetRefundedCredits: 10 };
  const expired = order({ refundRequestedAt: ts(end + 1), refundEligibilityReviewRequired: true });
  denied(() => policy.requireRefundApprovalReview({ ...expired, refundProcessing: { ...processing, phase: 'requested_reserved' } }, 'order'));
  for (const phase of [undefined, 'provider_canceling']) {
    assert.equal(policy.requireRefundApprovalReview({ ...expired, refundProcessing: { ...processing, phase } }, 'order').required, false);
  }
  assert.equal(policy.requireRefundApprovalReview({ ...expired, status: 'refund_processing', subscriptionRefundProcessing: { operationId: 'sub-op' } }, 'subscription').required, false);
});

// Execute the actual route handlers with a read-only synthetic store. Any
// reservation, wallet write or provider call fails the test immediately.
function harness(row, body, path) {
  let handler, writes = 0, providerCalls = 0;
  const orderRef = { id: 'synthetic-order', get: async () => ({ exists: true, data: () => row }) };
  const context = {
    ...policy, Date, console, Number, String, Math, Object,
    router: { post: (_path, fn) => { handler = fn; } },
    bearerToken: () => 'synthetic-token', verifyToken: async () => 'synthetic',
    verifyAdminToken: async () => 'synthetic-admin', requireAdmin: async () => 'synthetic-admin',
    setLogContext() {}, logger: { warn() {}, error() {}, info() {} },
    getOrderRef: () => orderRef, readPaymentKey: async () => 'synthetic-key',
    activeUpgradeRefundConflict: () => null,
    db: { collection: () => ({ doc: () => ({}) }), runTransaction: () => { writes++; throw Error('unexpected write'); } },
    outboundFetch: () => { providerCalls++; throw Error('unexpected provider call'); },
    tossBasicToken: () => 'synthetic'
  };
  vm.createContext(context);
  const processStart = source.indexOf('async function processRefund(');
  const processEnd = source.indexOf('\n}\n', processStart) + 2;
  vm.runInContext(source.slice(processStart, processEnd), context);
  const routeStart = source.indexOf(`router.post('${path}'`);
  const nextRoute = source.indexOf('\nrouter.', routeStart + 1);
  let block = source.slice(routeStart, nextRoute < 0 ? undefined : nextRoute);
  // The route closes at column zero; helpers following it are not needed here.
  block = block.slice(0, block.indexOf('\n});') + 4);
  vm.runInContext(block, context);
  const result = { status: 200 };
  const res = { status: code => { result.status = code; return res; }, json: data => { result.body = data; return res; } };
  return { run: async () => { await handler({ body: { orderId: orderRef.id, ...body } }, res); return result; }, writes: () => writes, providerCalls: () => providerCalls, context, orderRef };
}

test('user API rejects expired and undated credit/subscription orders without reserving or cancelling', async () => {
  for (const kind of ['credit', 'sub']) for (const dated of [true, false]) {
    const row = order({ status: 'paid', createdAt: dated ? ts(start) : null, approvedAt: dated ? ts(start) : null });
    const before = JSON.stringify(row);
    const h = harness(row, { kind }, '/request-refund');
    const result = await h.run();
    assert.equal(result.status, 400);
    assert.equal(result.body.code, dated ? 'REFUND_WINDOW_EXPIRED' : 'PAYMENT_DATE_MISSING');
    assert.equal(h.writes(), 0); assert.equal(h.providerCalls(), 0); assert.equal(JSON.stringify(row), before);
  }
});

test('old admin clients cannot approve expired pending requests or direct refunds without exception fields', async () => {
  for (const path of ['/approve-refund', '/admin/direct-refund']) for (const kind of ['order', 'subscription']) {
    const h = harness(order({ refundRequestedAt: ts(end + 1) }), { kind, reason: '고객 요청' }, path);
    const result = await h.run();
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'REFUND_ELIGIBILITY_REVIEW_REQUIRED');
    assert.equal(h.writes(), 0); assert.equal(h.providerCalls(), 0);
  }
});

test('reviewed direct cancellation records actor and evidence before the synthetic provider is called', async () => {
  const row = order({ status: 'paid', approvedAt: ts(start) });
  const h = harness(row, { kind: 'subscription', reason: '중복 결제 확인', ...review }, '/admin/direct-refund');
  Object.assign(h.context, require('../lib/paymentReconciliation'), {
    PAYMENT_ACCOUNT_CLAIMS_COLLECTION: 'paymentAccountClaims',
    admin: { firestore: { FieldValue: { serverTimestamp: () => ts(end + 1000) } } }
  });
  h.context.db.runTransaction = async callback => callback({
    get: async ref => ({ exists: ref === h.orderRef, data: () => ref === h.orderRef ? row : {} }),
    update: (ref, update) => { assert.equal(ref, h.orderRef); Object.assign(row, update); }
  });
  let providerCalls = 0;
  h.context.outboundFetch = async () => {
    providerCalls++;
    assert.equal(row.refundEligibilityReviewedBy, 'synthetic-admin');
    assert.equal(row.refundEligibilityReviewNote, review.eligibilityReviewNote);
    assert.ok(row.refundEligibilityReviewedAt.toMillis() > end);
    return { ok: true, json: async () => ({}) };
  };
  const result = await h.run();
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.equal(providerCalls, 1); assert.equal(row.status, 'refunded');
});
