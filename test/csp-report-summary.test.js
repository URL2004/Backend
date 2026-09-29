'use strict';
// 2026-09-29: /csp-report가 CORS(Origin: null 거절) 뒤에 있어 하루 3,450건이 전부 403 → 위반 내용이 0건 기록.
// 라우트를 CORS 앞으로 옮기고, 건별 info + 1시간 집계(security.csp_violation_summary)를 남긴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cspReport = require('../lib/cspReport');

test('server.js는 /csp-report를 corsMiddleware보다 먼저 마운트한다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const cspAt = source.indexOf("app.post('/csp-report'");
  const corsAt = source.indexOf('app.use(corsMiddleware)');
  const contextAt = source.indexOf('app.use(requestContext)');
  assert.ok(cspAt > 0 && corsAt > 0 && contextAt > 0);
  assert.ok(contextAt < cspAt, 'requestId가 붙도록 requestContext 뒤여야 한다');
  assert.ok(cspAt < corsAt, 'Origin: null 보고가 거절되지 않도록 CORS 앞이어야 한다');
  assert.match(source.slice(cspAt, cspAt + 600), /recordReport\(/u, '집계기에 보고를 넘겨야 한다');
});

test('보고를 (directive, blockedOrigin)별로 세고 1시간 창이 지나면 집계 한 줄을 warn으로 남긴다', () => {
  cspReport.resetForTest();
  const logs = [];
  const logger = { warn: (event, fields) => logs.push({ event, fields }) };
  let now = Date.parse('2026-09-29T00:00:00Z');
  const report = (blocked, directive = 'script-src') => cspReport.summarizeReport({ 'csp-report': { 'effective-directive': directive, 'blocked-uri': blocked, 'document-uri': 'https://gpkorea.ai.kr/' } });

  for (let i = 0; i < 5; i++) cspReport.recordReport(report('chrome-extension://abc/executors/200.js'), { logger, now });
  cspReport.recordReport(report('https://cdn.example.com/x.js', 'style-src'), { logger, now: now + 60e3 });
  assert.equal(logs.length, 0, '창 안에서는 집계를 내지 않는다');

  now += cspReport.SUMMARY_WINDOW_MS + 1000;
  cspReport.recordReport(report('inline'), { logger, now });
  assert.equal(logs.length, 1, '창이 지난 뒤 첫 보고에서 지난 창을 흘려보낸다');
  const summary = logs[0];
  assert.equal(summary.event, 'security.csp_violation_summary');
  assert.equal(summary.fields.total, 6);
  assert.equal(summary.fields.distinct, 2);
  assert.equal(summary.fields.top[0].blockedOrigin, 'chrome-extension://abc');
  assert.equal(summary.fields.top[0].count, 5);
  assert.equal(summary.fields.top[1].directive, 'style-src');
  assert.equal(summary.fields.noAlert, true);
  assert.match(summary.fields.message, /6건/u);

  // 새 창에는 방금 들어온 1건만 남아 있다.
  const flushed = cspReport.flush({ logger, now: now + cspReport.SUMMARY_WINDOW_MS });
  assert.equal(flushed.total, 1);
  assert.equal(flushed.top[0].blockedOrigin, 'inline');
  assert.equal(cspReport.flush({ logger, now }), null, '빈 창은 아무것도 남기지 않는다');
});
