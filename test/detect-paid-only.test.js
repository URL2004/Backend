// 감지 유료 전환(2026-07-20 무료 제공 제거) + 클라이언트 IP 판별 회귀 테스트
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { realClientIp } = require('../lib/clientip');

test('realClientIp는 cf-connecting-ip를 최우선으로 쓴다(CF 엣지 IP 캡 분산 실사고 방지)', () => {
  assert.equal(realClientIp({ headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9, 5.5.5.5' }, ip: '172.68.0.1' }), '1.2.3.4');
  // CF 미경유 폴백: XFF 첫 항목 → req.ip → unknown
  assert.equal(realClientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 5.5.5.5' }, ip: '172.68.0.1' }), '9.9.9.9');
  assert.equal(realClientIp({ headers: {}, ip: '10.0.0.7' }), '10.0.0.7');
  assert.equal(realClientIp({ headers: {}, ip: '' }), 'unknown');
});

test('detect-report는 무료 경로 없이 항상 로그인·크레딧 선검증을 요구한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  // 무료 캡 로직이 되살아나지 않게 가드
  assert.ok(!/FREE_EXHAUSTED/.test(src), '무료 소진 분기(FREE_EXHAUSTED)가 없어야 한다');
  assert.ok(!/DETECT_DAILY_CAP/.test(src), '무료 일일 캡 env가 없어야 한다');
  // 항상 유료 계약: 비로그인 401 LOGIN_REQUIRED + 잔액 선검증 + 성공 후 멱등 차감
  assert.ok(/LOGIN_REQUIRED/.test(src), '비로그인 401 안내가 있어야 한다');
  assert.ok(/precheckCredits/.test(src), '잔액 선검증이 있어야 한다');
  assert.ok(/commitCreditDeduct/.test(src), '성공 후 차감이 있어야 한다');
  // 코치 IP 캡은 CF 실제 IP 기준
  assert.ok(/realClientIp/.test(src), '코치 IP 캡이 realClientIp를 써야 한다');
});
