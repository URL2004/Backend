'use strict';

// Display policy only. Never use this predicate for balance/audit accounting.
const HIDDEN_CAMPAIGN = 'humanize-incident-20261002-100';
const HIDDEN_LEDGER_ID = 'admin_compensation_20261002_100';

function hiddenFromAdminLedger(row, id = row?.id || row?.creditHistoryId) {
  return row?.type === 'admin_adjust'
    && (row.campaignId === HIDDEN_CAMPAIGN || id === HIDDEN_LEDGER_ID);
}

async function collectVisibleAdminLedger(query, maxRows, { maxScanned = 50000, batchSize = 5000 } = {}) {
  const docs = [];
  let cursor = null;
  let scanned = 0;
  let hidden = 0;
  while (docs.length < maxRows && scanned < maxScanned) {
    const size = Math.min(hidden ? batchSize : maxRows, maxScanned - scanned);
    const page = await (cursor ? query.startAfter(cursor) : query).limit(size).get();
    for (const doc of page.docs) {
      scanned += 1;
      if (hiddenFromAdminLedger(doc.data(), doc.id)) hidden += 1;
      else docs.push(doc);
      if (docs.length === maxRows) break;
    }
    if (docs.length === maxRows || page.docs.length < size) return { docs, scanned, hidden };
    cursor = page.docs[page.docs.length - 1];
  }
  // Do not silently present a truncated/empty usage ledger as complete.
  const error = new Error('Admin ledger scan limit reached');
  error.code = 'ADMIN_LEDGER_SCAN_LIMIT';
  throw error;
}

// These two indexed streams exclude the mass grant before document reads.
// Ordinary adjustments (and legacy rows without a type) have an explicit display
// marker. Backfill that marker and wait for indexes before deploying this reader.
async function collectIndexedAdminLedger(collectionGroup, maxRows) {
  const started = Date.now();
  const pages = await Promise.all([
    collectionGroup.where('type', '!=', 'admin_adjust').orderBy('createdAt', 'desc').limit(maxRows).get(),
    collectionGroup.where('adminLedgerVisible', '==', true).orderBy('createdAt', 'desc').limit(maxRows).get()
  ]);
  const unique = new Map();
  for (const page of pages) for (const doc of page.docs) {
    if (!hiddenFromAdminLedger(doc.data(), doc.id)) unique.set(doc.ref.path, doc);
  }
  const docs = [...unique.values()].sort((a, b) => {
    const at = a.data().createdAt, bt = b.data().createdAt;
    return ((bt?.seconds || 0) - (at?.seconds || 0)) || ((bt?.nanoseconds || 0) - (at?.nanoseconds || 0))
      || (a.ref.path < b.ref.path ? 1 : a.ref.path > b.ref.path ? -1 : 0);
  }).slice(0, maxRows);
  return { docs, scanned: pages.reduce((n, p) => n + p.docs.length, 0), elapsedMs: Date.now() - started };
}

// Overview and ledger load concurrently. Share their reads and short cache.
function createAdminLedgerLoader(load, { ttlMs = 30000, now = Date.now } = {}) {
  const cache = new Map();
  return async function(maxRows) {
    const existing = cache.get(maxRows);
    if (existing && (existing.pending || existing.expires > now())) return existing.promise;
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    const entry = { pending: true, expires: 0 };
    entry.promise = Promise.resolve().then(() => load(maxRows)).then(result => {
      entry.pending = false;
      entry.expires = now() + ttlMs;
      return result;
    }, error => {
      if (cache.get(maxRows) === entry) cache.delete(maxRows);
      throw error;
    });
    cache.set(maxRows, entry);
    return entry.promise;
  };
}

module.exports = { hiddenFromAdminLedger, collectVisibleAdminLedger, collectIndexedAdminLedger, createAdminLedgerLoader };
