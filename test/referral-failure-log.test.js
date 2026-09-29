'use strict';
// 2026-09-29: 추천 규칙 거절(409)이 error로 남아 SEV2 디스코드 알림이 매일 나갔다 → 4xx는 warn, 5xx만 error.
const test = require('node:test');
const assert = require('node:assert/strict');
const paymentRouter = require('../routes/payment');
const opsEvents = require('../lib/opsEvents');

const { referralFailureLog } = paymentRouter;

test('규칙 거절(4xx)은 referral.rejected warn으로, 코드만 남기고 스택은 싣지 않는다', () => {
  const err = Object.assign(new Error('동일한 가입 환경의 계정에는 추천을 적용할 수 없습니다.'), { status: 409, code: 'REFERRAL_SAME_SIGNUP_PRINCIPAL' });
  const log = referralFailureLog(err, 409);
  assert.equal(log.level, 'warn');
  assert.equal(log.event, 'referral.rejected');
  assert.equal(log.fields.code, 'REFERRAL_SAME_SIGNUP_PRINCIPAL');
  assert.equal(log.fields.statusCode, 409);
  assert.equal(log.fields.err, undefined);
  assert.match(log.fields.reason, /동일한 가입 환경/u);
  const cls = opsEvents.classify(log.event, log.level);
  assert.equal(cls.sev, 'SEV3');
  assert.equal(cls.discord, false, '규칙 거절은 관리자 로그에만 남는다');
});

test('인증 실패(401)도 규칙 거절로 취급하고, 5xx만 referral.failed error다', () => {
  const auth = Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' });
  const authLog = referralFailureLog(auth, 401);
  assert.equal(authLog.level, 'warn');
  assert.equal(authLog.event, 'referral.rejected');

  const boom = new Error('Firestore unavailable');
  const failLog = referralFailureLog(boom, 500);
  assert.equal(failLog.level, 'error');
  assert.equal(failLog.event, 'referral.failed');
  assert.equal(failLog.fields.err, boom, '진짜 실패는 스택을 남긴다');
  const cls = opsEvents.classify(failLog.event, failLog.level);
  assert.equal(cls.sev, 'SEV2');
  assert.equal(cls.discord, true);
});
