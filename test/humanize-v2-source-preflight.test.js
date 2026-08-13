'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const preflight = require('../engine-gpt-prod/sourcePreflight');

test('단독 UI·작성 지시·빈 마크다운 행만 본문에서 제외한다', () => {
  const source = [
    '탐구 보고서',
    '(이미 작성하신 내용에 이어 추가하세요)',
    '접기',
    '**',
    '소비자의 선택이 기업 행동에 미치는 영향을 살폈다.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.changed, true);
  assert.equal(result.removedLineCount, 3);
  assert.equal(result.text, '탐구 보고서\n소비자의 선택이 기업 행동에 미치는 영향을 살폈다.');
  assert.deepEqual(
    new Set(result.issues.filter(item => item.action === 'removed').map(item => item.code)),
    new Set(['source_instruction_artifact', 'source_ui_artifact', 'source_markdown_artifact'])
  );
});

test('작성 중 메모와 짝이 맞지 않는 마크다운은 삭제하지 않고 원문 확인 알림만 남긴다', () => {
  const source = '점액의 기능을 정리했다. (땀이 나오는 것처럼 점액이 나옴)분비 과정을 **추가로 살폈다.';
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
  assert.ok(result.issueCodes.includes('source_draft_note'));
  assert.ok(result.issueCodes.includes('source_markdown_artifact'));
  assert.ok(result.warnings.every(item => item.severity === 'notice'));
});

test('끝이 잘린 참고문헌과 미완성 마지막 문장을 감지하되 임의로 완성하지 않는다', () => {
  const reference = [
    '참고문헌',
    '홍길동, 「소비자 연구」, 한국학술지, 2026,'
  ].join('\n');
  const referenceResult = preflight.auditAndSanitizeSource(reference);
  assert.equal(referenceResult.text, reference);
  assert.ok(referenceResult.issueCodes.includes('source_truncated_reference'));

  const incomplete = '본 연구는 온라인 플랫폼의 선택 구조를 분석하기 위해';
  const incompleteResult = preflight.auditAndSanitizeSource(incomplete);
  assert.equal(incompleteResult.text, incomplete);
  assert.ok(incompleteResult.issueCodes.includes('source_incomplete_sentence'));
});

test('입력이 전부 UI 문구여도 빈 본문으로 만들지 않는다', () => {
  const result = preflight.auditAndSanitizeSource('접기');
  assert.equal(result.changed, false);
  assert.equal(result.text, '접기');
  assert.equal(result.removedLineCount, 0);
  assert.ok(result.issueCodes.includes('source_ui_artifact'));
});

test('본문 끝에 붙은 재작성 요청은 제거하되 본문 속 인용 문구는 보존한다', () => {
  const source = [
    '디지털 격차의 원인과 정책 대안을 비교했다.',
    '이런 내용으로 인간처럼 다시 써줘'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.version, 15);
  assert.equal(result.changed, true);
  assert.equal(result.text, '디지털 격차의 원인과 정책 대안을 비교했다.');
  assert.ok(result.issueCodes.includes('source_rewrite_request_artifact'));

  const quoted = [
    '작성 지시가 본문에서 어떻게 쓰이는지 설명한다.',
    '“이런 내용으로 인간처럼 다시 써줘”라는 문구를 사례로 인용했다.',
    '이 문구는 분석 대상이므로 그대로 남긴다.'
  ].join('\n');
  const preserved = preflight.auditAndSanitizeSource(quoted);
  assert.equal(preserved.changed, false);
  assert.equal(preserved.text, quoted);
  assert.equal(preserved.issueCodes.includes('source_rewrite_request_artifact'), false);
});

test('두 자리 절 번호를 한 자리 번호 둘로 분리하지 않는다', () => {
  for (const source of [
    '11. 느낀 점 및 확장 탐구',
    '# 14. 결론 및 나의 생각'
  ]) {
    const result = preflight.auditAndSanitizeSource(source);
    assert.equal(result.text, source);
    assert.equal(result.integrityText, source);
    assert.equal(/\n\s*\d/u.test(result.text), false);
  }
});

test('제목 후보 명사에 붙은 조사를 본문 행으로 잘못 분리하지 않는다', () => {
  const cases = [
    '1. 핵심 개념은 현대 조직을 이해하는 데 필요한 기준을 제공하며 실제 사례를 통해 그 의미를 설명한다.',
    '2. 적용 사례는 여러 현장에서 반복적으로 확인되었고 연구자는 그 결과를 구체적인 자료와 함께 제시했다.',
    '3. 분석 결과를 바탕으로 다음 연구에서 검토해야 할 쟁점과 실천 방향을 차례로 정리하였다.'
  ];
  for (const source of cases) {
    const result = preflight.auditAndSanitizeSource(source);
    assert.equal(result.text, source);
    assert.equal(/(?:개념|사례|결과)\n+(?:은|는|을|를)(?:\s|$)/u.test(result.text), false);
  }
});

test('최종 무결성 감사용 원문은 레이아웃 복구 이전 경계를 유지한다', () => {
  const source = [
    '접기',
    '1. 연구 결과본문 첫 문장은 충분히 길고 완결된 설명을 포함하며 두 번째 문장도 이어진다. 이 결과를 다시 검토했다.'
  ].join('\n');
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.integrityText, source.split('\n')[1]);
  assert.equal(result.integrityText.includes('결과본문'), true);
  assert.equal(result.removedLineCount, 1);
});
