'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { recentTypedHistory } = require('../lib/recentTypedHistory');
const calibration = require('../lib/detectCalibration');
function database(rows, { indexed = false, error } = {}) {
  const reads = []; let indexReads = 0;
  const query = (type = null, cursor = -1, count = 100) => ({
    where: (_f, _op, value) => query(value), orderBy() { return this; }, select() { return this; },
    limit(n) { return query(type, cursor, n); }, startAfter(doc) { return query(type, Number(doc.id), count); },
    async get() {
      if (type) { indexReads++; if (error) throw error; if (!indexed) throw Object.assign(new Error('requires an index'), { code: 9 }); }
      const eligible = rows.map((value, i) => ({ id: String(i), data: () => ({ type: value }) })).filter(d => Number(d.id) > cursor && (!type || d.data().type === type));
      const docs = eligible.slice(0, count); reads.push({ type, count, size: docs.length }); return { docs };
    }
  });
  return { history: query(), reads, db: {}, indexReads: () => indexReads };
}
test('new indexed query returns 500 own humanizing rows despite thousands of detection rows', async () => {
 const h = database([...Array(2100).fill('detect'), ...Array(601).fill('humanize')], { indexed: true });
 const rows = await recentTypedHistory({ ...h, type: 'humanize', limit: 500, fields: ['type'] });
 assert.equal(rows.length, 500); assert.equal(rows[0].id, '2100'); assert.equal(h.reads.length, 1);
});
test('missing composite index pages the existing time index, retains type budget, and caches only the index miss', async () => {
 const h = database([...Array(350).fill('detect'), ...Array(550).fill('humanize')]);
 const options = { ...h, type: 'humanize', limit: 500, fields: ['type'] };
 const first = await recentTypedHistory(options); const second = await recentTypedHistory(options);
 assert.equal(first.length, 500); assert.equal(first[0].id, '350'); assert.deepEqual(first.map(x => x.id), second.map(x => x.id));
 assert.equal(h.indexReads(), 1); assert.ok(h.reads.every(r => r.count <= 100));
});
test('legacy scan is bounded and does not turn outages or permission failures into successful no-match', async () => {
 const h = database(Array(5000).fill('detect'));
 assert.equal((await recentTypedHistory({ ...h, type: 'humanize', limit: 1000, fields: [] })).length, 0);
 assert.equal(h.reads.reduce((a, r) => a + r.size, 0), 4000);
 for (const code of [7, 14, 9]) {
  const bad = database([], { error: Object.assign(new Error('database unavailable'), { code }) });
  await assert.rejects(recentTypedHistory({ ...bad, type: 'humanize', limit: 500, fields: [] }));
 }
});
test('stronger policy decreases monotonically, preserves zero and floor, and never raises the raw score', () => {
 const next = calibration.sanitizeConfig({ enabled: true, limit: 500, factor: .5, maxReduction: 40, floor: 10 });
 const old = { ...next, factor: .4, maxReduction: 30 };
 for (let raw = 0; raw <= 100; raw++) {
  const score = calibration.calibratedProbability(raw, next);
  assert.ok(score <= raw && score <= calibration.calibratedProbability(raw, old));
  assert.ok(score >= Math.min(raw, 10));
  if (raw) assert.ok(score >= calibration.calibratedProbability(raw - 1, next));
 }
 assert.equal(calibration.calibratedProbability(63, next), 31);
 assert.equal(calibration.calibratedProbability(80, next), 40);
 assert.equal(next.limit, 500);
});
