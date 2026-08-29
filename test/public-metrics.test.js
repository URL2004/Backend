'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const express = require('express');
const {
  METRICS_COLLECTION,
  METRICS_DOCUMENT,
  EVENT_COLLECTION,
  readPublicMetrics,
  recordCompletedJob,
  trackDeliveredMetric
} = require('../lib/publicMetrics');
const { createPublicMetricsRouter } = require('../routes/publicMetrics');

function fakeDb(initial = {}) {
  const documents = new Map(Object.entries(initial));
  const snapshot = ref => {
    const exists = documents.has(ref.path);
    return { exists, data: () => (exists ? documents.get(ref.path) : undefined) };
  };
  const database = {
    collection(name) {
      return {
        doc(id) {
          const ref = { path: `${name}/${id}` };
          ref.get = async () => snapshot(ref);
          return ref;
        }
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: async ref => snapshot(ref),
        set(ref, value, options = {}) {
          writes.push({ ref, value, merge: options.merge === true });
        }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const previous = documents.get(write.ref.path) || {};
        documents.set(write.ref.path, write.merge
          ? { ...previous, ...write.value }
          : write.value);
      }
      return result;
    }
  };
  database.documents = documents;
  return database;
}

function aggregatePath() {
  return `${METRICS_COLLECTION}/${METRICS_DOCUMENT}`;
}

test('작업 ID 이벤트 마커와 트랜잭션으로 완료 작업을 한 번만 집계한다', async () => {
  const db = fakeDb({
    [aggregatePath()]: {
      schemaVersion: 1,
      verified: true,
      since: new Date('2026-01-01T00:00:00.000Z'),
      asOf: new Date('2026-08-01T00:00:00.000Z'),
      totals: { processedCharacters: 1200, completedJobs: 4 }
    }
  });
  const input = {
    db,
    operation: 'humanize',
    eventId: 'job-123',
    uid: 'user-1',
    processedCharacters: 800,
    now: () => new Date('2026-08-29T02:30:00.000Z')
  };

  const first = await recordCompletedJob(input);
  const duplicate = await recordCompletedJob(input);

  assert.equal(first.recorded, true);
  assert.deepEqual(duplicate, {
    recorded: false,
    reason: 'duplicate',
    markerId: first.markerId
  });
  assert.equal([...db.documents.keys()].filter(path => path.startsWith(`${EVENT_COLLECTION}/`)).length, 1);
  assert.deepEqual(db.documents.get(aggregatePath()).totals, {
    processedCharacters: 2000,
    completedJobs: 5
  });
});

test('관리자·테스트·실패 입력은 공개 누계에서 제외한다', async () => {
  const db = fakeDb();
  const base = {
    db,
    operation: 'detect',
    eventId: 'detect-1',
    uid: 'user-1',
    processedCharacters: 300
  };

  assert.equal((await recordCompletedJob({ ...base, isAdmin: true })).reason, 'excluded_actor');
  assert.equal((await recordCompletedJob({ ...base, eventId: 'detect-2', isTest: true })).reason, 'excluded_actor');
  assert.equal((await recordCompletedJob({ ...base, eventId: 'detect-3', operation: 'refund' })).reason, 'invalid_operation');
  assert.equal((await recordCompletedJob({ ...base, eventId: 'detect-4', processedCharacters: 0 })).reason, 'invalid_character_count');
  assert.equal(db.documents.size, 0);
});

test('2xx로 실제 전달된 응답만 집계하고 오류 응답은 집계하지 않는다', async () => {
  const db = fakeDb();
  const success = new EventEmitter();
  success.statusCode = 200;
  trackDeliveredMetric(success, {
    operation: 'detect',
    eventId: 'delivery-1',
    uid: 'user-1',
    processedCharacters: 250
  }, { db });
  success.emit('finish');
  await new Promise(resolve => setImmediate(resolve));

  const failure = new EventEmitter();
  failure.statusCode = 500;
  trackDeliveredMetric(failure, {
    operation: 'detect',
    eventId: 'delivery-2',
    uid: 'user-1',
    processedCharacters: 999
  }, { db });
  failure.emit('finish');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(db.documents.get(aggregatePath()).totals, {
    processedCharacters: 250,
    completedJobs: 1
  });
});

test('검증 전에는 503과 verified:false를 반환한다', async () => {
  const missing = await readPublicMetrics({ db: fakeDb() });
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.body, {
    schemaVersion: 1,
    verified: false,
    since: null,
    asOf: null,
    totals: { processedCharacters: 0, completedJobs: 0 }
  });

  const unverifiedDb = fakeDb({
    [aggregatePath()]: {
      schemaVersion: 1,
      verified: false,
      since: new Date('2026-01-01T00:00:00.000Z'),
      asOf: new Date('2026-08-29T00:00:00.000Z'),
      totals: { processedCharacters: 900, completedJobs: 3 }
    }
  });
  const unverified = await readPublicMetrics({ db: unverifiedDb });
  assert.equal(unverified.status, 503);
  assert.equal(unverified.body.verified, false);
  assert.deepEqual(unverified.body.totals, { processedCharacters: 900, completedJobs: 3 });
});

test('검증된 집계는 exact public schema와 ISO-8601 날짜로 노출한다', async t => {
  const db = fakeDb({
    [aggregatePath()]: {
      schemaVersion: 1,
      verified: true,
      since: new Date('2026-01-01T00:00:00.000Z'),
      asOf: { toDate: () => new Date('2026-08-29T05:10:00.000Z') },
      totals: { processedCharacters: 12345, completedJobs: 67 }
    }
  });
  const result = await readPublicMetrics({ db });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    schemaVersion: 1,
    verified: true,
    since: '2026-01-01T00:00:00.000Z',
    asOf: '2026-08-29T05:10:00.000Z',
    totals: { processedCharacters: 12345, completedJobs: 67 }
  });

  const app = express();
  app.use(createPublicMetricsRouter({ database: db, routeLogger: { warn() {} } }));
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/public/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /max-age=60/u);
  assert.deepEqual(await response.json(), result.body);
});
