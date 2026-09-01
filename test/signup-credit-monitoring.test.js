'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {
  DAY_MS,
  EVENT_RETENTION_DAYS,
  SIGNUP_CREDIT_EVENT_COLLECTION,
  aggregateSignupCreditEvents,
  buildSignupCreditEvent,
  scanSignupCreditEvents,
  signupCreditAccountKey,
  signupCreditPrincipalKey
} = require('../lib/signupCreditMonitoring');
const { createSignupCreditMonitoringRouter } = require('../routes/signupCreditMonitoring');
const { main: runReport } = require('../scripts/report-signup-credit-usage');
const { SIGNUP_GRANT_CREDITS } = require('../lib/clientWriteService');

const NOW_MS = Date.parse('2026-09-01T12:00:00.000Z');
const TIMESTAMP = Object.freeze({ serverTimestamp: true });

function event({ type, uid, principal, amount, remaining, accountRemaining = remaining, op, mode, at }) {
  return buildSignupCreditEvent({
    eventType: type,
    accountKey: signupCreditAccountKey(uid),
    ...(principal ? { principalKey: signupCreditPrincipalKey(principal) } : {}),
    creditAmount: amount,
    signupCreditsRemaining: remaining,
    accountCreditsRemaining: accountRemaining,
    op,
    mode,
    occurredAtMs: at,
    occurredAt: TIMESTAMP
  });
}

function signupJourneyEvents() {
  const grantAt = NOW_MS - 2 * 60 * 60 * 1000;
  return [
    event({ type: 'grant', uid: 'uid-a', principal: 'principal-a', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: grantAt }),
    event({ type: 'spend', uid: 'uid-a', amount: 6, remaining: 14, op: 'detect', mode: 'detect', at: grantAt + 10 * 60_000 }),
    event({ type: 'spend', uid: 'uid-a', amount: 12, remaining: 2, op: 'humanize', mode: 'blog', at: grantAt + 20 * 60_000 }),
    event({ type: 'grant', uid: 'uid-b', principal: 'principal-a', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: NOW_MS - 60 * 60 * 1000 }),
    event({ type: 'grant', uid: 'uid-c', principal: 'principal-c', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: NOW_MS - 26 * 60 * 60 * 1000 }),
    event({ type: 'spend', uid: 'uid-c', amount: 20, remaining: 0, op: 'humanize', mode: 'basic', at: NOW_MS - 25 * 60 * 60 * 1000 })
  ];
}

function fakeEventDb(rows, { fail = false } = {}) {
  const observations = { reads: 0, collection: null, sinceMs: null, orderDirection: null, limit: null };
  return {
    observations,
    collection(name) {
      observations.collection = name;
      const query = {
        where(field, operator, value) {
          assert.equal(field, 'occurredAtMs');
          assert.equal(operator, '>=');
          observations.sinceMs = value;
          return this;
        },
        orderBy(field, direction) {
          assert.equal(field, 'occurredAtMs');
          assert.equal(direction, 'desc');
          observations.orderDirection = direction;
          return this;
        },
        limit(value) {
          observations.limit = value;
          return this;
        },
        async get() {
          observations.reads += 1;
          if (fail) throw new Error('firestore unavailable');
          const selected = rows
            .filter(row => row.occurredAtMs >= observations.sinceMs)
            .sort((a, b) => observations.orderDirection === 'desc'
              ? b.occurredAtMs - a.occurredAtMs
              : a.occurredAtMs - b.occurredAtMs)
            .slice(0, observations.limit);
          return { docs: selected.map(row => ({ data: () => structuredClone(row) })) };
        }
      };
      return query;
    }
  };
}

test('7일 cap 초과 시 최신 이벤트를 남겨 최근 24h cohort를 보존한다', async () => {
  const oldAt = NOW_MS - 6 * DAY_MS;
  const recentAt = NOW_MS - 60 * 60 * 1000;
  const database = fakeEventDb([
    event({ type: 'grant', uid: 'old-a', principal: 'old-a', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: oldAt }),
    event({ type: 'grant', uid: 'old-b', principal: 'old-b', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: oldAt + 1 }),
    event({ type: 'grant', uid: 'old-c', principal: 'old-c', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: oldAt + 2 }),
    event({ type: 'grant', uid: 'recent', principal: 'recent', amount: 20, remaining: 20, op: 'account_initialize', mode: 'free', at: recentAt })
  ]);

  const scan = await scanSignupCreditEvents({
    db: database,
    sinceMs: NOW_MS - 7 * DAY_MS,
    limit: 2
  });
  const summary = aggregateSignupCreditEvents(scan.events, {
    nowMs: NOW_MS,
    scanned: scan.scanned,
    truncated: scan.truncated
  });

  assert.equal(database.observations.orderDirection, 'desc');
  assert.equal(database.observations.limit, 3);
  assert.equal(scan.truncated, true);
  assert.deepEqual(scan.events.map(row => row.occurredAtMs), [oldAt + 2, recentAt]);
  assert.equal(summary.status, 'truncated');
  assert.equal(summary.cohorts.hours24.accounts, 1);
  assert.equal(summary.cohorts.days7.accounts, 2);
});

test('pure cohort 집계는 24h/7d 소진 퍼널·잔액·operation/mode를 계산한다', () => {
  const summary = aggregateSignupCreditEvents(signupJourneyEvents(), { nowMs: NOW_MS, scanned: 6 });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.cohorts.hours24.accounts, 2);
  assert.deepEqual(summary.cohorts.hours24.anyUse, { accounts: 1, rate: 0.5 });
  assert.deepEqual(summary.cohorts.hours24.firstUse, {
    observedAccounts: 1,
    medianMinutes: 10,
    p90Minutes: 10
  });
  assert.deepEqual(summary.cohorts.hours24.remainingAtOrBelowOne, { accounts: 0, rate: 0 });
  assert.deepEqual(summary.cohorts.hours24.exhausted, { accounts: 0, rate: 0 });
  assert.deepEqual(summary.cohorts.hours24.detectHumanize18, { accounts: 1, rate: 0.5 });
  assert.deepEqual(summary.cohorts.hours24.balanceBuckets, {
    zero: 0,
    one: 0,
    two_to_five: 1,
    six_to_ten: 0,
    eleven_to_nineteen: 0,
    full: 1
  });
  assert.deepEqual(summary.cohorts.hours24.spend.byOperation, [
    { key: 'humanize', events: 1, credits: 12 },
    { key: 'detect', events: 1, credits: 6 }
  ]);
  assert.equal(summary.cohorts.days7.accounts, 3);
  assert.deepEqual(summary.cohorts.days7.exhausted, { accounts: 1, rate: 0.3333 });
  assert.doesNotMatch(JSON.stringify(summary), /uid-a|uid-b|uid-c|principal-a/u);
});

test('감지 6 + 기본 blog 12만 완주로 세고 polish 또는 복구된 blog 사용량은 제외한다', () => {
  const grantAt = NOW_MS - 60_000;
  const grant = event({
    type: 'grant', uid: 'journey-user', principal: 'journey-principal', amount: 20,
    remaining: 20, op: 'account_initialize', mode: 'free', at: grantAt
  });
  const detect = event({
    type: 'spend', uid: 'journey-user', amount: 6, remaining: 14,
    op: 'detect', mode: 'detect', at: grantAt + 1
  });
  const polishOnly = aggregateSignupCreditEvents([
    grant,
    detect,
    event({
      type: 'spend', uid: 'journey-user', amount: 12, remaining: 2,
      op: 'humanize', mode: 'polish', at: grantAt + 2
    })
  ], { nowMs: NOW_MS });
  assert.deepEqual(polishOnly.cohorts.hours24.detectHumanize18, { accounts: 0, rate: 0 });

  const restoredBasic = aggregateSignupCreditEvents([
    grant,
    detect,
    event({
      type: 'spend', uid: 'journey-user', amount: 12, remaining: 2,
      op: 'humanize', mode: 'blog', at: grantAt + 2
    }),
    event({
      type: 'restore', uid: 'journey-user', amount: 12, remaining: 14,
      op: 'humanize', mode: 'blog', at: grantAt + 3
    }),
    event({
      type: 'spend', uid: 'journey-user', amount: 12, remaining: 2,
      op: 'humanize', mode: 'polish', at: grantAt + 4
    })
  ], { nowMs: NOW_MS });
  assert.deepEqual(restoredBasic.cohorts.hours24.detectHumanize18, { accounts: 0, rate: 0 });
});

test('동시 distinct 6+6 차감은 timestamp·커밋 순서가 역전돼도 delta 합으로 잔액 8을 재구성한다', () => {
  const grantAt = NOW_MS - 60_000;
  const sameObservedAt = grantAt + 1_000;
  const grant = event({
    type: 'grant', uid: 'concurrent-user', principal: 'shared-principal', amount: 20,
    remaining: 20, op: 'account_initialize', mode: 'free', at: grantAt
  });
  // remaining=8이 실제 두 번째 커밋이지만 두 이벤트의 occurredAtMs는 같다.
  // 입력 순서를 뒤집으면 과거 latest-snapshot 방식은 14를 선택했다.
  const committedSecond = event({
    type: 'spend', uid: 'concurrent-user', amount: 6, remaining: 8,
    op: 'detect', mode: 'detect', at: sameObservedAt
  });
  const committedFirst = event({
    type: 'spend', uid: 'concurrent-user', amount: 6, remaining: 14,
    op: 'detect', mode: 'detect', at: sameObservedAt
  });

  const reversed = aggregateSignupCreditEvents([grant, committedSecond, committedFirst], { nowMs: NOW_MS });
  const forward = aggregateSignupCreditEvents([grant, committedFirst, committedSecond], { nowMs: NOW_MS });
  for (const summary of [reversed, forward]) {
    assert.equal(summary.cohorts.hours24.spend.events, 2, 'distinct request 이벤트 둘을 모두 보존한다');
    assert.equal(summary.cohorts.hours24.spend.credits, 12);
    assert.equal(summary.cohorts.hours24.balanceBuckets.six_to_ten, 1, '20 - 6 - 6 = 8');
    assert.equal(summary.cohorts.hours24.balanceBuckets.eleven_to_nineteen, 0);
  }
  assert.deepEqual(reversed.cohorts.hours24.balanceBuckets, forward.cohorts.hours24.balanceBuckets);
});

test('delta 잔액 재구성은 손상된 초과 spend/restore도 0과 grant 상한으로 닫는다', () => {
  const grantAt = NOW_MS - 60_000;
  const grant = event({
    type: 'grant', uid: 'clamped-user', principal: 'clamped-principal', amount: 20,
    remaining: 20, op: 'account_initialize', mode: 'free', at: grantAt
  });
  const overspent = aggregateSignupCreditEvents([
    grant,
    event({ type: 'spend', uid: 'clamped-user', amount: 40, remaining: 0, op: 'humanize', mode: 'basic', at: grantAt + 1 })
  ], { nowMs: NOW_MS });
  assert.equal(overspent.cohorts.hours24.balanceBuckets.zero, 1);

  const overRestored = aggregateSignupCreditEvents([
    grant,
    event({ type: 'restore', uid: 'clamped-user', amount: 10, remaining: 35, op: 'humanize', mode: 'basic', at: grantAt + 1 })
  ], { nowMs: NOW_MS });
  assert.equal(overRestored.cohorts.hours24.balanceBuckets.full, 1);
});

test('모든 private measurement event는 7일 조회보다 긴 30일 Timestamp TTL을 가진다', () => {
  assert.equal(EVENT_RETENTION_DAYS, 30);
  for (const type of ['grant', 'spend', 'restore']) {
    const row = event({
      type, uid: `ttl-${type}`, principal: `ttl-${type}`, amount: type === 'grant' ? 20 : 6,
      remaining: type === 'spend' ? 14 : 20,
      op: type === 'grant' ? 'account_initialize' : 'humanize',
      mode: type === 'grant' ? 'free' : 'basic',
      at: NOW_MS
    });
    assert.ok(row.expireAt instanceof Date, `${type} expireAt`);
    assert.equal(row.expireAt.getTime() - row.occurredAtMs, 30 * DAY_MS, `${type} retention`);
  }
});

test('같은 principal의 soft 5/25와 hard 10/50 도달 bucket을 UTC 시간·일 단위로 센다', () => {
  const events = [];
  const dayStart = Date.parse('2026-09-01T00:00:00.000Z');
  for (let index = 0; index < 50; index += 1) {
    const hour = Math.floor(index / 10);
    events.push(event({
      type: 'grant',
      uid: `quota-uid-${index}`,
      principal: 'shared-principal',
      amount: 20,
      remaining: 20,
      op: 'account_initialize',
      mode: 'free',
      at: dayStart + hour * 60 * 60 * 1000 + index
    }));
  }
  const quota = aggregateSignupCreditEvents(events, { nowMs: NOW_MS }).cohorts.hours24.principalQuota;
  assert.deepEqual(quota.maxAccountsPerPrincipal, { hourly: 10, daily: 50 });
  assert.deepEqual(quota.soft.hourly, { threshold: 5, bucketsAtOrAbove: 5, principalsAtOrAbove: 1 });
  assert.deepEqual(quota.soft.daily, { threshold: 25, bucketsAtOrAbove: 1, principalsAtOrAbove: 1 });
  assert.deepEqual(quota.hard.hourly, { threshold: 10, bucketsAtOrAbove: 5, principalsAtOrAbove: 1 });
  assert.deepEqual(quota.hard.daily, { threshold: 50, bucketsAtOrAbove: 1, principalsAtOrAbove: 1 });
});

test('empty/truncated/error completeness 상태가 같은 응답 스키마를 유지한다', () => {
  const empty = aggregateSignupCreditEvents([], { nowMs: NOW_MS });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.cohorts.hours24.accounts, 0);
  assert.equal(empty.cohorts.days7.firstUse.medianMinutes, null);

  const truncated = aggregateSignupCreditEvents(signupJourneyEvents(), {
    nowMs: NOW_MS,
    truncated: true,
    scanned: 5
  });
  assert.equal(truncated.status, 'truncated');
  assert.equal(truncated.truncated, true);

  const failed = aggregateSignupCreditEvents([], { nowMs: NOW_MS, scanStatus: 'error', source: 'unavailable' });
  assert.equal(failed.status, 'error');
  assert.ok(failed.cohorts.hours24.balanceBuckets);
});

async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`
    }));
  });
}

async function post(baseUrl, token) {
  const response = await fetch(`${baseUrl}/admin/signup-credit-summary`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: '{}'
  });
  return { status: response.status, body: await response.json() };
}

test('관리자 endpoint는 인증 후 private root events만 읽고 aggregate만 반환한다', async t => {
  const database = fakeEventDb(signupJourneyEvents());
  const router = createSignupCreditMonitoringRouter({
    database,
    verifyAdmin: async token => !token ? null : (token === 'admin' ? 'admin-uid' : false),
    routeLogger: { warn() {} },
    now: () => NOW_MS,
    maxEvents: 100
  });
  const { server, baseUrl } = await listen(router);
  t.after(() => new Promise(resolve => server.close(resolve)));

  assert.equal((await post(baseUrl)).status, 401);
  assert.equal((await post(baseUrl, 'other')).status, 403);
  const response = await post(baseUrl, 'admin');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.cohorts.hours24.accounts, 2);
  assert.equal(database.observations.collection, SIGNUP_CREDIT_EVENT_COLLECTION);
  assert.equal(database.observations.reads, 1);
  assert.equal(database.observations.limit, 101);
  assert.doesNotMatch(JSON.stringify(response.body), /uid-a|principal-a/u);
});

test('endpoint는 저장소 오류를 503 status:error로, cap 초과를 status:truncated로 명시한다', async t => {
  const failedRouter = createSignupCreditMonitoringRouter({
    database: fakeEventDb([], { fail: true }),
    verifyAdmin: async () => 'admin-uid',
    routeLogger: { warn() {} },
    now: () => NOW_MS
  });
  const failedServer = await listen(failedRouter);
  t.after(() => new Promise(resolve => failedServer.server.close(resolve)));
  const failed = await post(failedServer.baseUrl, 'admin');
  assert.equal(failed.status, 503);
  assert.equal(failed.body.status, 'error');
  assert.equal(failed.body.error, 'SIGNUP_CREDIT_SUMMARY_UNAVAILABLE');
  assert.ok(failed.body.cohorts.days7.balanceBuckets);

  const truncatedRouter = createSignupCreditMonitoringRouter({
    database: fakeEventDb(signupJourneyEvents()),
    verifyAdmin: async () => 'admin-uid',
    routeLogger: { warn() {} },
    now: () => NOW_MS,
    maxEvents: 2
  });
  const truncatedServer = await listen(truncatedRouter);
  t.after(() => new Promise(resolve => truncatedServer.server.close(resolve)));
  const truncated = await post(truncatedServer.baseUrl, 'admin');
  assert.equal(truncated.status, 200);
  assert.equal(truncated.body.status, 'truncated');
  assert.equal(truncated.body.truncated, true);
});

test('read-only CLI는 동일 집계기를 사용하고 write API 없이 JSON report를 만든다', async () => {
  const database = fakeEventDb(signupJourneyEvents());
  const output = [];
  const errors = [];
  const result = await runReport({
    database,
    argv: ['--json', '--max-events=100', '--now=2026-09-01T12:00:00.000Z'],
    write: value => output.push(value),
    writeError: value => errors.push(value)
  });
  assert.equal(result.exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(JSON.parse(output[0]).cohorts.hours24.accounts, 2);
  assert.equal(database.observations.reads, 1);
  assert.equal(typeof database.runTransaction, 'undefined');
});

test('private event rules와 server mount가 직접 클라이언트 접근·누락을 막는다', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const monitor = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signupCreditMonitoring.js'), 'utf8');
  const deploy = fs.readFileSync(path.join(__dirname, '..', 'DEPLOY.md'), 'utf8');
  const indexes = require('../firestore.indexes.json');
  const packageJson = require('../package.json');
  assert.match(rules, /match \/signupCreditEvents\/\{eventId\}[\s\S]*?allow read, write: if false;/u);
  assert.match(server, /require\('\.\/routes\/signupCreditMonitoring'\)/u);
  assert.doesNotMatch(monitor, /creditHistory|collectionGroup/u, '전역 latest 원장을 코호트 데이터 원천으로 재사용하면 안 된다');
  assert.deepEqual(indexes.fieldOverrides.find(row => row.collectionGroup === SIGNUP_CREDIT_EVENT_COLLECTION), {
    collectionGroup: SIGNUP_CREDIT_EVENT_COLLECTION,
    fieldPath: 'expireAt',
    ttl: true,
    indexes: []
  });
  assert.match(deploy, /firebase deploy --only firestore:indexes/u);
  assert.match(deploy, /gcloud firestore fields ttls list[\s\S]*collection-group=signupCreditEvents/u);
  assert.match(deploy, /7일 조회 창보다 23일의 삭제 지연 여유/u);
  assert.equal(SIGNUP_GRANT_CREDITS, 20);
  assert.match(deploy, /기존 계정에는 크레딧을 소급 지급하지 않는다/u);
  assert.doesNotMatch(deploy, /credits:grant-existing|grant-existing-users-credits/u);
  assert.equal(packageJson.scripts['credits:grant-existing'], undefined);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'scripts', 'grant-existing-users-credits.js')), false);
  assert.equal(packageJson.scripts['report:signup-credits'], 'node scripts/report-signup-credit-usage.js');
});
