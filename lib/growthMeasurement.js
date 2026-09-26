'use strict';
const crypto = require('node:crypto');
const TEN_MINUTES = 600000;
const DAY = 86400000;
const FIXED_QUERIES = new Set(['ai 검사기', 'ai검사기', 'ai 판독기', 'ai판독기', 'ai 탐지기', 'ai탐지기']);
const ms = value => Date.parse(value);
const ratio = (n, d) => d ? n / d : null;
const hasTransaction = value => typeof value === 'string' && !!value.trim() && !['(not set)', '(other)'].includes(value.trim());
const fingerprint = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const kstDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
function interval(options) {
  const start = ms(options.start), end = ms(options.end), asOf = ms(options.asOf);
  if (![start, end, asOf].every(Number.isFinite) || start >= end || end > asOf) throw new Error('Valid start < end <= asOf timestamps required');
  return { start, end, asOf };
}
function group(rows, keyOf) {
  const out = new Map();
  for (const row of rows) { const key = keyOf(row); if (!out.has(key)) out.set(key, []); out.get(key).push(row); }
  return out;
}
function summarizeAuth(events, options) {
  const { start, end, asOf } = interval(options);
  const valid = events.filter(e => /^[a-f0-9]{32}$/.test(e.attempt_id || '') && Number.isFinite(ms(e.ts)) && ms(e.ts) <= asOf);
  const attempts = []; let orphanResults = 0, duplicateStarts = 0, duplicateResults = 0, conflictingResults = 0, lateResults = 0;
  for (const rows of group(valid, e => e.attempt_id).values()) {
    rows.sort((a, b) => ms(a.ts) - ms(b.ts));
    const starts = rows.filter(e => e.outcome === 'start');
    const first = starts[0];
    if (!first) { orphanResults += rows.filter(e => e.outcome !== 'start' && ms(e.ts) >= start && ms(e.ts) < end).length; continue; }
    const began = ms(first.ts);
    if (began < start || began >= end) continue;
    duplicateStarts += starts.length - 1;
    const results = rows.filter(e => ['success', 'cancel', 'error'].includes(e.outcome) && ms(e.ts) >= began && ms(e.ts) <= began + TEN_MINUTES);
    lateResults += rows.filter(e => ['success', 'cancel', 'error'].includes(e.outcome) && ms(e.ts) > began + TEN_MINUTES).length;
    duplicateResults += Math.max(0, results.length - 1);
    if (new Set(results.map(e => e.outcome)).size > 1) conflictingResults++;
    const outcome = began + TEN_MINUTES > asOf ? 'pending' : results[0]?.outcome || 'incomplete';
    attempts.push({ day: kstDay(began), method: first.method || 'unknown', browser: first.browser || 'unknown',
      device: first.device || 'unknown', source: first.traffic_source || 'other', medium: first.traffic_medium || 'other',
      outcome, stage: results[0]?.stage || first.stage || 'unknown', error_code: results[0]?.error_code || '',
      linked: results.length > 0 });
  }
  const counts = { success: 0, cancel: 0, error: 0, incomplete: 0, pending: 0 };
  for (const row of attempts) counts[row.outcome]++;
  const mature = attempts.length - counts.pending;
  const by = fields => [...group(attempts, e => fields.map(k => e[k]).join('|')).values()].map(rows => {
    const n = rows.filter(x => x.outcome !== 'pending').length;
    const successes = rows.filter(x => x.outcome === 'success').length;
    return { ...Object.fromEntries(fields.map(k => [k, rows[0][k]])), starts: rows.length, mature: n,
      success: successes, errors: rows.filter(x => x.outcome === 'error').length,
      cancel: rows.filter(x => x.outcome === 'cancel').length, incomplete: rows.filter(x => x.outcome === 'incomplete').length,
      pending: rows.filter(x => x.outcome === 'pending').length, successRate: ratio(successes, n) };
  });
  return { starts: attempts.length, mature, ...counts, successRate: ratio(counts.success, mature),
    technicalErrorRate: ratio(counts.error, mature), linkedResultRate: ratio(attempts.filter(x => x.linked).length, attempts.length),
    orphanResults, duplicateStarts, duplicateResults, conflictingResults, lateResults,
    byDayProviderBrowserDevice: by(['day', 'method', 'browser', 'device']),
    byChannelDevice: by(['source', 'medium', 'device']),
    errors: [...group(attempts.filter(x => x.outcome === 'error'), e => [e.method, e.stage, e.error_code].join('|')).values()]
      .map(rows => ({ method: rows[0].method, stage: rows[0].stage, error_code: rows[0].error_code, count: rows.length })).sort((a, b) => b.count - a.count) };
}
function validatedOrders(orders) {
  const seen = new Set();
  for (const o of orders) {
    if (!o.orderId || seen.has(o.orderId)) throw new Error('Orders must have unique nonempty orderId');
    seen.add(o.orderId);
    if (![o.amount, o.refundedAmount].every(Number.isFinite) || o.amount < 0 || o.refundedAmount < 0 || o.refundedAmount > o.amount) throw new Error('Invalid order amount/refund');
  }
  return orders;
}
function reconcilePurchases(orders, gaPurchases, options) {
  const { start, end, asOf } = interval(options);
  const paid = validatedOrders(orders).filter(o => ms(o.approvedAt) >= start && ms(o.approvedAt) < end && ms(o.approvedAt) <= asOf);
  const ledger = new Map(paid.map(o => [o.orderId, o]));
  if (gaPurchases.some(x => !Number.isFinite(x.revenue) || !Number.isInteger(x.purchaseEvents) || x.purchaseEvents < 0)) throw new Error('Invalid GA purchase totals');
  const ga = group(gaPurchases.filter(x => hasTransaction(x.transactionId)), x => x.transactionId);
  const differences = [];
  for (const id of new Set([...ledger.keys(), ...ga.keys()])) {
    const order = ledger.get(id), rows = ga.get(id) || [];
    if (rows.some(x => !Number.isFinite(x.revenue) || !Number.isInteger(x.purchaseEvents) || x.purchaseEvents < 0)) throw new Error('Invalid GA purchase totals');
    const revenue = rows.reduce((s, r) => s + r.revenue, 0), events = rows.reduce((s, r) => s + r.purchaseEvents, 0);
    const reasons = [];
    if (!order) reasons.push('ga_without_period_order');
    if (!rows.length) reasons.push('order_without_ga');
    if (events > 1) reasons.push('multiple_purchase_events');
    if (order && rows.length && Math.abs(order.amount - revenue) >= 1) reasons.push('amount_mismatch');
    if (reasons.length) differences.push({ orderFingerprint: fingerprint(id), reasons, orderAmount: order?.amount ?? null, gaRevenue: revenue, purchaseEvents: events });
  }
  return { approvedOrders: paid.length, gross: paid.reduce((s, o) => s + o.amount, 0),
    refundedAsOf: paid.reduce((s, o) => s + o.refundedAmount, 0),
    netOrderCohortAsOf: paid.reduce((s, o) => s + o.amount - o.refundedAmount, 0),
    firstPurchaseOrders: paid.filter(o => o.firstPurchase === true).length,
    firstPurchaseUnknown: paid.filter(o => typeof o.firstPurchase !== 'boolean').length,
    gaRevenue: gaPurchases.reduce((s, o) => s + o.revenue, 0),
    gaRowsWithoutTransaction: gaPurchases.filter(x => !hasTransaction(x.transactionId)).length,
    gaRevenueWithoutTransaction: gaPurchases.filter(x => !hasTransaction(x.transactionId)).reduce((s, o) => s + o.revenue, 0),
    differenceCount: differences.length, differences };
}
function summarizeCheckout(events, orders, options) {
  const { start, end, asOf } = interval(options);
  const approvals = new Map(validatedOrders(orders).map(o => [o.orderId, ms(o.approvedAt)]));
  const starts = events.filter(e => e.event === 'begin_checkout' && ms(e.ts) >= start && ms(e.ts) < end);
  let mature = 0, approvedWithin24h = 0, pending = 0, cancelledUnapproved = 0, errorUnapproved = 0, incomplete = 0;
  const linked = group(starts.filter(e => hasTransaction(e.transactionId)), e => e.transactionId);
  for (const [id, rows] of linked) {
    const at = Math.min(...rows.map(e => ms(e.ts)));
    if (at + DAY > asOf) { pending++; continue; }
    mature++;
    const approval = approvals.get(id);
    if (approval >= at && approval <= at + DAY) approvedWithin24h++;
    else {
      const last = events.filter(e => e.transactionId === id && ['checkout_cancel', 'checkout_error', 'payment_error'].includes(e.event)
        && ms(e.ts) >= at && ms(e.ts) <= at + DAY).sort((a, b) => ms(b.ts) - ms(a.ts))[0];
      if (last?.event === 'checkout_cancel') cancelledUnapproved++;
      else if (last) errorUnapproved++;
      else incomplete++;
    }
  }
  return { startedOrders: linked.size, mature, pending, approvedWithin24h, completionRate: ratio(approvedWithin24h, mature),
    cancelledUnapproved, errorUnapproved, incomplete,
    unlinkedStarts: starts.filter(e => !hasTransaction(e.transactionId)).length,
    preOrderCancels: events.filter(e => e.event === 'checkout_cancel' && !hasTransaction(e.transactionId) && ms(e.ts) >= start && ms(e.ts) < end).length };
}
function summarizeAds(orders, ads, options) {
  const { start, end } = interval(options);
  const paid = validatedOrders(orders).filter(o => ms(o.approvedAt) >= start && ms(o.approvedAt) < end);
  const key = x => [x.source, x.medium, x.campaign].join('|');
  const matched = new Set();
  const rows = [...group(ads, key).entries()].map(([id, costs]) => {
    if (costs.some(x => !Number.isFinite(x.cost) || x.cost < 0 || x.start !== options.start || x.end !== options.end)) throw new Error('Ad cost period or value mismatch');
    const attributed = paid.filter(o => o.attribution?.model === 'last_non_direct_30d' && key(o.attribution) === id);
    attributed.forEach(o => matched.add(o.orderId));
    const cost = costs.reduce((s, c) => s + c.cost, 0), net = attributed.reduce((s, o) => s + o.amount - o.refundedAmount, 0);
    const first = attributed.filter(o => o.firstPurchase === true);
    const firstPurchaseUnknown = attributed.filter(o => typeof o.firstPurchase !== 'boolean').length;
    const buyers = !firstPurchaseUnknown && first.every(o => o.buyerKey) ? new Set(first.map(o => o.buyerKey)).size : null;
    return { source: costs[0].source, medium: costs[0].medium, campaign: costs[0].campaign,
      cost, attributedOrders: attributed.length, firstPurchaseUnknown, netOrderCohortAsOf: net,
      observedNetRoas: ratio(net, cost), observedFirstBuyerCac: buyers ? cost / buyers : null,
      decision: 'judgment_pending', note: 'Observed attribution, not incremental return; keep current budget.' };
  });
  return { attributionModel: 'last_non_direct_30d', rows,
    ordersNotMatchedToCostRows: paid.filter(o => !matched.has(o.orderId)).length,
    revenueNotMatchedToCostRows: paid.filter(o => !matched.has(o.orderId)).reduce((s, o) => s + o.amount - o.refundedAmount, 0) };
}
function summarizeSearch(rows) {
  const fixed = rows.map(x => ({ ...x, query: String(x.query || '').toLowerCase().trim() })).filter(x => FIXED_QUERIES.has(x.query));
  if (fixed.some(x => ![x.clicks, x.impressions, x.position].every(Number.isFinite) || x.clicks < 0 || x.impressions < 0 || x.clicks > x.impressions || x.position < 0)) throw new Error('Invalid search totals');
  return [...group(fixed, x => [x.query, x.page, x.device].join('|')).values()].map(items => {
    const impressions = items.reduce((s, x) => s + x.impressions, 0), clicks = items.reduce((s, x) => s + x.clicks, 0);
    return { query: items[0].query, page: items[0].page, device: items[0].device, clicks, impressions,
      ctr: ratio(clicks, impressions), position: ratio(items.reduce((s, x) => s + x.position * x.impressions, 0), impressions) };
  });
}
function buildGrowthReport(input) {
  interval(input);
  return { schemaVersion: 1, period: { start: input.start, end: input.end, asOf: input.asOf },
    auth: Array.isArray(input.authEvents) ? summarizeAuth(input.authEvents, input) : null,
    purchases: Array.isArray(input.orders) && Array.isArray(input.gaPurchases) ? reconcilePurchases(input.orders, input.gaPurchases, input) : null,
    checkout: Array.isArray(input.checkoutEvents) && Array.isArray(input.orders) ? summarizeCheckout(input.checkoutEvents, input.orders, input) : null,
    ads: Array.isArray(input.ads) && Array.isArray(input.orders) ? summarizeAds(input.orders, input.ads, input) : null,
    search: Array.isArray(input.searchRows) ? summarizeSearch(input.searchRows) : null,
    notes: ['Missing datasets are null, not zero.', 'Client diagnostics are observations; delivery gaps and spoofing are possible.',
      'Refunds are cumulative as of extraction for the approval cohort, not period cash-flow refunds.',
      'GSC query rows cannot identify individual purchasers. Compare landing cohorts separately.'] };
}
module.exports = { summarizeAuth, reconcilePurchases, summarizeCheckout, summarizeAds, summarizeSearch, buildGrowthReport };
