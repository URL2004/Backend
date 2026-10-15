'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.LOG_LEVEL = 'fatal';
delete process.env.FIREBASE_SERVICE_ACCOUNT; delete process.env.DEV_NO_AUTH;
const express = require('express'), config = require('../config'), billing = require('../lib/usageBilling');
const { createJobDiscovery } = require('../lib/transformJobDiscovery');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const text = '도서관에서 모은 자료를 다시 읽었다. 처음에는 설명이 어렵게 느껴졌지만 여러 사례를 살펴보며 내용을 이해했다. 집에 돌아온 뒤에는 내가 관찰한 장면을 노트에 정리했다.';
config.verifyToken = async token => token;
billing.authenticate = async token => ({ uid: token });
// A mistaken post-drain launch must fail locally before any provider call.
require('../routes/analyze-gpt').runHumanizeChunked = async () => { throw new Error('UNEXPECTED_PROVIDER_START'); };

function database() {
  const rows = new Map(), committed = deferred(), release = deferred(); let count = 0;
  const snap = key => ({ id: key.split('/').at(-1), exists: rows.has(key), data: () => structuredClone(rows.get(key)) });
  const db = { rows, committed, release, collection(name) {
    let statuses = null, after = '', size = 500;
    const query = { orderBy() { return query; }, where(_field, _operator, values) { statuses = values; return query; },
      startAfter(value) { after = value.id; return query; }, limit(value) { size = value; return query; },
      async get() { return { docs: [...rows.keys()].filter(key => key.startsWith(name + '/') && key.split('/').at(-1) > after && (!statuses || statuses.includes(rows.get(key).status))).sort().slice(0, size).map(snap) }; },
      doc(id) { const key = name + '/' + id; return { key, get: async () => snap(key), set: async (value, options) => rows.set(key, options?.merge ? { ...rows.get(key), ...value } : value), delete: async () => rows.delete(key) }; } };
    return query;
  }, async runTransaction(fn) {
    const writes = [];
    const result = await fn({ get: async ref => snap(ref.key), set: (ref, value, options) => writes.push({ ref, value, options }) });
    for (const { ref, value, options } of writes) await ref.set(structuredClone(value), options);
    if (++count === 1) { committed.resolve(); await release.promise; }
    return result;
  } };
  return db;
}
async function appFor(db) {
  config.db = db; delete require.cache[require.resolve('../routes/transform')];
  const router = require('../routes/transform'); await turn();
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { router, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    post: () => fetch('http://127.0.0.1:' + server.address().port + '/transform', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-drain-owner' },
      body: JSON.stringify({ text, mode: 'polish', effectNoticeAccepted: true }) }) };
}

test('drain during billing precheck is visible in stats and rejects before persisting/launching', async () => {
  const entered = deferred(), release = deferred();
  billing.precheckCredits = async () => { entered.resolve(); await release.promise; return { uid: 'synthetic-drain-owner', plan: 'free' }; };
  const app = await appFor(null);
  try {
    const pending = app.post(); await entered.promise;
    assert.equal(app.router.stats().pendingAdmissions, 1);
    const shutdown = app.router.shutdown(); assert.equal(app.router.stats().draining, true);
    release.resolve(); const response = await pending; await response.json(); await shutdown;
    assert.equal(response.status, 503); assert.equal(app.router.stats().totalJobs, 0); assert.equal(app.router.stats().pendingAdmissions, 0);
  } finally { release.resolve(); await app.close(); }
});

test('commit already in flight during drain stays durably accepted and is discoverable after the replacement startup scan', async () => {
  const db = database(), discovered = [];
  const replacement = createJobDiscovery({ db, onJob: row => discovered.push(row.id) });
  await replacement.scan(); assert.equal(discovered.length, 0);
  billing.precheckCredits = async () => ({ uid: 'synthetic-drain-owner', plan: 'free' });
  const app = await appFor(db);
  try {
    const pending = app.post(); await db.committed.promise;
    assert.equal(app.router.stats().pendingAdmissions, 1); assert.equal(app.router.stats().totalJobs, 0);
    const shutdown = app.router.shutdown(); db.release.resolve();
    const response = await pending, body = await response.json(); await shutdown;
    assert.equal(response.status, 200); assert.equal(body.status, 'queued');
    assert.equal(app.router.stats().draining, true); assert.equal(app.router.stats().activeJobs, 0);
    assert.equal(app.router.stats().totalJobs, 1); assert.equal(app.router.stats().pendingAdmissions, 0);
    await replacement.scan(); assert.deepEqual(discovered, [body.jobId]);
    assert.equal(db.rows.get('transformJobs/' + body.jobId).status, 'queued');
  } finally { db.release.resolve(); await app.close(); }
});
