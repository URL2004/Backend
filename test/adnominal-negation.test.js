'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');
const { reconcileFinalDelivery } = require('../lib/humanizeDeliveryPolicy');
const { CODE, introducedAdnominalNegations } = require('../engine-gpt-prod/adnominalNegation');
const args = (source, outputText) => ({ source, outputText, documentProfile: 'report_assignment', mode: 'assignment' });
const issue = (source, output) => korean.analyzeKoreanRefinement(args(source, output)).issues.find(item => item.code === CODE);

test('source-backed adnominal negation enters bounded language repair and retains a review warning', () => {
  const source = '도표의 간격이 커지는 것이 아니라 비교 기준이 달라진 것이다.';
  const output = '도표의 간격이 커지는 않을 것이며 비교 기준이 달라진 것이다.';
  const audit = korean.analyzeKoreanRefinement(args(source, output));
  const found = audit.issues.find(item => item.code === CODE);
  assert(found);
  assert.equal(found.introducedCount, 1);
  assert.equal(found.repairable, true);
  assert.equal(found.deterministicSafe, false);
  assert.deepEqual(found.sentenceOrdinals, [1]);
  assert.equal(audit.pass, false);
  assert(audit.repairableIssues.some(item => item.code === CODE));
  const warning = audit.residualWarnings.find(item => item.code === `korean_${CODE}`);
  assert(warning);
  assert.equal(warning.severity, 'warning');
  assert.equal(reconcileFinalDelivery({ qualityWarnings: [warning] }).decision, 'deliver_review');
  assert.equal(korean.applySafeDeterministicRepairs(args(source, output)).text, output, 'negation scope is never guessed by a replacement');
});

test('the same stem in a source negative frame proves an introduced grammar regression', () => {
  const source = '검토를 마친 뒤에도 저장된 기록은 바뀌지 않을 것이다.';
  const output = source.replace('바뀌지 않을', '바뀌는 않을');
  assert.equal(issue(source, output)?.introducedCount, 1);
  const integrity = auditCandidateIntegrity({ source, before: source, candidate: output, documentProfile: 'report_assignment', mode: 'assignment' });
  assert.equal(integrity.pass, false);
  assert(integrity.reasons.includes('korean_integrity_worsened'));
});

test('a short split arm is grounded by its unique adjacent clause words and source verb frame', () => {
  const source = '자료를 새로 정리한다고 해서 공공도서관의 기록방식이 바뀌는 것이 아니라, 기존의 분류 기준을 유지하면서 추가된 항목을 확인하고 자료의 보관 위치를 점검하는 절차를 보완하게 될 것이라고 판단했다.';
  const output = '자료를 정리해도 공공도서관의 기록방식이 바뀌는 않을 것이다.';
  assert.equal(issue(source, output)?.introducedCount, 1);
  assert.equal(issue(source + ' ' + source, output), undefined, 'repeated local anchors do not prove a unique owner');
  assert.equal(issue(source, output.replace('공공도서관의 기록방식이', '기록관의 업무방식이')), undefined);
});

test('legitimate contrastive negation, topic ellipsis and separated clauses are not adnominal defects', () => {
  const pairs = [
    ['검토를 마친 기록은 바뀌지 않을 것이다.', '검토를 마친 기록은 바뀌지는 않을 것이다.'],
    ['추가 검토를 하지 않을 것이다.', '추가 검토를 하지는 않을 것이다.'],
    ['나는 그 작업을 맡지 않겠다.', '나는 않겠다.'],
    ['부서는 해당 작업을 맡지 않기로 했다.', '부서는 않기로 했다.'],
    ['때로는 해당 작업을 하지 않기도 한다.', '때로는 않기도 한다.'],
    ['하는 사람과 하지 않는 사람을 모두 확인했다.', '하는 사람은 많지만 하지 않는 사람도 있다.'],
    ['기록을 순서대로 검토했다.', '검토 결과의 표기는 않을 것이다.']
  ];
  for (const [source, output] of pairs) assert.equal(issue(source, output), undefined);
});

test('quoted discussion and inline or fenced code do not create grammar findings', () => {
  const source = '검토를 마친 뒤에도 저장된 기록은 바뀌지 않을 것이다.';
  const bad = '검토를 마친 뒤에도 저장된 기록은 바뀌는 않을 것이다.';
  for (const output of [
    `“${bad}”라는 예시를 검토했다.`,
    `「${bad}」라는 예시를 검토했다.`,
    '`' + bad + '`',
    '```txt\n' + bad + '\n```',
    '~~~txt\n' + bad + '\n~~~',
    '> ' + bad
  ]) assert.equal(issue(source, output), undefined);
  assert.equal(issue('“' + source + '”', bad), undefined, 'a quoted source cannot prove an authored verb frame');
});

test('a source defect is inherited locally while a new defect in another sentence remains visible', () => {
  const old = '실험 장비의 조정 기록은 바뀌는 않을 것이다.';
  const valid = '회의에서 검토한 문서의 제출 순서는 바뀌지 않을 것이다.';
  assert.equal(issue(old, old), undefined);
  assert.equal(issue(old, old.replace('실험 장비', '측정 장비')), undefined);
  const source = old + ' ' + valid;
  const output = old.replace('바뀌는 않을', '바뀌지 않을') + ' ' + valid.replace('바뀌지 않을', '바뀌는 않을');
  assert.equal(issue(source, output)?.introducedCount, 1);
  assert.deepEqual(issue(source, output)?.sentenceOrdinals, [2]);
});

test('ambiguous source ownership and paragraph-separated tokens are not promoted to defects', () => {
  const source = '검토를 마친 기록은 바뀌지 않을 것이다.';
  const output = source.replace('바뀌지 않을', '바뀌는 않을');
  assert.equal(issue(source + ' ' + source, output), undefined);
  assert.equal(issue(source, output.replace('바뀌는 않을', '바뀌는\n\n않을')), undefined);
});

test('findings carry source coordinates and bounded metadata without copying prose', () => {
  const source = '기록은 바뀌지 않을 것이다.';
  const output = '기록은 바뀌는 않을 것이다.';
  const result = introducedAdnominalNegations(
    [{ start: 0, ordinal: 1, editable: source }],
    [{ start: 12, ordinal: 3, editable: output }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceOrdinal, 1);
  assert.equal(result[0].ordinal, 3);
  assert.equal(output.slice(result[0].outputStart - 12, result[0].outputEnd - 12), '바뀌는 않을');
  assert(!JSON.stringify(result).includes('기록'));
});
