'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const labels = require('../engine-gpt-prod/inlineLabelParagraphs');
const physical = require('../engine-gpt-prod/physicalProseLines');
const preflight = require('../engine-gpt-prod/sourcePreflight').auditAndSanitizeSource;

test('long numbered nominal subtitles keep their separate heading boundary', () => {
  const body = '조사에서는 이용자의 의견을 듣고 실제 운영 기록과 대조하여 필요한 개선 항목을 정리했다.';
  for (const heading of [
    '2. 운영 계획: 지역의 여러 시설에서 제공하는 서비스의 범위와 그 필요성',
    '1) 자원 관리 전략: 공개 자료의 확대 및 기관 저장소와 공동 연구 자료의 자산화',
    '3) 공간 운영 전략: 자동 보관 시설 도입과 창작 및 협업 활동을 지원하는 공간의 고도화',
    '주요 개념 (Primary Concept): 핵심어 [지역성, 체험(현장 관찰), 맥락, 공통된 기록 관점]'
  ]) {
    const text = heading + '\n' + body;
    assert.equal(labels.repairInlineLabelContinuations(text).text, text);
    assert(preflight(text).text.includes(heading + '\n'));
  }
});

test('object-plus-noun label titles keep their separate heading boundary', () => {
  const body = '이 사업은 지역 자료를 정기적으로 검토하고 필요한 교육과 지원 활동을 운영한다.';
  for (const heading of [
    '1. 추진 방향: 마을 주민과 인근 학교 학생의 자료 탐색 및 정보 활용 능력을 강화',
    '2. 지원 목적: 마을 주민과 인근 학교 학생 사이의 자료 접근 격차를 해소',
    '3. 운영 계획: 마을 주민과 인근 학교 학생을 위한 공동 자료 이용 기반을 마련'
  ]) {
    const text = heading + '\n' + body;
    const result = labels.repairInlineLabelContinuations(text);
    assert.equal(result.text, text);
    assert.equal(result.repairCount, 0);
    assert.equal(physical.restoreSubmittedSourceSeams(text, text).text, text);
    assert.equal(preflight(text).text, text);
  }
});

test('numbered label bodies retain their proven adjective and explicit adjunct continuations', () => {
  const text = '1. 조사 목적: 오래된 지역 기록의 표기 방식은 지역 공동체의 변화와 한국어의 역사적\n'
    + '변화를 보여 주는 자료이므로 여러 시기의 기록을 대조하고 특징을 함께 정리한다.\n'
    + '2. 조사 일시와 장소: 2026년 3월 2일, 지역 도서관의 전시실과 자료 보관실을 직접\n'
    + '방문하여 안내 기록과 전시 자료를 직접 확인하고 필요한 내용을 정리했다.';
  const result = labels.repairInlineLabelContinuations(text);
  assert.equal(result.repairCount, 2);
  assert.equal(result.contentPreserved, true);
  assert.equal(result.text.split('\n').length, 2);
});

test('dense authored paragraphs with contracted past predicates keep all paragraph breaks', () => {
  for (const ending of ['잠겼다', '배웠다', '느꼈다', '커졌다']) {
    const text = Array.from({ length: 24 }, (_, index) =>
      `${index + 1}일째 관찰을 기록했다. 낯선 결과를 떠올리며 남은 차이를 자세히 ${ending}`).join('\n\n');
    const result = physical.repairPhysicalProseLines(text);
    assert.equal(result.text, text);
    assert.equal(result.joins.length, 0);
    assert.equal(result.text.split('\n\n').length, 24);
  }
  assert.equal(physical.wordSeam('기록을 대조하며 여러 관점을 배웠', '다. 다음 관찰도 기록했다.', new Set()), true);
});
