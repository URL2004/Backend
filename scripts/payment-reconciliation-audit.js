'use strict';

// Read-only production reconciliation between Toss transactions and Firestore.
// Required env: TOSS_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT.
// Output intentionally contains only aggregate counts and hashed identifiers.

const crypto = require('crypto');
const { admin, db, ADMIN_UIDS = [] } = require('../config');
const {
  providerCanceledAmount,
  refundedCreditsForCanceledAmount
} = require('../lib/paymentReconciliation');

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

  // Explicit orderId links are authoritative.
  for (const order of sortedOrders) {
    const exact = (exactByOrder.get(order.id) || []).find(row => !used.has(keyFor(row)));
    if (!exact) continue;
    used.add(keyFor(exact));
    matches.set(order.id, { row: exact, reason: 'orderId' });
  }

  // Legacy rows have no orderId. Assign the globally closest eligible pair instead of
  // greedily consuming a row that is an even closer match for the following order.
  function assignNearby({ requireAmount, reason }) {
    const candidates = [];
    for (const order of sortedOrders) {
      if (matches.has(order.id)) continue;
      const expected = numeric(order.safeCredits || order.credits);
      const at = orderTime(order);
      for (const row of byUid.get(order.uid) || []) {
        if (used.has(keyFor(row))) continue;
        if (requireAmount && numeric(row.amount) !== expected) continue;
        const distanceMs = Math.abs(timestampMs(row.createdAt) - at);
        if (distanceMs <= 5 * 60 * 1000) candidates.push({ order, row, distanceMs });
      }
    }
    candidates.sort((a, b) => a.distanceMs - b.distanceMs || orderTime(a.order) - orderTime(b.order));
    for (const candidate of candidates) {
      if (matches.has(candidate.order.id) || used.has(keyFor(candidate.row))) continue;
      used.add(keyFor(candidate.row));
      matches.set(candidate.order.id, { row: candidate.row, reason });
    }
  }
  assignNearby({ requireAmount: true, reason: 'uid_amount_time' });
  assignNearby({ requireAmount: false, reason: 'uid_time_amount_mismatch' });

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

async function definitiveCancellationAudit(candidates, firestoreById, userById, refundLedgersByOrder) {
  return mapLimit(candidates, 5, async ([orderId]) => {
    try {
      const payment = await tossJson(`/v1/payments/orders/${encodeURIComponent(orderId)}`);
      const order = firestoreById.get(orderId) || null;
      const canceledAmount = providerCanceledAmount(payment);
      const purchasedCredits = numeric(order?.safeCredits || order?.credits);
      const expectedCredits = order?.kind === 'credit'
        ? refundedCreditsForCanceledAmount({
          orderAmount: order?.amount,
          purchasedCredits,
          canceledAmount
        })
        : 0;
      const ledgerCredits = (refundLedgersByOrder.get(orderId) || [])
        .filter(row => row.type === 'refund')
        .reduce((sum, row) => sum + Math.abs(Math.min(0, numeric(row.amount))), 0);
      const recordedCredits = Math.max(numeric(order?.refundedCredits), ledgerCredits);
      const uid = String(order?.uid || '');
      const currentCredits = numeric(userById.get(uid)?.credits);
      const creditGap = Math.max(0, expectedCredits - recordedCredits);
      return {
        fingerprint: fingerprint(orderId),
        uidFingerprint: uid ? fingerprint(uid) : null,
        adminLike: uid ? ADMIN_UIDS.includes(uid) : false,
        kind: order?.kind || orderKind(orderId),
        providerStatus: String(payment.status || 'unknown'),
        canceledAmount,
        firestoreExists: Boolean(order),
        firestoreStatus: String(order?.status || 'unknown'),
        orderAmount: numeric(order?.amount),
        storedRefundedAmount: Math.max(numeric(order?.refundedAmount), numeric(order?.refundAmount)),
        purchasedCredits,
        expectedCredits,
        recordedCredits,
        creditGap,
        userExists: uid ? userById.has(uid) : false,
        currentCredits,
        recoverableCreditsNow: Math.min(currentCredits, creditGap),
        unrecoverableCreditsNow: Math.max(0, creditGap - currentCredits),
        approvedAt: payment.approvedAt || null
      };
    } catch (error) {
      return {
        fingerprint: fingerprint(orderId),
        error: String(error?.message || error)
      };
    }
  });
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

  const [tossResult, orderSnapshot, subscriptionSnapshot, secretSnapshot, intentSnapshot, inboxSnapshot, userSnapshot] = await Promise.all([
    fetchTransactions(startDate, endDate),
    db.collection('orders').get(),
    db.collection('subscriptionOrders').get(),
    db.collection('paymentSecrets').get(),
    db.collection('paymentIntents').get(),
    db.collection('webhookInbox').get(),
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
  const refundLedgers = ledgers.creditHistory.filter(row => row.type === 'refund');
  const couponGrants = ledgers.couponHistory.filter(row => row.type === 'grant');
  const chargesByOrder = indexByOrder(charges);
  const refundLedgersByOrder = indexByOrder(refundLedgers);
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
  const cancellationCandidates = ownedTossGroups.filter(([, rows]) =>
    rows.some(row => ['CANCELED', 'PARTIAL_CANCELED'].includes(String(row.status || '')))
  );
  const [approvedMissingFirestore, cancellationAudit] = await Promise.all([
    definitiveMissingPayments(missingCandidates),
    definitiveCancellationAudit(cancellationCandidates, firestoreById, userById, refundLedgersByOrder)
  ]);
  const providerBackedOrders = firestoreOrders.filter(row => tossByOrder.has(row.id));
  const providerBackedCreditOrders = orders.filter(row => tossByOrder.has(row.id));
  const providerBackedSubscriptions = subscriptions.filter(row => tossByOrder.has(row.id));
  const firestorePaymentRecords = [
    ...orders,
    ...subscriptions.filter(row => !['failed', 'pending'].includes(String(row.status || '')))
  ];
  const startMs = Date.parse(`${startDate}+09:00`);
  const endMs = Date.parse(`${endDate}+09:00`);

  const paidMissingToss = firestorePaymentRecords
    .filter(row => orderTime(row) >= startMs && orderTime(row) <= endMs && !tossByOrder.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      kind: row.kind,
      status: row.status,
      amount: numeric(row.amount),
      createdAt: iso(row.createdAt || row.approvedAt || row.requestedAt)
    }));

  const amountMismatches = providerBackedOrders
    .filter(row => Math.max(0, ...tossByOrder.get(row.id).map(tx => numeric(tx.amount))) !== numeric(row.amount))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      kind: row.kind,
      firestoreAmount: numeric(row.amount),
      tossAmounts: [...new Set(tossByOrder.get(row.id).map(tx => numeric(tx.amount)))].sort((a, b) => a - b)
    }));

  const missingPaymentSecret = providerBackedOrders
    .filter(row => !secretIds.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      kind: row.kind,
      legacyFallbackPresent: Boolean(row.paymentKey),
      providerOrderLookupRecoverable: tossByOrder.has(row.id),
      createdAt: iso(row.createdAt || row.approvedAt || row.requestedAt)
    }));

  const creditLedgerMissing = providerBackedCreditOrders
    .filter(row => !creditLedgerMatches.matches.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      uidFingerprint: fingerprint(row.uid),
      userExists: userById.has(row.uid),
      amount: numeric(row.amount),
      credits: numeric(row.safeCredits || row.credits),
      createdAt: iso(row.createdAt)
    }));

  const creditLedgerMismatch = providerBackedCreditOrders
    .filter(row => creditLedgerMatches.matches.has(row.id))
    .filter(row => numeric(creditLedgerMatches.matches.get(row.id).row.amount) !== numeric(row.safeCredits || row.credits))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      expected: numeric(row.safeCredits || row.credits),
      ledger: numeric(creditLedgerMatches.matches.get(row.id).row.amount),
      matchReason: creditLedgerMatches.matches.get(row.id).reason
    }));

  const subscriptionLedgerMissing = providerBackedSubscriptions
    .filter(row => !grantsByOrder.has(row.id))
    .map(row => ({
      fingerprint: fingerprint(row.id),
      uidFingerprint: fingerprint(row.uid),
      userExists: userById.has(row.uid),
      amount: numeric(row.amount),
      createdAt: iso(row.approvedAt || row.requestedAt)
    }));

  const uidMismatches = [];
  for (const row of providerBackedCreditOrders) {
    const matched = creditLedgerMatches.matches.get(row.id)?.row;
    if (matched && matched.uid !== row.uid) {
      uidMismatches.push({ fingerprint: fingerprint(row.id), kind: 'credit' });
    }
  }
  for (const row of providerBackedSubscriptions) {
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
  const inboxRows = inboxSnapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
  const unresolvedInboxRows = inboxRows.filter(row => row.status !== 'processed');
  const completedCancellationAudit = cancellationAudit.filter(row => !row.error);
  const providerCancellationWithoutFirestore = completedCancellationAudit.filter(row => !row.firestoreExists);
  const providerCancellationStatusMismatch = completedCancellationAudit.filter(row => {
    if (!row.firestoreExists) return false;
    if (row.canceledAmount >= row.orderAmount) {
      return row.firestoreStatus !== 'refunded';
    }
    return !['partially_refunded', 'refunded'].includes(row.firestoreStatus);
  });
  const providerCancellationAmountMismatch = completedCancellationAudit
    .filter(row => row.firestoreExists && row.storedRefundedAmount > 0 && row.storedRefundedAmount !== row.canceledAmount);
  const unreconciledProviderCancellationCredits = completedCancellationAudit
    .filter(row => row.kind === 'credit' && row.userExists && row.creditGap > 0);
  const canceledOrderFingerprints = new Set(completedCancellationAudit.map(row => row.fingerprint));
  const strandedRefundPreDeductions = orders
    .filter(order => {
      const recordedLedgerCredits = (refundLedgersByOrder.get(order.id) || [])
        .reduce((sum, row) => sum + Math.abs(Math.min(0, numeric(row.amount))), 0);
      return numeric(order.refundedCredits) > recordedLedgerCredits
        && !canceledOrderFingerprints.has(fingerprint(order.id));
    })
    .map(order => ({
      fingerprint: fingerprint(order.id),
      uidFingerprint: fingerprint(order.uid),
      userExists: userById.has(order.uid),
      status: String(order.status || 'unknown'),
      refundedCredits: numeric(order.refundedCredits),
      createdAt: iso(order.createdAt)
    }));

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
      providerBackedCreditOrders: providerBackedCreditOrders.length,
      statuslessProviderBackedCreditOrders: providerBackedCreditOrders.filter(row => !row.status).length,
      subscriptionOrders: subscriptions.length,
      paymentSecrets: secretSnapshot.size,
      paymentIntents: intents.length,
      paymentIntentStatuses: groupedCounts(intents, 'status'),
      webhookInbox: inboxRows.length,
      webhookInboxStatuses: groupedCounts(inboxRows, 'status'),
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
      unresolvedWebhookInbox: summarizedList(unresolvedInboxRows.map(row => ({
        fingerprint: fingerprint(row.id),
        eventType: String(row.eventType || 'unknown'),
        orderFingerprint: row.orderId ? fingerprint(row.orderId) : null,
        status: String(row.status || 'unknown'),
        receivedAt: iso(row.receivedAt),
        retryAt: iso(row.retryAt)
      }))),
      orphanChargeLedgers: summarizedList(orphanChargeLedgers),
      providerCancellationWithoutFirestore: summarizedList(providerCancellationWithoutFirestore),
      providerCancellationStatusMismatch: summarizedList(providerCancellationStatusMismatch),
      providerCancellationAmountMismatch: summarizedList(providerCancellationAmountMismatch),
      unreconciledProviderCancellationCredits: summarizedList(unreconciledProviderCancellationCredits),
      strandedRefundPreDeductions: summarizedList(strandedRefundPreDeductions),
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
  matchCreditLedgers,
  orderKind,
  parseArgs,
  requiredDate,
  run,
  summarizedList,
  timestampMs
};
