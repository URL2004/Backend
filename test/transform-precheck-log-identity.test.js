'use strict';

// 2026-10-09 운영 점검 C-09 회귀: 잔액 부족으로 막힌 요청(transform.precheck_failed) 82건이 모두
// 사용자 식별 없이 남았다. 인증이 끝난 요청의 차단 로그에는 성공 경로와 같은 식별(uid)이 실려야 한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const billing = require('../lib/usageBilling');
const { logger, currentContext } = require('../lib/logger');
const requestContext = require('../middleware/requestContext');
const transform = require('../routes/transform');

const PROSE = Array.from({ length: 6 }, (_, index) =>
  `지어낸 실습 보고서의 ${index + 1}번째 문단이다. 조원들과 역할을 나누어 자료를 모았고, 서로 다른 의견을 한 장에 정리했다. 발표 전날에는 표현이 어색한 문장을 함께 고쳤다.`
).join('\n\n');
const REFERENCES_ONLY = [
  '참고문헌',
  '한가람. (2031). 종이접기를 활용한 아동 놀이 프로그램 기초연구. 가상문화연구, 12(3), 45-68.',
  '한가람. (2033). 종이접기 놀이 프로그램 제안. 가상대학교 석사학위논문.',
  'Dorim, T., & Maru, O. (2025). The joint folding procedure for families: A pilot description. Imaginary Journal of Play, 40(1), 1-12.',
  'Dorim, T., & Maru, O. (2028). Creating together with paper. Imaginary Journal of Play, 43(2), 20-33.',
  '모하람 (2015). 『사람과 장소』. 가상시: 가상과지성사.',
  '보르디, 피에르 (1995). 『실천의 이유: 행동의 이론에 관하여』. 임가상 역. 가상시: 동가상.'
].join('\n');

function captureLogs(t) {
  const records = [];
  const originals = { warn: logger.warn, info: logger.info, error: logger.error };
  for (const level of Object.keys(originals)) {
    logger[level] = (event, fields) => records.push({ level, event, fields: { ...(fields || {}) }, context: { ...currentContext() } });
  }
  t.after(() => Object.assign(logger, originals));
  return records;
}

function stubBilling(t, overrides) {
  const originals = { authenticate: billing.authenticate, precheckCredits: billing.precheckCredits, precheckCoupon: billing.precheckCoupon };
  Object.assign(billing, overrides);
  t.after(() => Object.assign(billing, originals));
}

async function startApp(t, { withRequestContext = true } = {}) {
  const previous = { dev: process.env.DEV_NO_AUTH, firebase: process.env.FIREBASE_SERVICE_ACCOUNT };
  delete process.env.DEV_NO_AUTH;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  t.after(() => {
    for (const [name, value] of [['DEV_NO_AUTH', previous.dev], ['FIREBASE_SERVICE_ACCOUNT', previous.firebase]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const app = express();
  if (withRequestContext) app.use(requestContext);
  app.use(express.json());
  app.use('/', transform);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function post(base, body, token = 'token-of-low-balance-user') {
  return fetch(`${base}/transform`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ effectNoticeAccepted: true, ...body })
  });
}

const insufficient = () => { throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 }); };

test('C-09 잔액 부족으로 막힌 요청의 로그에 인증된 사용자 식별이 실린다', { concurrency: false }, async t => {
  stubBilling(t, {
    authenticate: async () => ({ uid: 'uid-low-balance', email: 'student@example.invalid', name: '지어낸 이름' }),
    precheckCredits: async () => insufficient()
  });
  const records = captureLogs(t);
  const base = await startApp(t);

  const response = await post(base, { text: PROSE, mode: 'formal' });
  assert.equal(response.status, 402);
  await response.json();

  const failed = records.filter(record => record.event === 'transform.precheck_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'warn');
  assert.equal(failed[0].fields.uid, 'uid-low-balance');
  assert.equal(failed[0].fields.mode, 'formal');
  assert.equal(failed[0].fields.billingMode, 'credit');
  assert.ok(failed[0].fields.needed > 0);
  assert.equal(failed[0].fields.err.message, 'INSUFFICIENT_CREDITS');
  // 다른 이벤트가 싣는 것과 같은 식별만 싣는다. 이메일·이름 같은 개인정보는 넣지 않는다.
  assert.deepEqual(Object.keys(failed[0].fields).sort(), ['billingMode', 'creditNeeded', 'err', 'mode', 'needed', 'uid']);
  assert.doesNotMatch(JSON.stringify(failed[0].fields), /example\.invalid|지어낸 이름/u);

  // 같은 요청의 접근 로그에도 uid가 실린다(성공 경로와 같다).
  for (let waited = 0; waited < 50 && !records.some(record => record.event === 'http.request'); waited += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const access = records.find(record => record.event === 'http.request');
  assert.ok(access, '접근 로그가 남지 않았다');
  assert.equal(access.fields.statusCode, 402);
  assert.equal(access.context.uid, 'uid-low-balance');
});

test('C-09 로그 문맥이 없는 실행에서도 차단 로그의 필드에 식별이 남고, 쿠폰 사전 검사 실패도 같다', { concurrency: false }, async t => {
  stubBilling(t, {
    authenticate: async () => ({ uid: 'uid-coupon-user' }),
    precheckCoupon: async () => { throw Object.assign(new Error('COUPON_CHAR_LIMIT'), { status: 400, charLimit: 3000 }); }
  });
  const records = captureLogs(t);
  const base = await startApp(t, { withRequestContext: false });

  const response = await post(base, { text: PROSE, mode: 'formal', billingMode: 'coupon' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).charLimit, 3000);

  const failed = records.filter(record => record.event === 'transform.precheck_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].fields.uid, 'uid-coupon-user');
  assert.equal(failed[0].fields.billingMode, 'coupon');
  assert.deepEqual(failed[0].context, {});
});

test('C-09 인증이 실패한 요청은 사전 검사 로그도 식별도 남기지 않는다', { concurrency: false }, async t => {
  let prechecks = 0;
  stubBilling(t, {
    authenticate: async () => { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); },
    precheckCredits: async () => { prechecks += 1; return { uid: 'never', plan: 'free' }; }
  });
  const records = captureLogs(t);
  const base = await startApp(t);

  const response = await post(base, { text: PROSE, mode: 'formal' }, 'expired-token');
  assert.equal(response.status, 401);
  await response.json();
  assert.equal(prechecks, 0);
  assert.equal(records.some(record => record.event === 'transform.precheck_failed'), false);
  for (const record of records) {
    assert.equal(record.fields.uid, undefined, record.event);
    assert.equal(record.context.uid, undefined, record.event);
  }
});

test('C-09 변환할 본문이 없어 막힌 요청의 로그에도 사용자 식별과 잠금 글자 비율이 실린다', { concurrency: false }, async t => {
  let prechecks = 0;
  stubBilling(t, {
    authenticate: async () => ({ uid: 'uid-reference-only' }),
    precheckCredits: async () => { prechecks += 1; return { uid: 'uid-reference-only', plan: 'free' }; }
  });
  const records = captureLogs(t);
  const base = await startApp(t);

  const response = await post(base, { text: REFERENCES_ONLY, mode: 'formal' });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.code, 'NO_EDITABLE_CONTENT');
  // 응답 문구와 모양은 그대로다(로그에만 더 남긴다).
  assert.deepEqual(Object.keys(body).sort(), ['code', 'documentProfile', 'editableChunkCount', 'error']);
  assert.equal(body.error, '표·목차·참고문헌처럼 보존해야 할 구조만 있어 변환할 일반 본문을 찾지 못했어요.');
  assert.equal(prechecks, 0);

  const blocked = records.filter(record => record.event === 'transform.no_editable_content');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].fields.uid, 'uid-reference-only');
  assert.equal(blocked[0].fields.dominantLockType, 'reference_item');
  assert.ok(blocked[0].fields.dominantLockShare > 0.9, String(blocked[0].fields.dominantLockShare));
  assert.equal(blocked[0].fields.lockCharShare.reference_item, blocked[0].fields.dominantLockShare);
  assert.match(blocked[0].fields.message, /가장 큰 잠금 reference_item이 원문의 \d+%/u);
  assert.doesNotMatch(JSON.stringify(blocked[0].fields), /한가람|Dorim/u);   // 원문은 로그에 싣지 않는다
});
