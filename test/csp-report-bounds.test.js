const test = require('node:test'), assert = require('node:assert/strict');
const csp = require('../lib/cspReport');
test('repeated browser reports log once per type while exact totals and enforcement remain visible', () => {
  csp.resetForTest(); const infos = [], warnings = [];
  const logger = { info: (e, data) => infos.push({ e, data }), warn: (e, data) => warnings.push({ e, data }) };
  const report = { directive: 'connect-src', blockedOrigin: 'https://example.test', disposition: 'report' };
  for (let i = 0; i < 10000; i++) csp.recordReport(report, { logger, now: 1000 });
  csp.recordReport({ ...report, disposition: 'enforce' }, { logger, now: 1000 });
  assert.equal(infos.length, 2);
  const s = csp.flush({ logger, now: 2000 });
  assert.equal(s.total, 10001); assert.equal(s.top[0].count, 10000); assert.equal(s.distinctTruncated, false);
  csp.recordReport(report, { logger, now: 3000 }); assert.equal(infos.length, 3); csp.resetForTest();
});
test('untrusted origin cardinality cannot grow memory or sample logs without bound', () => {
  csp.resetForTest(); let samples = 0, alerts = 0;
  const logger = { info: () => samples++, warn: e => { if (e === 'security.worker_blocked') alerts++; } };
  for (let i = 0; i < 2000; i++) csp.recordReport({ directive: 'connect-src', blockedOrigin: `https://h${i}.test`, disposition: 'report' }, { logger, now: 1000 });
  for (let i = 0; i < 100; i++) csp.recordReport({ directive: 'worker-src', blockedOrigin: `https://w${i}.test`, disposition: 'enforce' }, { logger, now: 1000 });
  const s = csp.flush({ now: 2000 });
  assert.equal(samples, csp.MAX_KEYS); assert.equal(alerts, 1); assert.equal(s.distinct, csp.MAX_KEYS);
  assert.equal(s.distinctTruncated, true); assert.equal(s.total, 2100);
  assert.equal(s.overflow.report, 2000 - csp.MAX_KEYS); assert.equal(s.overflow.enforce, 100); csp.resetForTest();
});
