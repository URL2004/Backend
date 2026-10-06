'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summaryOptions, aggregateSignupAttribution, scanSignupAccounts } = require('../lib/signupAttributionSummary');
const now = Date.parse('2026-10-06T03:00:00Z');
const options = summaryOptions({ days: 7 }, now);
const touch = (content, source = 'instagram') => ({ source, medium: 'social', campaign: 'signup_test', content });
const account = (id, first, last = first) => ({ id, data: { createdAt: '2026-10-05T12:00:00Z', email: 'private@example.com', signupAttribution: { first_touch: first, last_touch: last } } });

test('calendar windows use Korean midnight and reject unsupported controls', () => {
  assert.equal(options.since, '2026-09-29T15:00:00.000Z');
  assert.equal(options.touch, 'last_touch');
  for (const body of [null, [], { days: 1000 }, { touch: 'all' }, { days: '1;DROP' }]) assert.throws(() => summaryOptions(body, now), error => error.status === 400);
});

test('both attribution bases count unique accounts and keep unrecorded separate from direct', () => {
  const rows = [account('one', touch('video_01'), touch('video_02')), account('two', touch('video_01')), account('two', touch('video_01')), account('admin', touch('video_01')), account('missing'), account('direct', touch('', 'direct'))];
  rows.push({ id: 'old', data: { createdAt: '2026-01-01T00:00:00Z' } });
  rows.push({ id: 'future', data: { createdAt: '2027-01-01T00:00:00Z' } });
  const last = aggregateSignupAttribution(rows, { ...options, excludedUids: ['admin'] });
  assert.equal(last.total, 4);
  assert.equal(last.unrecorded, 1);
  assert.equal(last.groups.find(row => row.content === 'video_01').signups, 1);
  const first = aggregateSignupAttribution(rows, { ...options, touch: 'first_touch', excludedUids: ['admin'] });
  assert.equal(first.groups.find(row => row.content === 'video_01').signups, 2);
  assert.equal(first.groups.reduce((sum, row) => sum + row.signups, 0), first.recorded);
  assert.equal(JSON.stringify(first).includes('private@example.com'), false);
  assert.equal(JSON.stringify(first).includes('signupAttribution'), false);
});

test('channels and campaigns do not merge when content names match; partial totals are marked', () => {
  const summary = aggregateSignupAttribution([account('a', touch('same')), account('b', touch('same', 'naver'))], { ...options, truncated: true });
  assert.equal(summary.groups.length, 2);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.truncated, true);
});

function database(rows) {
  const observations = { pages: 0, fields: null };
  return { observations, collection(name) {
    assert.equal(name, 'users');
    let offset = 0;
    let count = 0;
    const query = {
      where() { return this; }, orderBy() { return this; },
      select(...fields) { observations.fields = fields; return this; },
      startAfter(cursor) { offset = rows.findIndex(row => row.id === cursor.id) + 1; return this; },
      limit(value) { count = value; return this; },
      async get() { observations.pages += 1; return { docs: rows.slice(offset, offset + count).map(row => ({ id: row.id, data: () => row.data })) }; }
    };
    return query;
  } };
}

test('database scan paginates and uses one extra record to detect incomplete counts', async () => {
  const rows = Array.from({ length: 502 }, (_, i) => account(String(i), touch('video_01')));
  const db = database(rows);
  const result = await scanSignupAccounts({ database: db, ...options, limit: 501 });
  assert.equal(result.accounts.length, 501);
  assert.equal(result.truncated, true);
  assert.equal(db.observations.pages, 2);
  assert.deepEqual(db.observations.fields, ['createdAt', 'signupAttribution']);
  const exact = await scanSignupAccounts({ database: database(rows), ...options, limit: 502 });
  assert.equal(exact.truncated, false);
  await assert.rejects(scanSignupAccounts({ database: null, ...options }));
});

test('summary API requires a verified admin and returns aggregate data only', async t => {
  const express = require('express');
  const { createSignupAttributionRouter } = require('../routes/signupAttribution');
  const db = database([account('one', touch('video_01'))]);
  const app = express();
  app.use(express.json());
  app.use(createSignupAttributionRouter({ database: db, now: () => now, verifyAdmin: async token => token === 'admin' ? 'admin-user' : false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (token, body = {}) => fetch(`http://127.0.0.1:${server.address().port}/admin/signup-attribution-summary`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request('user')).status, 403);
  assert.equal(db.observations.pages, 0);
  assert.equal((await request('admin', { days: 1 })).status, 400);
  const res = await request('admin', { days: 7, touch: 'first_touch' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.groups[0].signups, 1);
  assert.equal(JSON.stringify(body).includes('private@example.com'), false);
});
