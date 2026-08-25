'use strict';

// Read-only production reconciliation between Toss transactions and Firestore.
// Required env: TOSS_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT.
// Output intentionally contains only aggregate counts and hashed identifiers.

const crypto = require('crypto');
const { admin, db } = require('../config');

const TOSS_ORIGIN = 'https://api.tosspayments.com';
const PAGE_LIMIT = 5000;
const MAX_PAGES = 30;
const INCIDENT_STARTED_AT_MS = Date.parse('2026-08-24T19:19:00+09:00');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const value = inline === undefined ? argv[i + 1] : inline;
    if (inline === undefined && value && !value.startsWith('--')) i += 1;
    out[rawKey] = inline === undefined && (!value || value.startsWith('--')) ? '1' : value;
  }
  return out;
}

function requiredDate(value, fallback, endOfDay = false) {
  const raw = String(value || fallback || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(raw)) {
    throw new Error(`INVALID_AUDIT_DATE:${raw}`);
  }
  if (raw.includes('T')) return raw;
  return `${raw}T${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value._seconds) return Number(value._seconds) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  const valueMs = timestampMs(value);
  return valueMs ? new Date(valueMs).toISOString() : null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderKind(orderId) {
  const id = String(orderId || '');
  if (/^order_\d{10,}$/.test(id)) return 'credit';
  if (/^sub_[A-Za-z0-9_-]+_\d{10,}$/.test(id)) return 'subscription';
  return 'other';
}

function groupedCounts(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row?.[field] ?? 'null');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

function summarizedList(rows, limit = 20) {
  return {
    count: rows.length,
    items: rows.slice(0, limit),
    truncated: rows.length > limit
  };
}

async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}

function tossAuthorization() {
  const secret = String(process.env.TOSS_SECRET_KEY || '');
  if (!secret) throw new Error('TOSS_SECRET_KEY_REQUIRED');
  return `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
}

async function tossJson(path) {
  const response = await fetch(`${TOSS_ORIGIN}${path}`, {
    headers: { Authorization: tossAuthorization() },
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`TOSS_${response.status}_${String(body?.code || 'UNKNOWN')}`);
  }
  return body;
}

async function fetchTransactions(startDate, endDate) {
  const transactions = [];
  let startingAfter = '';
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({
      startDate,
      endDate,
      limit: String(PAGE_LIMIT)
    });
    if (startingAfter) query.set('startingAfter', startingAfter);
    const page = await tossJson(`/v1/transactions?${query}`);
    if (!Array.isArray(page)) throw new Error('TOSS_TRANSACTIONS_NOT_ARRAY');
    transactions.push(...page);
    if (page.length < PAGE_LIMIT) return { transactions, pages: pageNumber };
    const next = String(page.at(-1)?.transactionKey || '');
    if (!next || next === startingAfter) throw new Error('TOSS_PAGINATION_STALLED');
    startingAfter = next;
  }
  throw new Error('TOSS_PAGINATION_LIMIT');
}

function firestoreRows(snapshot, kind) {
  return snapshot.docs.map(doc => ({ id: doc.id, kind, ...doc.data() }));
}

async function scanUserLedgers(userDocs) {
  try {
    const [creditSnapshot, couponSnapshot] = await Promise.all([
      db.collectionGroup('creditHistory').get(),
      db.collectionGroup('couponHistory').get()
    ]);
    return {
      source: 'collection_group_full_scan',
      creditHistory: creditSnapshot.docs.map(doc => ({
        id: doc.id,
        uid: doc.ref.parent.parent?.id || '',
        ...doc.data()
      })),
      couponHistory: couponSnapshot.docs.map(doc => ({
        id: doc.id,
        uid: doc.ref.parent.parent?.id || '',
        ...doc.data()
      }))
    };
  } catch (error) {
    if (error?.code !== 9 && error?.code !== 'failed-precondition') throw error;
  }
  const rows = await mapLimit(userDocs, 12, async userDoc => {
    const [creditSnapshot, couponSnapshot] = await Promise.all([
      userDoc.ref.collection('creditHistory').get(),
      userDoc.ref.collection('couponHistory').get()
    ]);
    const creditHistory = creditSnapshot.docs.map(doc => ({
      id: doc.id,
      uid: userDoc.id,
      ...doc.data()
    }));
    const couponHistory = couponSnapshot.docs.map(doc => ({
      id: doc.id,
      uid: userDoc.id,
      ...doc.data()
    }));
    return { uid: userDoc.id, creditHistory, couponHistory };
  });
  return {
    source: 'per_user_fallback',
    creditHistory: rows.flatMap(row => row.creditHistory),
    couponHistory: rows.flatMap(row => row.couponHistory)
  };
}

function indexByOrder(rows) {
  const index = new Map();
  for (const row of rows) {
    if (!row.orderId) continue;
    const orderId = String(row.orderId);
    const existing = index.get(orderId) || [];
    existing.push(row);
    index.set(orderId, existing);
  }
  return index;
}

function matchCreditLedgers(orders, charges) {
  const exactByOrder = indexByOrder(charges);
  const byUid = new Map();
  for (const charge of charges) {
    const list = byUid.get(charge.uid) || [];
    list.push(charge);
    byUid.set(charge.uid, list);
  }
  const used = new Set();
  const matches = new Map();
  const keyFor = row => `${row.uid}:${row.id}`;
  const sortedOrders = [...orders].sort((a, b) => orderTime(a) - orderTime(b));
  for (const order of sortedOrders) {
    const expected = numeric(order.safeCredits || order.credits);
    const exact = (exactByOrder.get(order.id) || []).find(row => !used.has(keyFor(row)));
    let matched = exact || null;
    let reason = exact ? 'orderId' : '';
    if (!matched) {
      const at = orderTime(order);
      const nearby = (byUid.get(order.uid) || [])
        .filter(row => !used.has(keyFor(row)))
        .filter(row => numeric(row.amount) === expected)
        .map(row => ({ row, distanceMs: Math.abs(timestampMs(row.createdAt) - at) }))
        .filter(candidate => candidate.distanceMs <= 5 * 60 * 1000)
        .sort((a, b) => a.distanceMs - b.distanceMs);
      matched = nearby[0]?.row || null;
      if (matched) reason = 'uid_amount_time';
    }
    if (!matched) {
      const at = orderTime(order);
      const nearbyAnyAmount = (byUid.get(order.uid) || [])
        .filter(row => !used.has(keyFor(row)))
        .map(row => ({ row, distanceMs: Math.abs(timestampMs(row.createdAt) - at) }))
        .filter(candidate => candidate.distanceMs <= 5 * 60 * 1000)
        .sort((a, b) => a.distanceMs - b.distanceMs);
      matched = nearbyAnyAmount[0]?.row || null;
      if (matched) reason = 'uid_time_amount_mismatch';
    }
    if (!matched) continue;
    used.add(keyFor(matched));
    matches.set(order.id, { row: matched, reason });
  }
  return {
    matches,
    unusedCharges: charges.filter(row => !used.has(keyFor(row))),
    reasons: groupedCounts([...matches.values()], 'reason'),
    chargesWithOrderId: charges.filter(row => row.orderId).length
  };
}

function transactionGroups(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    const orderId = String(transaction.orderId || '');
    const rows = groups.get(orderId) || [];
    rows.push(transaction);
    groups.set(orderId, rows);
  }
  return groups;
}

async function definitiveMissingPayments(candidates) {
  const inspected = await mapLimit(candidates, 5, async ([orderId, transactions]) => {
    try {
      const payment = await tossJson(`/v1/payments/orders/${encodeURIComponent(orderId)}`);
      return { orderId, transactions, payment };
    } catch (error) {
      return { orderId, transactions, error: String(error?.message || error) };
    }
  });
  return inspected
    .filter(row => ['DONE', 'PARTIAL_CANCELED'].includes(String(row.payment?.status || '')))
    .map(row => ({
      fingerprint: fingerprint(row.orderId),
      kind: orderKind(row.orderId),
      status: row.payment.status,
      totalAmount: numeric(row.payment.totalAmount),
      balanceAmount: numeric(row.payment.balanceAmount),
      approvedAt: row.payment.approvedAt || null,
      transactionCount: row.transactions.length
    }));
}

function orderTime(row) {
  return timestampMs(row.createdAt || row.approvedAt || row.requestedAt || row.cycleStartedAt);
}

function canonicalCreditDelta(row) {
  const amount = numeric(row.amount);
  const used = numeric(row.used);
  // Historical admin debits encode the same debit in both amount and used.
  if (row.type === 'admin_adjust') return amount;
  return amount - used;
}

function auditCreditContinuity(ledgerByUid, userDocs) {
  const violations = [];
  const currentBalanceMismatches = [];
  for (const userDoc of userDocs) {
    const uid = userDoc.id;
    const rows = [...(ledgerByUid.get(uid) || [])]
      .filter(row => timestampMs(row.createdAt) && Number.isFinite(Number(row.remaining)))
      .sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const current = rows[i];
      const expected = numeric(previous.remaining) + canonicalCreditDelta(current);
      if (expected !== numeric(current.remaining)) {
        violations.push({
          uidFingerprint: fingerprint(uid),
          rowFingerprint: fingerprint(current.id),
          previousRemaining: numeric(previous.remaining),
          delta: canonicalCreditDelta(current),
          actualRemaining: numeric(current.remaining),
          at: iso(current.createdAt)
        });
      }
    }
    if (rows.length) {
      const latest = rows.at(-1);
      const currentCredits = numeric(userDoc.data()?.credits);
      if (numeric(latest.remaining) !== currentCredits) {
        currentBalanceMismatches.push({
          uidFingerprint: fingerprint(uid),
          latestLedgerRemaining: numeric(latest.remaining),
          currentCredits,
          latestAt: iso(latest.createdAt)
        });
      }
    }
  }
  return { violations, currentBalanceMismatches };
}

async function run() {
  if (!db || !admin) throw new Error('FIREBASE_SERVICE_ACCOUNT_REQUIRED');
  const args = parseArgs();
  const startDate = requiredDate(args.start, '2026-01-01');
  const endDate = requiredDate(args.end, new Date().toISOString().slice(0, 10), true);

  const [tossResult, orderSnapshot, subscriptionSnapshot, secretSnapshot, intentSnapshot, userSnapshot] = await Promise.all([
    fetchTransactions(startDate, endDate),
    db.collection('orders').get(),
    db.collection('subscriptionOrders').get(),
    db.collection('paymentSecrets').get(),
    db.collection('paymentIntents').get(),
    db.collection('users').get()
  ]);
  const ledgers = await scanUserLedgers(userSnapshot.docs);

  const orders = firestoreRows(orderSnapshot, 'credit');
  const subscriptions = firestoreRows(subscriptionSnapshot, 'subscription');
  const firestoreOrders = [...orders, ...subscriptions];
  const firestoreById = new Map(firestoreOrders.map(row => [row.id, row]));
  const userById = new Map(userSnapshot.docs.map(doc => [doc.id, doc.data()]));
  const secretIds = new Set(secretSnapshot.docs.map(doc => doc.id));
  const charges = ledgers.creditHistory.filter(row => row.type === 'charge');
  const couponGrants = ledgers.couponHistory.filter(row => row.type === 'grant');
  const chargesByOrder = indexByOrder(charges);
  const grantsByOrder = indexByOrder(couponGrants);
  const creditLedgerMatches = matchCreditLedgers(orders, charges);
  const ledgerByUid = new Map();
  for (const row of ledgers.creditHistory) {
    const list = ledgerByUid.get(row.uid) || [];
    list.push(row);
    ledgerByUid.set(row.uid, list);
  }

  const transactions = tossResult.transactions;
  const tossByOrder = transactionGroups(transactions);
  const ownedTossGroups = [...tossByOrder.entries()].filter(([orderId]) => orderKind(orderId) !== 'other');
  const missingCandidates = ownedTossGroups.filter(([orderId]) => !firestoreById.has(orderId));
  const approvedMissingFirestore = await definitiveMissingPayments(missingCandidates);
  const paidOrders = firestoreOrders.filter(row => ['paid', 'partially_refunded'].includes(row.status));
  const startMs = Date.parse(`${startDate}+09:00`);
  const endMs = Date.parse(`${endDate}+09:00`);

  const paidMissingToss = paidOrders
    .filter(row => orderTime(row) >= startMs && orderTime(row) <= endMs && !tossByOrder.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      kind: row.kind,
      status: row.status,
      amount: numeric(row.amount),
      createdAt: iso(row.createdAt || row.approvedAt || row.requestedAt)
    }));

  const amountMismatches = paidOrders
    .filter(row => tossByOrder.has(row.id))
    .filter(row => Math.max(0, ...tossByOrder.get(row.id).map(tx => numeric(tx.amount))) !== numeric(row.amount))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      kind: row.kind,
      firestoreAmount: numeric(row.amount),
      tossAmounts: [...new Set(tossByOrder.get(row.id).map(tx => numeric(tx.amount)))].sort((a, b) => a - b)
    }));

  const missingPaymentSecret = paidOrders
    .filter(row => !secretIds.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      kind: row.kind,
      legacyFallbackPresent: Boolean(row.paymentKey),
      createdAt: iso(row.createdAt || row.approvedAt || row.requestedAt)
    }));

  const creditLedgerMissing = orders
    .filter(row => row.status === 'paid' && !creditLedgerMatches.matches.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      uidFingerprint: fingerprint(row.uid),
      userExists: userById.has(row.uid),
      amount: numeric(row.amount),
      credits: numeric(row.safeCredits || row.credits),
      createdAt: iso(row.createdAt)
    }));

  const creditLedgerMismatch = orders
    .filter(row => row.status === 'paid' && creditLedgerMatches.matches.has(row.id))
    .filter(row => numeric(creditLedgerMatches.matches.get(row.id).row.amount) !== numeric(row.safeCredits || row.credits))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      expected: numeric(row.safeCredits || row.credits),
      ledger: numeric(creditLedgerMatches.matches.get(row.id).row.amount),
      matchReason: creditLedgerMatches.matches.get(row.id).reason
    }));

  const subscriptionLedgerMissing = subscriptions
    .filter(row => row.status === 'paid' && !grantsByOrder.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      uidFingerprint: fingerprint(row.uid),
      userExists: userById.has(row.uid),
      amount: numeric(row.amount),
      createdAt: iso(row.approvedAt || row.requestedAt)
    }));

  const uidMismatches = [];
  for (const row of orders.filter(row => row.status === 'paid')) {
    const matched = creditLedgerMatches.matches.get(row.id)?.row;
    if (matched && matched.uid !== row.uid) {
      uidMismatches.push({ fingerprint: fingerprint(row.id), kind: 'credit' });
    }
  }
  for (const row of subscriptions.filter(row => row.status === 'paid')) {
    if ((grantsByOrder.get(row.id) || []).some(history => history.uid !== row.uid)) {
      uidMismatches.push({ fingerprint: fingerprint(row.id), kind: 'subscription' });
    }
  }

  const orphanChargeLedgers = [...chargesByOrder.entries()]
    .filter(([orderId]) => !firestoreById.has(orderId))
    .map(([orderId, rows]) => ({ fingerprint: fingerprint(orderId), rows: rows.length, amount: rows.reduce((sum, row) => sum + numeric(row.amount), 0) }));
  for (const row of creditLedgerMatches.unusedCharges.filter(row => !row.orderId)) {
    orphanChargeLedgers.push({
      rowFingerprint: fingerprint(`${row.uid}:${row.id}`),
      uidFingerprint: fingerprint(row.uid),
      amount: numeric(row.amount),
      createdAt: iso(row.createdAt)
    });
  }

  const continuity = auditCreditContinuity(ledgerByUid, userSnapshot.docs);
  const incidentTransactions = transactions.filter(row => Date.parse(row.transactionAt || '') >= INCIDENT_STARTED_AT_MS);
  const incidentOwnedTransactions = incidentTransactions.filter(row => orderKind(row.orderId) !== 'other');
  const intents = intentSnapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
  const unresolvedIntents = intents.filter(row => row.status !== 'applied' && row.status !== 'confirm_failed');

  return {
    readOnly: true,
    checkedAt: new Date().toISOString(),
    window: { start: startDate, end: endDate },
    toss: {
      pages: tossResult.pages,
      transactions: transactions.length,
      uniqueOrders: tossByOrder.size,
      firstAt: transactions[0]?.transactionAt || null,
      lastAt: transactions.at(-1)?.transactionAt || null,
      statuses: groupedCounts(transactions, 'status'),
      ownedTransactionRows: transactions.filter(row => orderKind(row.orderId) !== 'other').length,
      ownedUniqueOrders: ownedTossGroups.length,
      ownedMissingFirestoreCandidates: missingCandidates.length,
      definitiveApprovedMissingFirestore: summarizedList(approvedMissingFirestore)
    },
    incident: {
      startedAt: new Date(INCIDENT_STARTED_AT_MS).toISOString(),
      transactionRows: incidentTransactions.length,
      ownedTransactionRows: incidentOwnedTransactions.length,
      ownedUniqueOrders: new Set(incidentOwnedTransactions.map(row => row.orderId)).size,
      statuses: groupedCounts(incidentOwnedTransactions, 'status')
    },
    firestore: {
      users: userSnapshot.size,
      orders: orders.length,
      subscriptionOrders: subscriptions.length,
      paymentSecrets: secretSnapshot.size,
      paymentIntents: intents.length,
      paymentIntentStatuses: groupedCounts(intents, 'status'),
      ledgerScanSource: ledgers.source,
      creditHistoryRows: ledgers.creditHistory.length,
      chargeLedgerRows: charges.length,
      chargeLedgersWithOrderId: creditLedgerMatches.chargesWithOrderId,
      chargeLedgerMatchReasons: creditLedgerMatches.reasons,
      couponHistoryRows: ledgers.couponHistory.length,
      couponGrantRows: couponGrants.length,
      orderStatuses: groupedCounts(orders, 'status'),
      subscriptionStatuses: groupedCounts(subscriptions, 'status'),
      earliestCreditOrder: orders.map(row => iso(row.createdAt)).filter(Boolean).sort()[0] || null,
      earliestSubscriptionOrder: subscriptions.map(row => iso(row.approvedAt || row.requestedAt)).filter(Boolean).sort()[0] || null,
      failedSubscriptionOrders: summarizedList(subscriptions
        .filter(row => row.status === 'failed')
        .map(row => ({
          fingerprint: fingerprint(row.id),
          uidFingerprint: fingerprint(row.uid),
          amount: numeric(row.amount),
          requestedAt: iso(row.requestedAt),
          reason: String(row.failReason || 'unknown').slice(0, 120)
        })))
    },
    mismatches: {
      paidMissingToss: summarizedList(paidMissingToss),
      amountMismatches: summarizedList(amountMismatches),
      missingPaymentSecret: summarizedList(missingPaymentSecret),
      creditLedgerMissing: summarizedList(creditLedgerMissing),
      creditLedgerMismatch: summarizedList(creditLedgerMismatch),
      subscriptionLedgerMissing: summarizedList(subscriptionLedgerMissing),
      uidMismatches: summarizedList(uidMismatches),
      unresolvedPaymentIntents: summarizedList(unresolvedIntents.map(row => ({
        fingerprint: fingerprint(row.id),
        uidFingerprint: fingerprint(row.uid),
        status: String(row.status || 'unknown'),
        amount: numeric(row.amount),
        updatedAt: iso(row.updatedAt || row.createdAt)
      }))),
      orphanChargeLedgers: summarizedList(orphanChargeLedgers),
      creditContinuityViolations: summarizedList(continuity.violations),
      currentBalanceVsLatestLedger: summarizedList(continuity.currentBalanceMismatches)
    }
  };
}

if (require.main === module) {
  run()
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => {
      console.error(JSON.stringify({ auditError: String(error?.stack || error) }));
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await admin?.app()?.delete(); } catch {}
    });
}

module.exports = {
  auditCreditContinuity,
  canonicalCreditDelta,
  fingerprint,
  groupedCounts,
  orderKind,
  parseArgs,
  requiredDate,
  run,
  summarizedList,
  timestampMs
};
