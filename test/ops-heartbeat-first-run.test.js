'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const docs = new Map(); let failReads = false, writes = 0;
const db = {
  collection: () => ({ doc: id => ({ id, set: async value => docs.set(id, { ...docs.get(id), ...value }) }),
    get: async () => { if (failReads) throw Error('offline'); return { forEach: fn => docs.forEach((data, id) => fn({ id, data: () => data })) }; } }),
  runTransaction: async fn => fn({ get: async ref => ({ exists: docs.has(ref.id), data: () => docs.get(ref.id) }),
    set: (ref, value) => { writes++; docs.set(ref.id, { ...docs.get(ref.id), ...value }); } })
};
const configPath = require.resolve('../config');
require.cache[configPath] = { id: configPath, loaded: true, exports: { db } };
const beats = require('../lib/opsHeartbeat');
test('never-run scheduler becomes stale after a persisted grace period, without restart renewal', async () => {
  const old = Date.now() - 2200 * 60000;
  await beats.ensureMonitoring({ db, nowMs: old }); await beats.ensureMonitoring({ db });
  assert.equal(writes, 3);
  assert.ok((await beats.readAll()).every(b => b.state === 'stale' && b.neverCompleted));
  await beats.beat('ops.digest');
  assert.equal((await beats.readAll()).find(b => b.name === 'ops.digest').state, 'ok');
  failReads = true;
  assert.ok((await beats.readAll()).every(b => b.state === 'unknown' && b.observation === 'storage_unavailable'));
  failReads = false; process.env.OPS_DISABLED_HEARTBEATS = 'revenue.daily_report';
  assert.equal((await beats.readAll()).find(b => b.name === 'revenue.daily_report').state, 'disabled');
  delete process.env.OPS_DISABLED_HEARTBEATS;
});
