'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const discourse = require('../engine-gpt-prod/discourseAudit');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const naturalness = require('../engine-gpt-prod/naturalnessShadow');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const stableCore = require('../engine-gpt-prod/prompts/humanize/stableCore');

test('v2.5.31: 문장 분리로 활동 문장 분모만 늘어난 결과를 개인 서사 삭제로 오인하지 않는다', () => {
  const source = [
    '자료를 조사했습니다.',
    '인터뷰를 수행했습니다.',
    '결과를 표로 정리했습니다.',
    '초기에는 요구가 불분명해 방향을 잡기 어려웠습니다.',
    '팀의 기준과 일정도 한 문장 안에서 함께 설명되어 있었습니다.'
  ].join(' ');
  const output = [
    '자료를 조사했습니다.',
    '인터뷰를 수행했습니다.',
    '결과를 표로 정리했습니다.',
    '초기에는 요구가 불분명했습니다.',
    '그래서 방향을 잡기 어려웠습니다.',
    '팀의 기준이 있었습니다.',
    '일정도 한 문장 안에 함께 적혀 있었습니다.'
  ].join(' ');
  const audit = discourse.compareDiscourse(source, output);
  assert.ok(audit.metrics.deltas.actionSentenceRatio < -0.12, JSON.stringify(audit));
  assert.equal(audit.codes.includes('personal_balance_shift'), false, JSON.stringify(audit));
});

test('v2.5.31: 공백 없는 번호 목록을 같은 목록으로 세고 모든 기호 뒤 공백을 복원한다', () => {
  const source = [
    '1.첫 번째 항목은 선형 관계의 정의와 적용 조건을 충분한 문장으로 설명합니다.',
    '2.두 번째 항목은 관찰 자료의 차이와 해석 기준을 충분한 문장으로 설명합니다.',
    '3.세 번째 항목은 계산 절차의 순서와 검토 방법을 충분한 문장으로 설명합니다.'
  ].join('\n');
  const output = source.replace('2.두', '2. 두');
  const sourceLists = layoutStructure.buildLineRecords(source).filter(row => row.role === 'list').length;
  const outputLists = layoutStructure.buildLineRecords(output).filter(row => row.role === 'list').length;
  assert.equal(sourceLists, 3);
  assert.equal(outputLists, 3);

  const formatted = koreanRefinement.applySafeFormattingRepairs({ source, outputText: source });
  assert.equal(formatted.text.split('\n').every(line => /^\d+\.\s\S/u.test(line)), true, formatted.text);
  assert.equal(formatted.changeCounts.list_marker_spacing, 3);
});

test('v2.5.31: 긴 무구두점 자소서를 감사 단위로만 나눠 보존된 주장을 누락으로 오인하지 않는다', () => {
  const units = [
    '저는 고객 문의 데이터를 분석했습니다',
    '반복되는 불편 유형을 분류했습니다',
    '오류 사례를 같은 조건에서 재현했습니다',
    '자동화 도구를 개발했습니다',
    '처리 시간을 20% 줄였습니다',
    '매주 운영 지표를 검토했습니다',
    '팀과 개선 우선순위를 합의했습니다',
    '변경 내용을 문서화했습니다',
    '사용자 응답 시간을 다시 측정했습니다',
    '이 경험을 지원 직무의 운영 개선에 활용하겠습니다'
  ];
  const source = units.join(' ');
  const output = units.join('. ') + '.';
  assert.ok(source.length >= 180);
  const audit = resumeCoverage.auditResumeCoverage(source, output, {
    profile: 'resume_application',
    confidence: 0.95
  });
  assert.equal(audit.version, 7);
  assert.equal(audit.pass, true, JSON.stringify(audit));
});

test('v2.5.31: 명백한 원문 철자와 의존 명사 띄어쓰기를 보호 영역 밖에서 바로잡는다', () => {
  const source = '평가 기준을 LLM에계 전달하고 결과를 저장하게하고 체점이 끝난뒤 다음 첼린지를 시작했습니다.';
  const repaired = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment', targetRegister: 'professional' }
  });
  assert.equal(repaired.applied, true);
  assert.match(repaired.text, /LLM에게 전달/u);
  assert.match(repaired.text, /저장하게 하고/u);
  assert.match(repaired.text, /채점이 끝난 뒤/u);
  assert.match(repaired.text, /챌린지를/u);
  assert.match(stableCore.humanizeStableCore({ profile: 'report_assignment' }), /원문에 있던 명백한 오탈자/u);
});

test('v2.5.31: 건강한 문장 길이 변동 구간으로 정돈된 결과를 리듬 악화로 기록하지 않는다', () => {
  const build = lengths => lengths.map(length => `${'가'.repeat(length - 1)}.`).join(' ');
  const source = build([14, 24, 35, 55, 29, 48]);
  const output = build([20, 28, 36, 44, 52, 32]);
  const audit = naturalness.compareNaturalnessShadow(source, output);
  assert.equal(audit.version, 6);
  assert.equal(audit.rhythmComparable, true);
  assert.ok(audit.after.sentenceCv < audit.before.sentenceCv, JSON.stringify(audit));
  assert.ok(audit.after.sentenceCv >= 0.28, JSON.stringify(audit));
  assert.ok(audit.rhythmUniformityDelta <= 0, JSON.stringify(audit));
});
