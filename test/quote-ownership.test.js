'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseQuoteOwnership,
  auditQuoteOwnership,
  restoreOwnedQuotes,
  restoreOwnedQuoteLayout,
  assessLegacyQuoteRestore
} = require('../engine-gpt-prod/quoteOwnership');

// 모든 예문은 합성 문장이다. 실제 사용자 원문을 넣지 않는다.
const QUOTE_A = '“오늘 우리는 새로운 길을 함께 걷기로 약속했습니다.”';

test('quote-dense documents preserve exact occurrences and still detect a missing occurrence', () => {
  const quotes = Array.from({ length: 1200 }, (_, i) => `“기록 ${i}번을 검토한다.”`);
  const source = quotes.join(' ');
  assert.equal(auditQuoteOwnership(source, source).pass, true);
  const missing = auditQuoteOwnership(source, quotes.filter((_, i) => i !== 600).join(' '));
  assert.equal(missing.pass, false);
  assert.equal(missing.missingCount, 1);
});
const QUOTE_B = '“내일도 같은 마음으로 서로를 돕겠다고 다짐했습니다.”';
const QUOTE_C = '“전혀 다른 문장을 모델이 새로 만들어 넣었습니다.”';
const MALFORMED_SOURCE = '## 장\n그는 “지금 바로 출발한다.“\n다음 문단이다.';
const MALFORMED_REWRITTEN = '## 장\n그는 “이제 곧 떠나겠다.“\n다음 문단이다.';

test('unchanged source passes and is not a vacuous zero count', () => {
  const source = `## 장\n가는 ${QUOTE_A}라고 말했다.`;
  const audit = auditQuoteOwnership(source, source);
  assert.equal(audit.pass, true);
  assert.equal(audit.exact, true);
  assert.equal(audit.sourceCount, 1);
  const restored = restoreOwnedQuotes(source, source);
  assert.equal(restored.applied, false);
  assert.equal(restored.reason, 'quote_ownership_pass');
  assert.equal(restored.text, source);
});

test('multiline proper quote stays 1 -> 1 when a blank line is inserted inside it', () => {
  const source = '## 장\n그는 “첫 줄은 이렇게 말한다.\n둘째 줄도 이어진다.”라고 했다.';
  const output = '## 장\n그는 “첫 줄은 이렇게 말한다.\n\n둘째 줄도 이어진다.”라고 했다.';
  const audit = auditQuoteOwnership(source, output);
  assert.equal(audit.pass, true);
  assert.equal(audit.sourceCount, 1);
  assert.equal(audit.outputCount, 1);
  assert.equal(audit.multilineSourceCount, 1);
  assert.equal(audit.contentChanged, false);
});

test('exact malformed same-glyph quote passes with a non-zero owned count', () => {
  const audit = auditQuoteOwnership(MALFORMED_SOURCE, MALFORMED_SOURCE);
  assert.equal(audit.pass, true);
  assert.equal(audit.malformedSourceCount, 1);
  assert.equal(audit.sourceCount, 1);
  const kinds = parseQuoteOwnership(MALFORMED_SOURCE).candidates.map(candidate => candidate.kind);
  assert.deepEqual(kinds, ['same_glyph_close']);
});

test('rewritten malformed quote fails and is restored only from its section slot', () => {
  const audit = auditQuoteOwnership(MALFORMED_SOURCE, MALFORMED_REWRITTEN);
  assert.equal(audit.pass, false);
  assert.equal(audit.contentChanged, true);
  assert.equal(audit.missingCount, 1);
  const restored = restoreOwnedQuotes(MALFORMED_SOURCE, MALFORMED_REWRITTEN);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, MALFORMED_SOURCE);
  assert.equal(restored.auditAfter.pass, true);
});

test('same-glyph close is refused when a real closer follows in the paragraph', () => {
  const source = '그는 “첫 말이다.“\n그리고 끝 말”';
  const kinds = parseQuoteOwnership(source).candidates.map(candidate => candidate.kind);
  assert.ok(!kinds.includes('same_glyph_close'));
  assert.ok(kinds.includes('unresolved'));
});

test('ordinal shift A,B => B,C is not restored and legacy ordinal repair is vetoed', () => {
  const source = `## 장\n가는 ${QUOTE_A}라고 말했다.\n나는 ${QUOTE_B}라고 답했다.`;
  const output = `## 장\n가는 ${QUOTE_B}라고 말했다.\n나는 ${QUOTE_C}라고 답했다.`;
  const audit = auditQuoteOwnership(source, output);
  assert.equal(audit.pass, false);
  assert.equal(audit.missingCount, 1);
  const restored = restoreOwnedQuotes(source, output);
  assert.equal(restored.applied, false);
  assert.equal(restored.text, output);
  const legacyOrdinal = `## 장\n가는 ${QUOTE_A}라고 말했다.\n나는 ${QUOTE_B}라고 답했다.`;
  const verdict = assessLegacyQuoteRestore(source, output, legacyOrdinal);
  assert.equal(verdict.veto, true);
  assert.equal(verdict.reason, 'legacy_restore_overwrote_source_quote');
});

test('safe legacy content repair in the same slot is not vetoed', () => {
  const source = `## 장\n가는 ${QUOTE_A}라고 말했다.`;
  const output = `## 장\n가는 ${QUOTE_C}라고 말했다.`;
  const verdict = assessLegacyQuoteRestore(source, output, source);
  assert.equal(verdict.veto, false);
});

test('missing delimiter is restored inside its own section only', () => {
  const source = '## 첫째 장\n그는 “이 문장은 충분히 길게 쓴 직접 인용이다.”라고 적었다.';
  const output = '## 첫째 장\n그는 이 문장은 충분히 길게 쓴 직접 인용이다.라고 적었다.';
  const restored = restoreOwnedQuotes(source, output);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('cross-section phrase is never quoted in the wrong section', () => {
  const source = [
    '## 첫째 장',
    '그는 “이 문장은 충분히 길게 쓴 직접 인용이다.”라고 적었다.',
    '## 둘째 장',
    '다른 곳에서도 이 문장은 충분히 길게 쓴 직접 인용이다.'
  ].join('\n');
  const output = [
    '## 첫째 장',
    '그는 그렇게 적었다.',
    '## 둘째 장',
    '다른 곳에서도 이 문장은 충분히 길게 쓴 직접 인용이다.'
  ].join('\n');
  const restored = restoreOwnedQuotes(source, output);
  assert.equal(restored.applied, false);
  assert.equal(restored.text, output);
  assert.equal(restored.auditAfter.pass, false);
  const globallyWrapped = output.replace(
    '이 문장은 충분히 길게 쓴 직접 인용이다.',
    '“이 문장은 충분히 길게 쓴 직접 인용이다.”'
  );
  const verdict = assessLegacyQuoteRestore(source, output, globallyWrapped);
  assert.equal(verdict.veto, true);
  assert.equal(verdict.reason, 'legacy_restore_inserted_unowned_quote');
});

test('unclosed source quote does not consume the following heading', () => {
  const source = '1. 서론\n그는 “끝나지 않은 인용이 여기서 시작되고\n2. 본론\n본문은 계속된다.” 이후 문장.';
  const parsed = parseQuoteOwnership(source);
  const headingStart = source.indexOf('2. 본론');
  assert.equal(parsed.sections.length, 3);
  for (const candidate of parsed.candidates) {
    const section = parsed.sections[candidate.section];
    assert.ok(candidate.start >= section.start && candidate.end <= section.end);
    assert.ok(!(candidate.start < headingStart && candidate.end > headingStart));
  }
  assert.deepEqual(parsed.candidates.map(candidate => candidate.reason), ['unclosed', 'stray_close']);
  const unchanged = auditQuoteOwnership(source, source);
  assert.equal(unchanged.pass, true);
  assert.equal(unchanged.sourceCount, 2);
  const rewritten = source.replace('여기서 시작되고', '다른 말로 바뀌고');
  const audit = auditQuoteOwnership(source, rewritten);
  assert.equal(audit.pass, false);
  assert.ok(audit.unresolvedCount > 0);
  const restored = restoreOwnedQuotes(source, rewritten);
  assert.equal(restored.applied, false);
  assert.equal(restored.text, rewritten);
});

test('nested quote is unresolved, never same-glyph closed or restored', () => {
  const source = '그는 “밖의 말 “안의 말” 끝 말”이라고 했다.';
  const parsed = parseQuoteOwnership(source);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].kind, 'unresolved');
  assert.equal(parsed.candidates[0].reason, 'nested_or_ambiguous');
  const output = '그는 “밖의 말 “바뀐 말” 끝 말”이라고 했다.';
  const audit = auditQuoteOwnership(source, output);
  assert.equal(audit.pass, false);
  assert.equal(audit.contentChanged, true);
  const restored = restoreOwnedQuotes(source, output);
  assert.equal(restored.applied, false);
  assert.equal(restored.text, output);
});

test('CRLF source and LF output share offsets and CRLF output keeps CRLF after restore', () => {
  const lfSource = '## 장\n그는 “첫 줄은 이렇게 말한다.\n둘째 줄도 이어진다.”라고 했다.';
  const crlfSource = lfSource.replace(/\n/gu, '\r\n');
  assert.equal(auditQuoteOwnership(crlfSource, lfSource).pass, true);
  assert.deepEqual(
    parseQuoteOwnership(crlfSource).candidates.map(candidate => [candidate.start, candidate.end]),
    parseQuoteOwnership(lfSource).candidates.map(candidate => [candidate.start, candidate.end])
  );
  const crlfOutput = MALFORMED_REWRITTEN.replace(/\n/gu, '\r\n');
  const restored = restoreOwnedQuotes(MALFORMED_SOURCE, crlfOutput);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, MALFORMED_SOURCE.replace(/\n/gu, '\r\n'));
});

test('dropped copy of repeated direct speech is missing, not restored by guess', () => {
  const source = `## 장\n가는 ${QUOTE_A}라고 했다.\n나도 ${QUOTE_A}라고 했다.`;
  const output = `## 장\n가는 ${QUOTE_A}라고 했다.\n나도 그렇게 했다.`;
  const audit = auditQuoteOwnership(source, output);
  assert.equal(audit.pass, false);
  assert.equal(audit.missingCount, 1);
  const restored = restoreOwnedQuotes(source, output);
  assert.equal(restored.applied, false);
});

test('short repeated term quotes stay with the legacy audit', () => {
  const source = '“사랑”이라는 단어는 흔하다. 다시 “사랑”을 말한다.';
  const output = '“사랑”이라는 단어는 흔하다. 다시 사랑을 말한다.';
  const audit = auditQuoteOwnership(source, output);
  assert.equal(audit.pass, true);
  assert.equal(audit.sourceCount, 0);
});

test('quotes inside code and across citation prefixes are not owned spans', () => {
  const source = '예시는 `“코드 안 문장이다.“` 이다.\n그는 “출처 앞에서 끝난 문장이다.“ (출처: 합성 자료)';
  const parsed = parseQuoteOwnership(source);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].kind, 'same_glyph_close');
  assert.ok(parsed.candidates[0].end <= source.indexOf('(출처'));
});

// 보고서형 합성 고정물: 절마다 긴 인용 하나, 닫는 자리의 “, 뒤따르는 교재 참고.
function longBody(tag, count) {
  return Array.from({ length: count }, (_, index) => (
    `${tag} 합성 문장 ${index + 1}번은 인용 구간의 길이를 늘리려고 만든 예시이다.`
  )).join(' ');
}

function withInnerBlankLine(body) {
  const cut = body.indexOf('. ', Math.floor(body.length / 2));
  return `${body.slice(0, cut + 1)}\n\n${body.slice(cut + 2)}`;
}

const BODY_ONE = longBody('가', 45);
const BODY_TWO_HEAD = '반면 이 합성 단락은 첫 줄이 짧게 끝난다.';
const BODY_TWO_TAIL = longBody('나', 40);
const BODY_THREE = longBody('다', 12);
const QUOTE_ONE = `“${BODY_ONE}”`;
const QUOTE_TWO = `“${BODY_TWO_HEAD}\n${BODY_TWO_TAIL}“`;
const QUOTE_THREE = `“${BODY_THREE}“`;
const REPORT_SOURCE = [
  '합성 보고서 제목',
  '1. 합성 개요',
  '1) 첫째 배경',
  `${QUOTE_ONE}  p.10~11 1.1. 합성 배경`,
  '교재 참고: p.10~11 1.1. 합성 배경',
  '',
  '2) 둘째 정의',
  `${QUOTE_TWO} 교재 참고: p.12 1.2. 합성 정의`,
  '교재 참고: p.12 1.2. 합성 정의',
  '',
  ' 2. 합성 목표',
  '1) 셋째 원리',
  `${QUOTE_THREE}  교재참고: p.13 합성 원리`,
  '',
  '참고: p.13 합성 원리'
].join('\n');

// 빈 줄 삽입, 닫는 글리프 정규화, 인라인 출처의 행 분리가 일어난 결과.
const REPORT_LAYOUT_OUTPUT = [
  '합성 보고서 제목', '',
  '1. 합성 개요', '',
  '1) 첫째 배경', '',
  `“${withInnerBlankLine(BODY_ONE)}” p.10~11 1.1. 합성 배경`,
  '교재 참고: p.10~11 1.1. 합성 배경', '',
  '2) 둘째 정의', '',
  `“${BODY_TWO_HEAD}\n\n${withInnerBlankLine(BODY_TWO_TAIL)}”`,
  '교재 참고: p.12 1.2. 합성 정의 교재 참고: p.12 1.2. 합성 정의', '',
  '2. 합성 목표', '',
  '1) 셋째 원리', '',
  `“${withInnerBlankLine(BODY_THREE)}“  교재참고: p.13 합성 원리`, '',
  '참고: p.13 합성 원리'
].join('\n');

test('교재 참고 and plain 참고 prefixes bound a malformed closing quote', () => {
  for (const prefix of ['교재 참고:', '교재참고:', '참고:', '교재 참고 :']) {
    const source = `## 장\n그는 “이 문장은 출처 앞에서 끝나는 합성 인용이다.“ ${prefix} p.3 합성 자료`;
    const parsed = parseQuoteOwnership(source);
    assert.equal(parsed.candidates.length, 1, prefix);
    assert.equal(parsed.candidates[0].kind, 'same_glyph_close', prefix);
    assert.ok(parsed.candidates[0].end <= source.indexOf(prefix.slice(0, 2)), prefix);
    const rewritten = source.replace('출처 앞에서 끝나는', '다른 말로 바뀐');
    assert.equal(auditQuoteOwnership(source, rewritten).pass, false, prefix);
  }
  const embedded = parseQuoteOwnership('비참고: 이 표기는 접두부가 아니다.');
  assert.deepEqual(embedded.cuts, [0, embedded.text.length]);
});

test('report-shaped source owns every long quote without a length-based vacuous pass', () => {
  assert.ok(BODY_ONE.length > 1200);
  assert.ok(QUOTE_TWO.length > 1200);
  const parsed = parseQuoteOwnership(REPORT_SOURCE);
  assert.deepEqual(parsed.candidates.map(candidate => candidate.kind), ['closed', 'same_glyph_close', 'same_glyph_close']);
  for (const candidate of parsed.candidates) {
    const section = parsed.sections[candidate.section];
    assert.ok(candidate.start >= section.start && candidate.end <= section.end);
  }
  const audit = auditQuoteOwnership(REPORT_SOURCE, REPORT_SOURCE);
  assert.equal(audit.pass, true);
  assert.equal(audit.sourceCount, 3);
  assert.equal(audit.malformedSourceCount, 2);
  assert.equal(audit.unresolvedSourceCount, 0);
  const oneSentenceChanged = REPORT_SOURCE.replace('가 합성 문장 40번은', '가 합성 문장 마흔째는');
  const changed = auditQuoteOwnership(REPORT_SOURCE, oneSentenceChanged);
  assert.equal(changed.pass, false);
  assert.equal(changed.missingCount, 1);
});

test('over-cap unresolved window covers the whole scanned span', () => {
  const huge = `## 장\n“${'합성 문장은 닫히지 않고 길게 이어진다. '.repeat(1100)}`;
  const parsed = parseQuoteOwnership(huge);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].reason, 'too_long');
  assert.ok(parsed.candidates[0].end - parsed.candidates[0].start > 1200);
  const tailChanged = huge.replace(/길게 이어진다\. $/u, '짧게 바뀌었다. ');
  assert.equal(auditQuoteOwnership(huge, tailChanged).pass, false);
});

test('layout restore puts back source whitespace, glyphs and inline citation relation', () => {
  assert.equal(auditQuoteOwnership(REPORT_SOURCE, REPORT_LAYOUT_OUTPUT).pass, true);
  const restored = restoreOwnedQuoteLayout(REPORT_SOURCE, REPORT_LAYOUT_OUTPUT);
  assert.equal(restored.applied, true);
  assert.equal(restored.reason, 'quote_layout_restored');
  assert.equal(restored.sectionAligned, true);
  assert.equal(restored.mappedCount, 3);
  assert.equal(restored.unmappedSourceCount, 0);
  assert.deepEqual(
    restored.protectedBlocks.map(block => restored.text.slice(block.start, block.end)),
    [QUOTE_ONE, QUOTE_TWO, QUOTE_THREE]
  );
  assert.ok(restored.text.includes(`${QUOTE_TWO} 교재 참고: p.12`));
  assert.ok(restored.text.includes(`${QUOTE_ONE} p.10~11`));
  assert.ok(restored.text.includes('\n\n2. 합성 목표\n\n1) 셋째 원리\n\n“'));
  assert.equal(restored.auditAfter.pass, true);
  assert.equal(restored.auditAfter.delimiterRepairedCount, 0);
  const again = restoreOwnedQuoteLayout(REPORT_SOURCE, restored.text);
  assert.equal(again.applied, false);
  assert.equal(again.reason, 'quote_layout_already_source');
  assert.equal(again.protectedBlocks.length, 3);
});

test('paraphrased quote is restored by content stage, then layout stage', () => {
  const paraphrased = REPORT_LAYOUT_OUTPUT.replace('다 합성 문장 3번은', '다 합성 문장 셋째는');
  const audit = auditQuoteOwnership(REPORT_SOURCE, paraphrased);
  assert.equal(audit.pass, false);
  assert.equal(audit.missingCount, 1);
  const content = restoreOwnedQuotes(REPORT_SOURCE, paraphrased);
  assert.equal(content.applied, true);
  assert.equal(content.restoredCount, 1);
  const layout = restoreOwnedQuoteLayout(REPORT_SOURCE, content.text);
  assert.equal(layout.auditAfter.pass, true);
  assert.deepEqual(
    layout.protectedBlocks.map(block => layout.text.slice(block.start, block.end)),
    [QUOTE_ONE, QUOTE_TWO, QUOTE_THREE]
  );
});

test('layout restore never joins a quote to a following heading', () => {
  const source = '## 장\n“이 문장은 뒤에 설명이 붙는 합성 인용이다.” 이어지는 설명.\n## 끝\n마무리.';
  const output = '## 장\n“이 문장은 뒤에 설명이 붙는 합성 인용이다.”\n## 끝\n마무리.';
  const restored = restoreOwnedQuoteLayout(source, output);
  assert.equal(restored.applied, false);
  assert.equal(restored.text, output);
  assert.equal(restored.protectedBlocks.length, 1);
});

test('layout restore keeps CRLF and reports offsets in the returned text', () => {
  const source = '## 장\n그는 “첫 줄은 이렇게 말한다.\n둘째 줄도 이어진다.“\n다음 문단.';
  const output = '## 장\r\n그는 “첫 줄은 이렇게 말한다.\r\n\r\n둘째 줄도 이어진다.”\r\n다음 문단.';
  const restored = restoreOwnedQuoteLayout(source, output);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source.replace(/\n/gu, '\r\n'));
  const [block] = restored.protectedBlocks;
  assert.equal(
    restored.text.slice(block.start, block.end),
    '“첫 줄은 이렇게 말한다.\r\n둘째 줄도 이어진다.“'
  );
});

test('English possessive apostrophe is not a stray closing quote', () => {
  const source = '## 장\nThe students’ notes said “Keep going until the end.” and stopped.';
  const parsed = parseQuoteOwnership(source);
  assert.deepEqual(parsed.candidates.map(candidate => candidate.kind), ['closed']);
  const audit = auditQuoteOwnership(source, source);
  assert.equal(audit.pass, true);
  assert.equal(audit.unresolvedSourceCount, 0);
  assert.equal(audit.sourceCount, 1);
  const korean = parseQuoteOwnership('그는 Apple’이라는 이름을 적었다.');
  assert.deepEqual(korean.candidates.map(candidate => candidate.reason), ['stray_close']);
});

test('tilde fences and table cells do not produce cross-boundary quotes', () => {
  const fenced = '~~~\n“코드 안 문장이다.“\n~~~\n그는 “바깥의 합성 인용 문장이다.“\n끝.';
  const fencedParsed = parseQuoteOwnership(fenced);
  assert.equal(fencedParsed.candidates.length, 1);
  assert.ok(fencedParsed.candidates[0].start > fenced.indexOf('~~~\n그는'));
  const casual = '재밌었다~~~ 그는 “이것은 가려지면 안 되는 합성 인용이다.“\n끝.';
  assert.equal(parseQuoteOwnership(casual).candidates[0].kind, 'same_glyph_close');
  const unclosedFence = '```\n그는 “닫히지 않은 펜스 뒤의 합성 인용 문장이다.”\n끝.';
  assert.equal(parseQuoteOwnership(unclosedFence).candidates[0].kind, 'closed');
  const table = '| “첫 칸의 합성 문장. | 둘째 칸의 합성 문장.” |\n| --- | --- |';
  const tableParsed = parseQuoteOwnership(table);
  assert.ok(tableParsed.candidates.every(candidate => candidate.kind !== 'closed'));
  const secondBar = table.indexOf('|', 1);
  for (const candidate of tableParsed.candidates) {
    assert.ok(!(candidate.start < secondBar && candidate.end > secondBar));
  }
});
