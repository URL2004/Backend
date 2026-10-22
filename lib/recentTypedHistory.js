'use strict';

// An optional composite index speeds up legacy history lookup. Existing
// installations can safely page their current createdAt index while it builds.
const missingTypeIndex = new WeakMap();
async function recentTypedHistory({ db, history, type, limit, fields, legacyLimit = limit * 4 }) {
  const maximum = Math.min(4000, Math.max(limit, legacyLimit));
  if (typeof history.where === 'function' && (!db || (missingTypeIndex.get(db) || 0) < Date.now())) {
    try {
      return (await history.where('type', '==', type).orderBy('createdAt', 'desc')
        .limit(limit).select(...fields).get()).docs;
    } catch (error) {
      // Missing-index is the only fallback condition. Outages and permission
      // failures must still propagate, never become an unadjusted paid result.
      if (!(error?.code === 9 || error?.code === 'failed-precondition') || !/index/i.test(error.message || '')) throw error;
      if (db) missingTypeIndex.set(db, Date.now() + 300000);
    }
  }
  const rows = []; let cursor = null, scanned = 0;
  while (scanned < maximum && rows.length < limit) {
    let q = history.orderBy('createdAt', 'desc');
    const paged = typeof q.startAfter === 'function';
    const size = paged ? Math.min(100, maximum - scanned) : maximum;
    if (cursor) q = q.startAfter(cursor);
    q = q.limit(size);
    if (typeof q.select === 'function') q = q.select(...new Set([...fields, 'type', 'createdAt']));
    const page = await q.get();
    for (const doc of page.docs) { if (doc.data()?.type === type && rows.length < limit) rows.push(doc); }
    scanned += page.docs.length;
    if (!paged || page.docs.length < size) break;
    const next = page.docs.at(-1);
    if (cursor && cursor.id === next?.id) throw new Error('History pagination did not advance');
    cursor = next;
  }
  return rows;
}
module.exports = { recentTypedHistory };
