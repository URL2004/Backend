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

test('detect-report 성공 결과는 관리자 사용자 작업 기록에 멱등 저장한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'detectreport.js'), 'utf8');
  assert.match(src, /history\.saveAnalyzeHistory\(\{/u, '감지 보고서를 서버 이용 기록에 저장해야 한다');
  assert.match(src, /opType:\s*'detect'/u, '관리자 화면이 인식하는 detect 유형이어야 한다');
  assert.match(src, /requestId,/u, '동일 요청 재시도는 같은 문서 ID로 멱등 저장해야 한다');
  assert.match(src, /historySaved/u, '저장 여부를 응답과 운영 로그에서 확인할 수 있어야 한다');
  assert.match(src, /detect_report\.history_persist_failed/u, '이력 저장 실패는 감지 결과 전달과 분리해 기록해야 한다');
});
