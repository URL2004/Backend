'use strict';
// v2.5.94 (2026-09-29): 문단 마지막 문장에서 빠진 마침표를 채운다. 근거가 충분한 산문 문단만 대상이고,
// 제목·목록·인용·코드·참고문헌·시·짧은 한 줄은 건드리지 않는다. 사용자 원문은 넣지 않고 합성 문장으로 시험한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const preflight = require('../engine-gpt-prod/sourcePreflight');

const HEADING = '1. 전달체계의 개념';
const INTRO = '이 글은 공공과 민간 전달체계의 개념과 역할을 사례를 통해 차례로 정리한 것이다.';
const P_MISSING_A = '공공 전달체계는 공공부문의 조직을 통해 정책을 실제 서비스로 전달하도록 지원하는 체계이다. 공공기관도 공공부문의 주체로 제시된다';
const P_MISSING_B = '셋째, 담당 인력과 제공 가능한 자원의 상태를 주기적으로 점검하는 방안이다. 이용자의 실제 접근 조건을 살펴보는 접근을 검토할 수 있다';
const P_COMPLETE = '결국 내가 주목한 것은 서로 다른 역할이 이용자의 생활에서 어떻게 연결되는가이다. 이러한 관점이 상황을 이해하는 데 도움이 될 것이라고 생각한다.';

function restore(lines) { return preflight.restoreParagraphTerminalPunctuation(lines.join('\n')); }
function restoredCount(result) { return result.changes.filter(c => c.code === 'source_terminal_punctuation_restored').length; }

test('문장부호를 쓰는 문단의 마지막 문장에서 빠진 마침표를 채운다', () => {
  const result = restore([HEADING, INTRO, P_MISSING_A, P_MISSING_B, P_COMPLETE]);
  const out = result.text.split('\n');
  assert.equal(out.length, 5, '줄 수는 그대로');
  assert.equal(out[0], HEADING, '제목은 건드리지 않는다');
  assert.equal(out[1], INTRO);
  assert.equal(out[2], `${P_MISSING_A}.`);
  assert.equal(out[3], `${P_MISSING_B}.`);
  assert.equal(out[4], P_COMPLETE, '이미 마침표가 있으면 그대로');
  assert.equal(restoredCount(result), 2);
  assert.deepEqual(result.changes.map(c => c.lineOrdinal), [3, 4]);
  assert.ok(result.changes.every(c => c.last === false));
  // 마침표 외에는 아무 글자도 바꾸지 않는다.
  assert.equal(result.text.replace(/\./gu, ''), [HEADING, INTRO, P_MISSING_A, P_MISSING_B, P_COMPLETE].join('\n').replace(/\./gu, ''));
  // 두 번 돌려도 같다.
  assert.equal(preflight.restoreParagraphTerminalPunctuation(result.text).text, result.text);
});

test('한 문장짜리 문단은 문서가 마침표를 쓰는 글일 때만 채운다', () => {
  const single = '민간 전달체계는 사회복지법인과 민간 단체 등 민간조직을 통해 복지서비스가 전달되는 체계이다';
  const punctuatedDoc = restore([HEADING, INTRO, P_COMPLETE, `${P_MISSING_A}.`, single]);
  assert.equal(punctuatedDoc.text.split('\n')[4], `${single}.`);
  assert.equal(punctuatedDoc.changes[0].last, true, '문서 마지막 문단임을 표시한다');

  const unpunctuatedDoc = restore([HEADING, single, single.replace('민간', '공공'), single.replace('체계이다', '구조이다')]);
  assert.equal(restoredCount(unpunctuatedDoc), 0, '마침표를 쓰지 않는 글에는 끼워 넣지 않는다');
});

test('제목·짧은 줄·목록·인용·출처 괄호·코드·참고문헌은 건드리지 않는다', () => {
  const untouched = [
    '협력의 의미와 개선방안에 대한 나의 생각을 정리한다',                                   // 40자 미만
    '- 이용자가 연락할 담당 창구와 기관별 역할을 알기 쉽게 정리하는 방안을 먼저 검토한다. 이어서 기록 방식을 정한다',  // 목록
    '연구자는 이 과정을 두고 “지원이 이어지는지 확인하는 일이 중요하다. 그렇게 말했다”',                   // 닫는 따옴표
    '기관 간 협력은 이용자의 생활을 중심으로 이루어져야 한다. 선행연구도 같은 결론을 제시한다(김철수, 2020)', // 출처 괄호
    '담당자는 지원이 끊기지 않도록 다음 조치를 확인한다. 자세한 절차는 https://example.com/guide 에서 본다'       // 웹 주소 끝
  ];
  const result = restore([HEADING, INTRO, P_COMPLETE, `${P_MISSING_A}.`, ...untouched]);
  assert.equal(restoredCount(result), 0);
  assert.deepEqual(result.text.split('\n').slice(4), untouched);

  const fenced = restore([HEADING, INTRO, P_COMPLETE, '```', P_MISSING_A, '```']);
  assert.equal(restoredCount(fenced), 0, '코드 펜스 안은 건드리지 않는다');

  const references = restore([HEADING, INTRO, P_COMPLETE, `${P_MISSING_A}.`, '참고문헌', P_MISSING_B]);
  assert.equal(restoredCount(references), 0, '참고문헌 구역은 건드리지 않는다');
});

test('다음 행이 이 문장의 조각이면 마침표를 넣지 않는다', () => {
  const result = restore([HEADING, INTRO, P_COMPLETE, P_MISSING_A, '는 점에서 이 구분은 의미가 있다.']);
  assert.equal(restoredCount(result), 0);
});

test('전처리 전체 흐름: 모델 입력에는 마침표가 들어가고 무결성 기준선은 원문 그대로다', () => {
  const source = [HEADING, INTRO, P_MISSING_A, P_MISSING_B, P_COMPLETE.replace(/\.$/u, '')].join('\n');
  const audit = preflight.auditAndSanitizeSource(source);
  const lines = audit.text.split('\n').filter(line => line.trim());
  assert.equal(lines.length, 5, '문단은 붙지 않는다(v2.5.93)');
  assert.ok(lines[2].endsWith('제시된다.'));
  assert.ok(lines[3].endsWith('검토할 수 있다.'));
  assert.ok(lines[4].endsWith('생각한다.'), '마지막 문단도 채운다');
  assert.equal(audit.changed, true);
  assert.ok(audit.issueCodes.includes('source_terminal_punctuation_restored'));
  assert.equal(audit.issueCodes.includes('source_missing_terminal_punctuation'), false, '채운 뒤에는 누락 알림을 중복으로 내지 않는다');
  assert.equal(audit.integrityText.includes('제시된다.'), false, '무결성 기준선에는 넣지 않는다');
  const warning = audit.warnings.find(item => item.code === 'source_terminal_punctuation_restored');
  assert.equal(warning.action, 'repaired');
  assert.equal(warning.count, 3);
});

test('짧은 한 줄 원문은 종전대로 수정 없이 알리기만 한다', () => {
  const audit = preflight.auditAndSanitizeSource('연구자는 자료의 의미를 분석했다');
  assert.equal(audit.changed, false);
  assert.ok(audit.issueCodes.includes('source_missing_terminal_punctuation'));
});

test('시처럼 행갈이가 구조인 글은 건드리지 않는다', () => {
  const poem = ['봄이 오면 나는 다시 걷는다', '낡은 신발을 고쳐 신고 걷는다', '바람이 불어도 나는 걷는다', '해가 져도 나는 걷는다', '끝내 닿지 못해도 걷는다'].join('\n');
  const audit = preflight.auditAndSanitizeSource(poem);
  assert.equal(audit.issueCodes.includes('source_terminal_punctuation_restored'), false);
  assert.equal(audit.text, poem);
});
