'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditRepeatability } = require('../engine-gpt-prod/repeatabilityAudit');

test('반복 실행 결과가 달라도 숫자·직접 인용·화자·구조를 모두 보존하면 통과한다', () => {
  const source = [
    '1. 조사 목표',
    '나는 학생 20명의 응답을 확인했다.',
    '● 핵심 진술: “자료를 먼저 확인한다.”'
  ].join('\n');
  const report = auditRepeatability({
    source,
    outputs: [
      ['1. 조사 목표', '학생 20명의 응답을 나는 직접 확인했다.', '● 핵심 진술: “자료를 먼저 확인한다.”'].join('\n'),
      ['1. 조사 목표', '나는 응답을 남긴 학생 20명의 기록을 살폈다.', '● 핵심 진술: “자료를 먼저 확인한다.”'].join('\n'),
      ['1. 조사 목표', '학생 20명의 응답 기록은 내가 확인했다.', '● 핵심 진술: “자료를 먼저 확인한다.”'].join('\n')
    ],
    documentProfile: 'report_assignment',
    mode: 'assignment'
  });
  assert.equal(report.runCount, 3);
  assert.equal(report.pass, true);
  assert.equal(report.failedRunCount, 0);
  assert.deepEqual(report.failureCodes, []);
});

test('반복 실행 한 건이라도 숫자나 직접 인용을 바꾸면 실패 원인만 요약한다', () => {
  const source = '나는 학생 20명을 조사했고 “자료를 먼저 확인한다.”라고 기록했다.';
  const report = auditRepeatability({
    source,
    outputs: [
      '나는 학생 20명을 조사한 뒤 “자료를 먼저 확인한다.”라고 기록했다.',
      '나는 학생 21명을 조사한 뒤 “자료를 나중에 확인한다.”라고 기록했다.'
    ],
    documentProfile: 'report_assignment',
    mode: 'assignment'
  });
  assert.equal(report.pass, false);
  assert.equal(report.passedRunCount, 1);
  assert.equal(report.failedRunCount, 1);
  assert.ok(report.failureCodes.includes('number_multiset_changed'));
  assert.ok(report.failureCodes.includes('quote_content_changed'));
  assert.equal(report.runs[1].numberChanged, true);
  assert.equal(report.runs[1].quoteContentChanged, true);
  assert.equal('output' in report.runs[1], false);
});
