'use strict';
const { COLLECTION, DOCUMENT, live, keyOf } = require('./transformExecution');

// One bounded page per tick. Timed-out SDK reads lose authority before the
// next scan. Startup alone misses work accepted later by an older instance.
function createJobDiscovery({ db, onJob, enabled = () => true, clock = Date.now, pageSize = 100,
  timeoutMs = 10000, timers = { setTimeout, clearTimeout } }) {
  let cursor = null, pending = null, generation = 0;
  async function scan() {
    if (!db || !enabled() || pending) return false;
    const token = ++generation;
    const current = () => token === generation && enabled();
    let timer;
    const operation = (async () => {
      let query = db.collection('transformJobs').where('status', 'in', ['queued', 'running'])
        .orderBy('__name__').limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const [page, leaseSnapshot] = await Promise.all([
        query.get(), db.collection(COLLECTION).doc(DOCUMENT).get()
      ]);
      if (!current()) return false;
      const slots = live(leaseSnapshot.exists ? leaseSnapshot.data().slots : {}, clock());
      for (const doc of page.docs) {
        if (!current()) break;
        if (!slots[keyOf(doc.id)]) await onJob({ ...doc.data(), id: doc.id });
      }
      if (current()) cursor = page.docs.length === pageSize ? page.docs.at(-1) : null;
      return true;
    })();
    const bounded = Promise.race([operation, new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        if (token === generation) generation++;
        reject(Object.assign(new Error('Job discovery timed out'), { code: 'TRANSFORM_DISCOVERY_TIMEOUT' }));
      }, timeoutMs);
    })]);
    pending = bounded;
    try { return await bounded; }
    catch (error) { cursor = null; throw error; }
    finally { timers.clearTimeout(timer); if (pending === bounded) pending = null; }
  }
  return { scan };
}
module.exports = { createJobDiscovery };
