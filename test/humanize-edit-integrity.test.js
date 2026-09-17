'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { splitSentences } = require('../engine/koreanText');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');
const documentProfile = { profile: 'academic_paper' };
const newCodes = ['introduced_demonstrative_loss', 'introduced_connective_corruption', 'introduced_naming_frame_inversion'];
const audit = (source, outputText) => korean.analyzeKoreanRefinement({ source, outputText, documentProfile });
const repair = (source, outputText) => korean.restoreIntroducedIntegritySentences({ source, outputText, audit: audit(source, outputText) });

test('source demonstratives survive paragraph splitting while nearby edits remain', () => {
  const source = '자료의 범위를 먼저 정했다. 이런 기준은 조사 대상의 범위를 제한한다. 이 방법은 반복 측정의 오차를 줄인다.';
  const output = '자료의 범위를 우선 정했다.\n\n기준은 조사 대상의 범위를 제한한다.\n\n방법은 반복 측정의 오차를 줄여 준다.';
  const before = audit(source, output);
  assert.equal(before.issues.find(row => row.code === newCodes[0]).introducedCount, 2);
  const result = repair(source, output);
  assert.equal(result.text, '자료의 범위를 우선 정했다.\n\n이런 기준은 조사 대상의 범위를 제한한다.\n\n이 방법은 반복 측정의 오차를 줄여 준다.');
  assert.equal(repair(source, result.text).applied, false);
});

test('generic subjects, retained synonyms, renamed subjects and ambiguous alignments stay intact', () => {
  for (const [source, output] of [
    ['기준은 자료의 범위를 제한한다.', '기준은 자료의 범위를 제한한다.'],
    ['이러한 기준은 자료의 범위를 제한한다.', '이 기준은 자료의 범위를 제한한다.'],
    ['이 기준은 자료의 범위를 제한한다.', '선정 기준은 자료의 범위를 제한한다.'],
    ['이 기준은 자료의 범위를 제한한다.', '“표본 선정” 기준은 자료의 범위를 제한한다.'],
    ['이 기준은 자료의 범위를 제한한다. 기준은 자료의 범위를 제한한다.', '기준은 자료의 범위를 제한한다.'],
    ['이 기준은 자료의 범위를 제한한다. 그 기준은 자료의 범위를 제한한다.', '기준은 자료의 범위를 제한한다.'],
    ['이 기준은 자료의 범위를 제한한다.', '기준은 인권이다.']
  ]) {
    assert.equal(audit(source, output).issueCodes.includes(newCodes[0]), false, output);
    assert.equal(korean.applySafeDeterministicRepairs({ source, outputText: output, documentProfile }).text, output);
  }
});

test('connector cleanup cannot remove a demonstrative modifying a noun', () => {
  const source = '기준은 자료의 범위를 제한한다.';
  const outputText = '이러한 기준은 자료의 범위를 제한한다.';
  const result = korean.removeIntroducedConnectorOpeners({ source, outputText,
    audit: { issues: [{ code: 'discourse_connector_inflation', introducedCount: 1, sentenceOrdinals: [1] }] } });
  assert.equal(result.text, outputText);
});

test('broken comparison ending is restored using its source context, preserving the rewritten clause', () => {
  const source = '차이가 측정 조건에 있듯이, 결과도 조건에 따라 달라진다.';
  const output = '차이가 측정 조건에 있기라면, 결과 역시 조건에 따라 달라진다.';
  assert.ok(audit(source, output).issueCodes.includes(newCodes[1]));
  assert.equal(repair(source, output).text, '차이가 측정 조건에 있듯이, 결과 역시 조건에 따라 달라진다.');
  const absent = '결함이 관찰 기록에 없듯이, 점검표에도 없다.';
  assert.equal(repair(absent, absent.replace('없듯이', '없기라면')).text, absent);
});

test('comparison repair needs source evidence and leaves real conditions and nominal quotations intact', () => {
  for (const text of [
    '차이가 측정 조건에 있다면, 재검사가 필요하다.',
    '취미가 그림 그리기라면 도구부터 준비한다.',
    '활동이 “함께 있기”라면 일정부터 맞춘다.',
    '차이가 측정 조건에 있기라면, 결과 역시 달라진다.'
  ]) {
    assert.equal(audit(text, text).issueCodes.includes(newCodes[1]), false);
    assert.equal(repair(text, text).text, text);
  }
  assert.equal(audit('차이가 처리 단계에 있듯이, 결과도 달라진다.',
    '차이가 측정 조건에 있기라면, 결과도 달라진다.').issueCodes.includes(newCodes[1]), false);
  const mixed = '차이가 측정 조건에 있듯이, 결과도 달라진다. 차이가 측정 조건에 있기라면, 결과 역시 달라진다.';
  assert.equal(audit(mixed, mixed).issueCodes.includes(newCodes[1]), false);
});

test('naming relation restoration changes exactly one sentence and keeps both neighboring arguments', () => {
  const source = '보고서는 관측값의 기준을 제시한다. 연구자는 그 기준을 안정성이라 부르고, 반복 측정으로 설명한다. 결과는 다음 실험에 적용한다.';
  const output = '보고서는 관측값을 판단할 기준을 제시한다. 안정성이 그 기준이라고 연구자는 부르며, 반복 측정으로 설명한다.\n\n결과를 다음 실험에 적용한다.';
  assert.ok(audit(source, output).issueCodes.includes(newCodes[2]));
  const result = repair(source, output);
  assert.equal(result.text, '보고서는 관측값을 판단할 기준을 제시한다. 연구자는 그 기준을 안정성이라 부르고, 반복 측정으로 설명한다.\n\n결과를 다음 실험에 적용한다.');
  assert.equal(splitSentences(result.text).length, splitSentences(output).length);
  assert.equal(repair(source, result.text).applied, false);
});

test('valid object fronting and source-authored emphasis are not naming inversions', () => {
  const source = '연구자는 그 기준을 안정성이라 부른다.';
  for (const output of ['그 기준을 안정성이라고 연구자는 부른다.', '연구자는 그 기준을 안정성이라고 부른다.']) {
    assert.equal(audit(source, output).issueCodes.includes(newCodes[2]), false);
  }
  const emphasized = '반복 측정의 기준이 되는 것이 안정성이다.';
  assert.equal(repair(emphasized, emphasized).text, emphasized);
});

test('quoted text, code, headings, lists, tables and references are never edited by source-backed repairs', () => {
  const source = '이 기준은 자료의 범위를 제한한다. 차이가 측정 조건에 있듯이, 결과도 달라진다.';
  const bad = '기준은 자료의 범위를 제한한다. 차이가 측정 조건에 있기라면, 결과도 달라진다.';
  for (const output of [
    `“${bad}”라는 문장을 인용했다.`,
    `“${'긴 인용 내용을 그대로 보존한다. '.repeat(30)}${bad}”라는 기록이다.`,
    `“앞 내용을 인용한다.\n\n${bad}”라는 기록이다.`,
    `확인 대상은 \`${bad}\`이다.`,
    `\`\`\`text\n${bad}\n\`\`\``,
    `# ${bad}`, `- ${bad}`, `| 본문 | ${bad} |`, `참고문헌\n${bad}`
  ]) {
    assert.deepEqual(audit(source, output).issueCodes.filter(code => newCodes.includes(code)), [], output);
  }
});

test('source-backed repairs are length-independent and preserve CRLF paragraph boundaries', () => {
  const filler = Array.from({ length: 25 }, (_, i) => `자료 ${i + 1}의 출처를 확인했다.`).join(' ');
  const source = `${filler}\r\n\r\n이 기준은 자료의 범위를 제한한다.`;
  const output = `${filler}\r\n\r\n기준은 자료의 범위를 제한한다.`;
  assert.equal(repair(source, output).text, source);
});

test('candidate gate rejects a later rewrite that drops a referent or breaks the comparison ending', () => {
  for (const [source, candidate] of [
    ['이 기준은 자료의 범위를 제한한다.', '기준은 자료의 범위를 제한한다.'],
    ['차이가 측정 조건에 있듯이, 결과도 달라진다.', '차이가 측정 조건에 있기라면, 결과도 달라진다.']
  ]) {
    const result = auditCandidateIntegrity({ source, before: source, candidate, documentProfile });
    assert.equal(result.pass, false);
    assert.ok(result.reasons.includes('korean_integrity_worsened'));
    const fixed = repair(source, candidate).text;
    assert.equal(auditCandidateIntegrity({ source, before: candidate, candidate: fixed, documentProfile }).pass, true);
  }
});
