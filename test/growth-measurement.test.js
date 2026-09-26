'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAuth, reconcilePurchases, summarizeCheckout, summarizeAds, summarizeSearch, buildGrowthReport } = require('../lib/growthMeasurement');
const period = { start: '2026-09-17T00:00:00+09:00', end: '2026-09-24T00:00:00+09:00', asOf: '2026-09-25T00:00:00+09:00' };
const event = (id, outcome, ts) => ({ attempt_id: id.repeat(32), outcome, ts, method: 'google', browser: 'chrome', device: 'mobile' });
test('login cohorts use starts, mature windows, first terminal, and explicit orphan/duplicate counts', () => {
  const r = summarizeAuth([
    event('a', 'start', '2026-09-17T01:00:00+09:00'), event('a', 'start', '2026-09-17T01:00:01+09:00'),
    event('a', 'success', '2026-09-17T01:00:02+09:00'), event('a', 'success', '2026-09-17T01:00:03+09:00'),
    event('b', 'start', '2026-09-17T01:00:00+09:00'), event('b', 'error', '2026-09-17T01:11:00+09:00'),
    event('c', 'cancel', '2026-09-17T01:00:00+09:00'),
    event('d', 'start', '2026-09-23T23:59:00+09:00')
  ], { ...period, asOf: period.end });
  assert.equal(r.starts, 3); assert.equal(r.mature, 2); assert.equal(r.successRate, .5);
  assert.equal(r.incomplete, 1); assert.equal(r.pending, 1); assert.equal(r.orphanResults, 1);
  assert.equal(r.duplicateStarts, 1); assert.equal(r.duplicateResults, 1);
  assert.equal(r.lateResults, 1);
  assert.equal(r.byDayProviderBrowserDevice[0].day, '2026-09-17');
});
test('purchase reconciliation separates gross tracking from order-cohort refunds and exposes mismatches', () => {
  const orders = [{ orderId: 'one', amount: 2900, refundedAmount: 900, approvedAt: '2026-09-18T00:00:00+09:00', firstPurchase: true },
    { orderId: 'two', amount: 5900, refundedAmount: 0, approvedAt: '2026-09-18T00:00:00+09:00' }];
  const r = reconcilePurchases(orders, [{ transactionId: 'one', purchaseEvents: 2, revenue: 5800 }, { transactionId: 'orphan', purchaseEvents: 1, revenue: 2900 }], period);
  assert.equal(r.gross, 8800); assert.equal(r.netOrderCohortAsOf, 7900); assert.equal(r.differenceCount, 3);
  assert.ok(r.differences[0].reasons.includes('multiple_purchase_events'));
  assert.equal(r.firstPurchaseUnknown, 1); assert.equal(JSON.stringify(r).includes('"orderId"'), false);
  assert.throws(() => reconcilePurchases([...orders, orders[0]], [], period), /unique/);
  const missing = reconcilePurchases([], [{ transactionId: '(not set)', purchaseEvents: 1, revenue: 100 }], period);
  assert.equal(missing.gaRowsWithoutTransaction, 1); assert.equal(missing.gaRevenueWithoutTransaction, 100);
  assert.equal(missing.differenceCount, 0);
  assert.throws(() => reconcilePurchases([], [{ transactionId: '', revenue: NaN, purchaseEvents: 1 }], period), /Invalid GA/);
});
test('checkout allows cancellation then purchase and censors immature 24-hour cohorts', () => {
  const events = [{ event: 'begin_checkout', transactionId: 'one', ts: '2026-09-18T00:00:00+09:00' },
    { event: 'checkout_cancel', transactionId: 'one', ts: '2026-09-18T00:01:00+09:00' },
    { event: 'begin_checkout', transactionId: 'late', ts: '2026-09-23T23:00:00+09:00' }];
  const orders = [{ orderId: 'one', amount: 2900, refundedAmount: 0, approvedAt: '2026-09-18T00:02:00+09:00' }];
  const r = summarizeCheckout(events, orders, { ...period, asOf: period.end });
  assert.equal(r.mature, 1); assert.equal(r.pending, 1); assert.equal(r.completionRate, 1);
  assert.equal(summarizeCheckout(events, [], { ...period, asOf: period.end }).cancelledUnapproved, 1);
});
test('missing datasets and absent denominators are unknown, never zero performance', () => {
  assert.equal(buildGrowthReport(period).auth, null);
  assert.equal(summarizeAuth([], period).successRate, null);
  assert.throws(() => buildGrowthReport({ ...period, asOf: period.start }));
});
test('ad cost periods match exactly and CAC requires known first buyers', () => {
  const ads = [{ start: period.start, end: period.end, source: 'naver', medium: 'cpc', campaign: 'test', cost: 1000 }];
  const orders = [{ orderId: 'one', amount: 2900, refundedAmount: 900, firstPurchase: true, approvedAt: '2026-09-18T00:00:00+09:00',
    attribution: { model: 'last_non_direct_30d', source: 'naver', medium: 'cpc', campaign: 'test' } }];
  const r = summarizeAds(orders, ads, period);
  assert.equal(r.rows[0].observedNetRoas, 2); assert.equal(r.rows[0].observedFirstBuyerCac, null);
  const partlyKnown = [{ ...orders[0], buyerKey: 'buyer' }, { ...orders[0], orderId: 'two', firstPurchase: null }];
  assert.equal(summarizeAds(partlyKnown, ads, period).rows[0].observedFirstBuyerCac, null);
  assert.throws(() => summarizeAds(orders, [{ ...ads[0], end: period.start }], period), /period/);
});
test('fixed nonbrand search uses impression-weighted positions and excludes brand queries', () => {
  const r = summarizeSearch([{ query: 'ai 검사기', page: '/', device: 'mobile', clicks: 10, impressions: 100, position: 4 },
    { query: 'ai 검사기', page: '/', device: 'mobile', clicks: 0, impressions: 300, position: 8 },
    { query: '교수님 피하기', page: '/', device: 'mobile', clicks: 50, impressions: 100, position: 1 }]);
  assert.equal(r.length, 1); assert.equal(r[0].position, 7); assert.equal(r[0].ctr, .025);
  assert.throws(() => summarizeSearch([{ query: 'ai검사기', clicks: '10', impressions: 100, position: 4 }]), /Invalid search/);
});
