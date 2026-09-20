'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSentenceSpans } = require('../engine/koreanText');
const { buildDetectInputDocument } = require('../lib/detectInputDocument');

test('citation initials do not inflate prose counts or lose source offsets', () => {
  const text = Array.from({ length: 3 }, (_, i) => `관측 ${i}의 결과를 확인했다 (Alpha, A. B., Gamma, C. D., 2024).`).join(' ');
  const spans = splitSentenceSpans(text);
  assert.equal(spans.length, 3);
  assert.equal(buildDetectInputDocument(text).eligibleSentenceCount, 3);
  for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
});
test('complete quotes are excluded consistently while short emphasis remains prose', () => {
  for (const [open, close] of [['“','”'], ['‘','’'], ['"','"'], ["'","'"], ['「','」'], ['『','』'], ['《','》'], ['〈','〉']]) {
    assert.equal(buildDetectInputDocument(`${open}첫 결과를 보았다. 다음 결과를 확인했다.${close}`).eligibleSentenceCount, 0);
    assert.equal(buildDetectInputDocument(`${open}효과${close}를 조사했다.`).eligibleSentenceCount, 1);
  }
});
test('inline and fenced code share exclusion and CRLF offsets stay exact', () => {
  for (const code of ['`a. b. c.`', '```a. b. c.```', '```js\r\na. b. c.\r\n```', '~~~js\na. b. c.\n~~~']) {
    const text = `  ${code}\r\n\r\n일반 문장을 조사했다. `;
    const doc = buildDetectInputDocument(text);
    assert.equal(doc.eligibleSentenceCount, 1);
    for (const span of doc.sentences) assert.equal(text.slice(span.start, span.end), span.text);
  }
});
test('nested quotation and apostrophes do not swallow adjacent prose', () => {
  const text = '“연구자는 ‘결과를 보았다.’고 말했다.” 다음 결과를 기록했다.';
  assert.equal(buildDetectInputDocument(text).eligibleSentenceCount, 1);
  assert.equal(splitSentenceSpans("It's valid. Another result follows.").length, 2);
});

test('Korean particles close nested term quotes while Latin contractions stay words', () => {
  const { syntaxSpans } = require('../engine/textSyntax');
  for (const [open, close] of [['‘','’'], ["'","'"]]) {
    const text = `“먼저 ${open}검증${close}을 했다. 결과를 기록했다.” 다음 문장을 분석했다.`;
    const quotes = syntaxSpans(text).filter(s => s.spanType === 'quote');
    assert.equal(quotes.length, 2);
    assert.equal(text.slice(quotes[0].start, quotes[0].end), text.slice(0, text.indexOf('”') + 1));
    assert.equal(buildDetectInputDocument(text).eligibleSentenceCount, 1);
    // Two quoted sentences plus one author sentence; detection excludes the former.
    assert.equal(splitSentenceSpans(text).length, 3);
  }
  for (const text of ["Don't stop. It's valid.", 'Don’t stop. It’s valid.']) {
    assert.equal(syntaxSpans(text).filter(s => s.spanType === 'quote').length, 0);
    assert.equal(splitSentenceSpans(text).length, 2);
  }
});

test('initial sequences remain intact in names and quotation variants, not just parentheses', () => {
  for (const text of [
    '연구자 A. B. Smith는 결과를 발표했다. 다음 문장이다.',
    '인용에는 “A. B. 연구자가 말했다.”라고 적었다. 다음 결과를 보았다.',
    '이름 “A. B.”를 확인했다. 다른 문장이다.'
  ]) assert.equal(splitSentenceSpans(text).length, 2, text);
  for (const [open, close] of [['“','”'], ['‘','’'], ['「','」'], ['"','"']]) {
    const doc = buildDetectInputDocument(`이름 ${open}A. B.${close}를 확인했다. 다른 문장이다.`);
    assert.equal(doc.eligibleSentenceCount, 2);
    assert.equal(doc.protectedSpans.length, 0);
  }
  assert.equal(splitSentenceSpans('이번 등급은 B. 다음에는 개선한다.').length, 2);
});

test('OCR heading recovery never cuts noun-derived predicates or decimal section IDs', () => {
  const preflight = require('../engine-gpt-prod/sourcePreflight');
  const structure = require('../engine-gpt-prod/structureChunk');
  const layout = require('../engine-gpt-prod/layoutStructure');
  for (const text of [
    '3.1 공정 간 연계성 Alpha, Beta, Gamma는 제조 과정에서 독립된 단위 공정으로 기능하는 것이 아니라 서로 연결된 순환 구조를 이룬다. 각 단계는 다음 단계의 결과에 영향을 미친다.',
    '2.3 처리 과정 장치는 입력 자료를 분석하고 그 결과를 저장한다. 기록된 자료는 검증 과정을 거쳐 다음 단계의 판단에 활용된다.'
  ]) {
    const result = preflight.repairInlineHeadingBoundaries(text).text;
    assert.doesNotMatch(result, /(?:기능|분석)\n/);
    assert.equal(result.replace(/\s/gu,''),text.replace(/\s/gu,''));
    const prefix = layout.listPrefixParts(result);
    assert.match(prefix.prefix, /^\d+\.\d+\s+$/);
    const chunks = structure.splitChunksForGpt(result).chunks;
    assert.ok(chunks.every(chunk => !/^(?:하는|하고)\s/u.test(chunk.text)));
  }
  assert.equal(layout.listPrefixParts('3.14는 원주율의 근삿값이다.'), null);
});

test('repeated form headings stay separate when label values occupy the next line', () => {
  const layout = require('../engine-gpt-prod/layoutStructure');
  const source = [
    '자료를 검토하면서 독립된 여러 관점을 비교하였다.',
    '관심 분야와 관련하여 새롭게 느낀 점', '자료 내용:',
    '자료에서 다양한 관점의 참여가 필요하다는 사실을 확인하였다.',
    '개인 의견:', '나는 논의를 폭넓게 검토하는 과정이 중요하다고 생각한다.',
    '관심 분야와 관련하여 질문 만들기', '질문:',
    '서로 다른 관점을 충분히 반영하려면 어떤 과정이 필요한가?',
    '답변:', '나는 의견을 공개적으로 비교하는 절차가 필요하다고 생각한다.'
  ].join('\n');
  const records = layout.buildLineRecords(source);
  for (const line of records.filter(row => row.text.startsWith('관심 분야'))) assert.equal(line.role, 'heading');
  assert.equal(records.find(row => row.text.startsWith('나는 논의')).role, 'prose');
});

test('receiving an action versus performing it is a grounded review candidate, not a blocking verdict', () => {
  const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
  for (const noun of ['질문', '교육', '평가']) {
    const source = `나는 사례를 입력하고 필요한 내용을 ${noun}받아 입체적으로 학습했다.`;
    const changed = `나는 사례를 입력하고 필요한 내용을 ${noun}해 입체적으로 학습했다.`;
    const audit = auditRelationCandidates(source, changed);
    assert.ok(audit.codes.includes('action_direction_candidate'));
    assert.equal(audit.candidateOnly, true);
    assert.equal(auditRelationCandidates(source, source).codes.includes('action_direction_candidate'), false);
  }
});

test('full nominal report items keep ownership rather than collapsing as PDF wraps', () => {
  const { repairForcedProseWraps } = require('../engine-gpt-prod/sourcePreflight');
  const lines = [
    '지역에 분산된 여러 자원과 시설을 하나의 주제에 맞게 연결하여 주민이 공동으로 이용할 수 있는 서비스로 활용',
    '개별 기관에서 각각 추진하던 사업을 서로 연계하여 중복되는 행정 절차와 예산 낭비를 줄이는 관리 체계 구축',
    '공동 사업을 꾸준하게 추진할 수 있도록 각 기관의 역할과 지원 범위를 명확하게 정하는 운영 기준 마련'
  ];
  const result = repairForcedProseWraps(lines.join('\n'));
  assert.equal(result.text, lines.join('\n\n'));
  assert.equal(repairForcedProseWraps(result.text).text,result.text);
});
