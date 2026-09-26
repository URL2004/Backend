'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFragmentIntegrity } = require('../engine-gpt-prod/fragmentIntegrity');

test('flags a newly orphaned ending after the PDF prefix was rewritten as a full sentence', () => {
  const source = '실험에서는 같은 조건을 사용했습니\n\n다. 이후 세 차례 측정을 반복하였다.';
  const output = '실험에는 동일한 조건을 적용했습니다.\n\n다. 이후 세 차례 측정을 반복하였다.';
  const audit = auditFragmentIntegrity(source, output);
  assert.equal(audit.pass, false);
  assert.deepEqual(audit.codes, ['introduced_orphan_ending']);
  assert.equal(output.slice(audit.issues[0].outputStart, audit.issues[0].outputEnd), '다.');
  assert.equal(JSON.stringify(audit).includes('실험'), false);
});

test('finds independent new tails including standalone final 다 and preserves CRLF/UTF16 offsets', () => {
  const source = '🙂 첫 기록에는 동일한 조건을 적었습니\r\n\r\n다.\r\n결론에서는 다음 단계의 조건을 정했습니\r\n\r\n다.';
  const output = '🙂 첫 기록에는 같은 조건을 적었습니다.\r\n\r\n다.\r\n결론에서는 다음 단계의 조건을 정했습니다.\r\n\r\n다.';
  const audit = auditFragmentIntegrity(source, output);
  assert.equal(audit.issueCount, 2);
  for (const issue of audit.issues) assert.equal(output.slice(issue.outputStart, issue.outputEnd), '다.');
});

test('does not call existing damage or a properly rejoined Korean word a new failure', () => {
  const source = '첫 번째 측정 결과를 정리했습니다.\n\n다. 마지막으로 기록을 보관했다.';
  assert.equal(auditFragmentIntegrity(source, source).pass, true);
  assert.equal(auditFragmentIntegrity(source, source.replace('첫 번째', '최초의')).pass, true);
  assert.equal(auditFragmentIntegrity('결과를 자세히 기록했습니\n\n다.', '결과를 자세하게 기록했습니다.').pass, true);
});

test('genuine 가나다 outlines remain protected, including markers separated from their body', () => {
  const source = '가.\n첫 번째 항목을 자세히 설명한다.\n나.\n두 번째 항목을 자세히 설명한다.\n다.\n세 번째 항목을 자세히 설명한다.';
  const output = source.replace('첫 번째 항목을 자세히 설명한다.', '첫째 항목에서는 조건을 상세히 설명한다.');
  assert.equal(auditFragmentIntegrity(source, output).pass, true);
  assert.equal(auditFragmentIntegrity('가. 첫 설명이다.\n나. 두 번째 설명이다.\n다. 세 번째 설명이다.', '가. 먼저 설명한다.\n나. 두 번째 설명을 충분히 제시한다.\n다. 마지막 설명이다.').pass, true);
});

test('does not report literal ending fragments in quotes, code, blockquotes or explicit tables', () => {
  const bodies = [
    '“이 문장은 글자를 소개하는 예문입니다.\n다. 이 글자를 그대로 기록했다.”',
    '```text\n이 문장은 글자를 소개하는 예문입니다.\n다. 이 글자를 그대로 기록했다.\n```',
    '> 이 문장은 글자를 소개하는 예문입니다.\n> 다. 이 글자를 그대로 기록했다.',
    '| 문장은 표의 예문입니다. |\n| 다. | 글자 |',
    '이 문장은 표의 예문입니다.\t설명\n다.\t글자',
    '이 문장은 표의 예문입니다.\n다.    글자'
  ];
  for (const body of bodies) assert.equal(auditFragmentIntegrity('다른 본문을 작성했습니다.', body).pass, true, body);
});

test('new extra orphan remains visible when one source orphan already exists', () => {
  const source = '처음 조건을 기록했습니다.\n다. 다음 조건을 살폈다.\n마지막 값은 그대로 사용했습니\n다.';
  const output = '처음 조건을 기록했습니다.\n다. 다음 조건을 살폈다.\n마지막 값은 변경 없이 사용했습니다.\n다.';
  const audit = auditFragmentIntegrity(source, output);
  assert.equal(audit.issueCount, 1);
  assert.equal(audit.issues[0].outputStart, output.lastIndexOf('다.'));
});

test('flags an exact source physical-tail duplicate after its predicate was already completed', () => {
  const source = '검사 담당자는 모든 참가자에게 동일한 측정 도구를\n\n제공해야 합니다. 다음 검사는 오전에 시작합니다.';
  const output = '검사 담당자는 참가자 모두에게 동일한 측정 도구를 제공해야 합니다.\n\n제공해야 합니다. 다음 검사는 오전에 시작합니다.';
  const audit = auditFragmentIntegrity(source, output);
  assert.deepEqual(audit.codes, ['introduced_duplicate_predicate_tail']);
  assert.equal(output.slice(audit.issues[0].outputStart, audit.issues[0].outputEnd), '제공해야 합니다.');
  assert.equal(source.slice(audit.issues[0].sourceStart, audit.issues[0].sourceEnd), '제공해야 합니다.');
});

test('flags narrow 해 주어야/해야 tail variation without performing a repair', () => {
  const source = '안내 담당자는 방문자가 읽을 수 있는 설명서를\n\n제공해주어야 합니다.';
  const output = '안내 담당자는 방문자에게 읽기 쉬운 설명서를 제공해야 합니다.\n\n제공해주어야 합니다.';
  const audit = auditFragmentIntegrity(source, output);
  assert.equal(audit.pass, false);
  assert.deepEqual(audit.codes, ['introduced_duplicate_predicate_tail']);
  assert.equal(Object.hasOwn(audit, 'text'), false);
});

test('does not flag a proper tail join, a different predicate or an already repeated source', () => {
  const source = '검사 담당자는 모든 참가자에게 동일한 측정 도구를\n제공해야 합니다.';
  assert.equal(auditFragmentIntegrity(source, '검사 담당자는 참가자 모두에게 동일한 측정 도구를 제공해야 합니다.').pass, true);
  assert.equal(auditFragmentIntegrity(source, '검사 담당자는 측정 도구를 확인해야 합니다.\n제공해야 합니다.').pass, true);
  const existing = '검사 담당자는 모든 참가자에게 동일한 측정 도구를 제공해야 합니다.\n제공해야 합니다.';
  assert.equal(auditFragmentIntegrity(existing, existing.replace('동일한', '똑같은')).pass, true);
});

test('ambiguous repeated source-tail ownership and non-predicate full sentences are not guessed', () => {
  const source = '검사 담당자는 모든 참가자에게 동일한 도구를\n제공해야 합니다.\n진행자는 옆 교실의 참가자들에게 동일한 도구를\n제공해야 합니다.';
  const output = '검사 담당자는 참가자 모두에게 동일한 도구를 제공해야 합니다.\n제공해야 합니다.';
  assert.equal(auditFragmentIntegrity(source, output).pass, true);
  const fullSentence = '연구 배경을 설명하면서\n자료는 학교가 제공합니다.';
  assert.equal(auditFragmentIntegrity(fullSentence, '연구 배경을 설명한다. 자료는 학교가 제공합니다.\n자료는 학교가 제공합니다.').pass, true);
});

test('the issue payload remains bounded for adversarial line-fragment input', () => {
  const source = '정상적인 시험 조건만 기록했습니다.';
  const output = Array.from({ length: 75 }, (_, index) => `항목 ${index}의 조건은 모두 확인했습니다.\n다.`).join('\n');
  const audit = auditFragmentIntegrity(source, output);
  assert.equal(audit.issueCount, 75);
  assert.equal(audit.issues.length, 40);
  assert.equal(audit.truncated, true);
});
