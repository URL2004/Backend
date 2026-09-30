'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const citation = require('../engine-gpt-prod/citationOwnership');
const bare = text => text.replace(/\s/gu, '');

test('citation content restoration never erases intervening prose because its title is similar', () => {
  const reference = '교재 참고: p.21~22 활동 목표와 내용, 자료 준비 및 관찰 결과 기록, 교사의 역할과 안내 방법';
  const source = `1. 관찰 활동\n${reference}\n\n2. 결과 정리\n관찰 내용을 정리한다.`;
  const output = source.replace('교사의 역할과 안내 방법', '교사 역할과 안내 방법 추가 의견은 중요하다.');
  const restored = citation.restoreCitationContents(source, output);
  assert.equal(restored.pass, false);
  assert.equal(restored.restoredCount, 0);
  assert.equal(restored.text, output);
});

// Synthetic source only. The same citation literal occurs inline and as a
// standalone row, its title carries a numbered fragment, and the second
// citation has a malformed (same-glyph) title delimiter.
const CITE = '교재 참고: p.175~176 7.3.2. 광합성의 명반응';
const REF = '출처: “생물학 실험 안내“ p.12';
const source = [
  '1. 관찰 개요',
  `첫 실험에서는 잎의 색 변화를 기록했다. ${CITE}`,
  CITE,
  '2. 결과 정리',
  `두 번째 실험에서도 같은 변화가 나타났다. ${CITE}`,
  REF,
  '3. 다음 계획',
  '측정 조건을 일정하게 유지한다.'
].join('\n');

const broken = [
  '1. 관찰 개요',
  '첫 실험에서는 잎의 색 변화를 기록했다.',
  '교재 참고: p.175~176',
  `7.3.2. 광합성의 명반응 ${CITE}`,
  '2. 결과 정리',
  `두 번째 실험에서도 같은 변화가 나타났다. ${CITE}`,
  REF,
  '3. 다음 계획',
  '측정 조건을 일정하게 유지한다.'
].join('\n');

test('ownership keeps each repeated citation occurrence with its own row kind', () => {
  const { atoms } = citation.buildCitationOwnership(source);
  assert.deepEqual(atoms.map(atom => atom.rowKind), ['inline', 'standalone', 'inline', 'standalone']);
  assert.deepEqual(atoms.map(atom => atom.literal), [CITE, CITE, CITE, REF]);
  assert.deepEqual(atoms.map(atom => atom.id), ['1:citation:0', '1:citation:1', '2:citation:0', '2:citation:1']);
  for (const atom of atoms) assert.equal(source.slice(atom.srcStart, atom.srcEnd), atom.literal);
  assert.equal(atoms[0].pageAnchor, 'p.175~176');
});

test('unchanged output is a fixed point', () => {
  const result = citation.restoreCitationLayout(source, source);
  assert.equal(result.text, source);
  assert.equal(result.pass, true);
  assert.equal(result.missingCount, 0);
  assert.equal(result.repairCount, 0);
  assert.deepEqual(result.atoms.map(atom => atom.status), ['exact', 'exact', 'exact', 'exact']);
});

test('mixed inline and standalone identical citations are restored by whitespace only', () => {
  const result = citation.restoreCitationLayout(source, broken);
  assert.equal(result.text, source);
  assert.equal(result.pass, true);
  assert.ok(result.repairCount > 0);
  assert.equal(bare(result.text), bare(broken));
  assert.doesNotMatch(result.text, /p\.175~176\n7\.3\.2\./u);
  const again = citation.restoreCitationLayout(source, result.text);
  assert.equal(again.text, result.text);
  assert.equal(again.repairCount, 0);
  assert.equal(again.pass, true);
});

test('a dropped or an extra citation fails without guessing ownership', () => {
  const dropped = source.replace(`\n${CITE}\n2.`, '\n2.');
  const droppedResult = citation.restoreCitationLayout(source, dropped);
  assert.equal(droppedResult.pass, false);
  assert.equal(droppedResult.missingCount, 1);
  assert.equal(droppedResult.text, dropped);

  const extra = source.replace('3. 다음 계획', `${CITE}\n3. 다음 계획`);
  const extraResult = citation.restoreCitationLayout(source, extra);
  assert.equal(extraResult.pass, false);
  assert.equal(extraResult.extraCount, 1);
  assert.equal(extraResult.text, extra);
});

test('CRLF source and output agree on LF offsets', () => {
  const crlf = text => text.replaceAll('\n', '\r\n');
  const lf = citation.buildCitationOwnership(source).atoms;
  const cr = citation.buildCitationOwnership(crlf(source)).atoms;
  assert.deepEqual(cr.map(atom => [atom.srcStart, atom.srcEnd, atom.rowKind]), lf.map(atom => [atom.srcStart, atom.srcEnd, atom.rowKind]));
  const result = citation.restoreCitationLayout(crlf(source), crlf(broken));
  assert.equal(result.text, source);
  assert.equal(result.pass, true);
});

test('an inline citation next to a numbered heading never merges the heading', () => {
  const text = [
    '1. 실험 방법',
    `시료를 같은 온도에서 보관했다. ${CITE}`,
    '2. 실험 결과',
    '색 변화가 뚜렷하게 나타났다.'
  ].join('\n');

  const merged = text.replace(`${CITE}\n2. 실험 결과`, `${CITE} 2. 실험 결과`);
  const split = citation.restoreCitationLayout(text, merged);
  assert.equal(split.text, text);
  assert.equal(split.pass, true);

  const moved = [
    '1. 실험 방법',
    CITE,
    '시료를 같은 온도에서 보관했다.',
    '2. 실험 결과',
    '색 변화가 뚜렷하게 나타났다.'
  ].join('\n');
  const refused = citation.restoreCitationLayout(text, moved);
  assert.equal(refused.pass, false);
  assert.equal(refused.refusedCount, 1);
  assert.equal(refused.text, moved);
  assert.match(refused.text, /^1\. 실험 방법\n/u);
});

test('reordered distinct citations fail instead of being swapped by position', () => {
  const first = '교재 참고: p.31 세포의 구조';
  const text = ['1. 정리', '세포를 관찰했다.', first, REF, '끝맺는 문장이다.'].join('\n');
  const swapped = ['1. 정리', '세포를 관찰했다.', REF, first, '끝맺는 문장이다.'].join('\n');
  const result = citation.restoreCitationLayout(text, swapped);
  assert.equal(result.pass, false);
  assert.equal(result.text, swapped);
  assert.equal(result.repairCount, 0);
});

test('an altered citation tail is not treated as the source literal', () => {
  const altered = source.replace(REF, '출처: “생물학 실험 입문“ p.12');
  const result = citation.restoreCitationLayout(source, altered);
  assert.equal(result.pass, false);
  assert.equal(result.missingCount, 1);
  assert.equal(result.extraCount, 1);
  assert.equal(result.text, altered);
});

test('code is never owned or modified', () => {
  const text = [
    '설명 문장이다. `참고: p.9 예시`도 있다.',
    '```',
    '출처:   p.3  예시',
    '```',
    CITE
  ].join('\n');
  const { atoms } = citation.buildCitationOwnership(text);
  assert.deepEqual(atoms.map(atom => atom.literal), [CITE]);
  const output = text.replace('p.175~176 7.3.2.', 'p.175~176\n7.3.2.');
  const result = citation.restoreCitationLayout(text, output);
  assert.equal(result.text, text);
  assert.equal(result.pass, true);
  assert.match(result.text, /```\n출처: {3}p\.3 {2}예시\n```/u);
});

test('general prose after a prefix is not owned as a citation', () => {
  const text = '이 자료의 출처: 연구자가 직접 조사한 내용이다.\n참고: 다음 시간에 이어서 살펴본다.';
  assert.equal(citation.buildCitationOwnership(text).atoms.length, 0);
  const result = citation.restoreCitationLayout(text, text);
  assert.equal(result.text, text);
  assert.equal(result.pass, true);
  assert.equal(result.protectedBlocks.length, 0);
});

test('a second citation on the same row ends the first literal', () => {
  const text = '내용을 요약했다. 교재 참고: p.3 세포의 구조 출처: 『실험 안내』 p.4';
  const { atoms } = citation.buildCitationOwnership(text);
  assert.deepEqual(atoms.map(atom => atom.literal), ['교재 참고: p.3 세포의 구조', '출처: 『실험 안내』 p.4']);
  assert.deepEqual(atoms.map(atom => atom.rowKind), ['inline', 'inline']);
  const output = text.replace(' 출처:', '\n출처:');
  assert.equal(citation.restoreCitationLayout(text, output).text, text);
});

// Synthetic content-restore fixtures. P_* are reworded forms of C_* that keep
// the page numbers but change particles, separators and title glyphs.
const C_BG = '교재 참고: p.21~22 3.1.1. 세포 관찰의 배경, p.24 현미경의 구조';
const P_BG = '교재 참고: p. 21~22의 3.1.1. 세포 관찰의 배경과 p. 24의 현미경의 구조';
const C_STEP = '교재 참고: p.30 「관찰 단계 - 시료 준비, 결과 기록';
const P_STEP = '교재 참고: p.30 관찰 단계: 시료를 준비하고 결과 기록하기';
const contentSource = [
  '1. 관찰 준비',
  `“시료를 얇게 잘라 받침유리에 올렸다.” ${C_BG}`,
  C_BG,
  '',
  '2. 관찰 기록',
  `“배율을 바꾸며 모양을 그렸다.” ${C_STEP}`,
  C_STEP,
  '',
  '3. 정리',
  '기록을 표로 옮겨 적었다.'
].join('\n');
const contentOutput = (first, second = `“배율을 바꿔 가며 모양을 그렸다.” ${C_STEP}\n${C_STEP}`) => [
  '1. 관찰 준비',
  '',
  first,
  '',
  '2. 관찰 기록',
  '',
  second,
  '',
  '3. 정리',
  '',
  '기록을 표로 옮겨 적었다.'
].join('\n');
const BODY = '“시료를 얇게 썰어 받침유리 위에 올렸다.”';

test('reworded citation titles are restored from the source without touching body or headings', () => {
  const output = contentOutput(
    `${BODY} ${C_BG} ${P_BG}`,
    `“배율을 바꿔 가며 모양을 그렸다.” ${C_STEP}\n${P_STEP}`
  );
  assert.equal(citation.restoreCitationLayout(contentSource, output).pass, false);
  assert.equal(citation.restoreCitationLayout(contentSource, output).text, output);

  const result = citation.restoreCitationContents(contentSource, output);
  assert.equal(result.text, output.replace(P_BG, C_BG).replace(P_STEP, C_STEP));
  assert.equal(result.pass, true);
  assert.equal(result.restoredCount, 2);
  assert.equal(result.exactCount, 2);
  assert.equal(result.missingCount, 0);
  assert.equal(result.extraCount, 0);
  assert.equal(result.refusedCount, 0);
  assert.ok(result.text.includes(BODY));
  assert.ok(result.text.includes('「관찰 단계'));
  assert.match(result.text, /^1\. 관찰 준비\n/u);
  assert.match(result.text, /\n2\. 관찰 기록\n/u);
  for (const atom of result.atoms.filter(entry => entry.status === 'restored')) {
    assert.ok([C_BG, C_STEP].includes(result.text.slice(atom.start, atom.end)));
  }

  const { text, ...audit } = result;
  assert.doesNotMatch(JSON.stringify(audit), /세포|현미경|시료|교재/u);

  const again = citation.restoreCitationContents(contentSource, text);
  assert.equal(again.text, text);
  assert.equal(again.restoredCount, 0);
  assert.equal(again.pass, true);

  const layout = citation.restoreCitationLayout(contentSource, text);
  assert.equal(layout.pass, true);
  assert.ok(layout.text.includes(`${C_BG}\n${C_BG}`));
});

test('content restore locates a flattened heading and stops the slot before it', () => {
  const output = [
    '1. 관찰 준비',
    `${BODY} ${C_BG} ${P_BG} 2. 관찰 기록 “배율을 바꾸며 모양을 그렸다.” ${C_STEP}`,
    C_STEP,
    '',
    '3. 정리',
    '기록을 표로 옮겨 적었다.'
  ].join('\n');
  const result = citation.restoreCitationContents(contentSource, output);
  assert.equal(result.pass, true);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.text, output.replace(P_BG, C_BG));
  assert.ok(result.text.includes(`${C_BG} ${C_BG} 2. 관찰 기록 “배율을`));
});

test('content restore reaches a citation that ends the document', () => {
  const text = ['1. 정리', `기록을 남겼다. ${C_STEP}`, C_STEP].join('\n');
  const output = ['1. 정리', `기록을 남겼다. ${C_STEP}`, P_STEP].join('\n');
  const result = citation.restoreCitationContents(text, output);
  assert.equal(result.text, text);
  assert.equal(result.pass, true);
  assert.equal(result.restoredCount, 1);
});

test('content restore refuses missing, extra and page-changed citations without splicing', () => {
  const missing = contentOutput(`${BODY} ${P_BG}`);
  const missingResult = citation.restoreCitationContents(contentSource, missing);
  assert.equal(missingResult.text, missing);
  assert.equal(missingResult.pass, false);
  assert.equal(missingResult.missingCount, 1);
  assert.equal(missingResult.restoredCount, 0);

  const extra = contentOutput(`${BODY} ${C_BG}\n${P_BG}\n${P_BG}`);
  const extraResult = citation.restoreCitationContents(contentSource, extra);
  assert.equal(extraResult.text, extra);
  assert.equal(extraResult.pass, false);
  assert.equal(extraResult.extraCount, 1);
  assert.equal(extraResult.restoredCount, 0);

  const wrongPages = contentOutput(`${BODY} ${C_BG}\n${P_BG.replace('21~22', '21~23')}`);
  const pageResult = citation.restoreCitationContents(contentSource, wrongPages);
  assert.equal(pageResult.text, wrongPages);
  assert.equal(pageResult.pass, false);
  assert.equal(pageResult.restoredCount, 0);
  assert.deepEqual(pageResult.atoms.filter(atom => atom.status === 'refused').map(atom => atom.reason), ['pages-changed']);
});

test('content restore keeps a failing section untouched while other sections still restore', () => {
  const output = contentOutput(
    `${BODY} ${P_BG}`,
    `“배율을 바꿔 가며 모양을 그렸다.” ${C_STEP}\n${P_STEP}`
  );
  const result = citation.restoreCitationContents(contentSource, output);
  assert.equal(result.pass, false);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.text, output.replace(P_STEP, C_STEP));
  assert.ok(result.text.includes(P_BG));
});

test('content restore refuses distinct citations that swapped places with the same page', () => {
  const first = '교재 참고: p.31 세포의 구조';
  const second = '출처: 『실험 안내』 p.31';
  const text = ['1. 정리', '세포를 관찰했다.', first, second, '', '2. 다음', '끝맺는 문장이다.'].join('\n');
  const swapped = ['1. 정리', '세포를 관찰했다.', second, first, '', '2. 다음', '끝맺는 문장이다.'].join('\n');
  const result = citation.restoreCitationContents(text, swapped);
  assert.equal(result.text, swapped);
  assert.equal(result.pass, false);
  assert.equal(result.restoredCount, 0);
  assert.ok(result.atoms.some(atom => atom.reason === 'reordered'));
});

test('content restore does not borrow the next anchor across source prose', () => {
  const text = ['1. 관찰 준비', C_BG, '시료를 얇게 잘라 올렸다.', '', '2. 정리', '끝맺는 문장이다.'].join('\n');
  const output = text.replace(C_BG, P_BG);
  const result = citation.restoreCitationContents(text, output);
  assert.equal(result.text, output);
  assert.equal(result.pass, false);
  assert.equal(result.restoredCount, 0);
  assert.deepEqual(result.atoms.map(atom => atom.reason), ['unbounded']);

  const same = citation.restoreCitationContents(text, text);
  assert.equal(same.text, text);
  assert.equal(same.pass, true);
  assert.equal(same.exactCount, 1);
});

test('content restore honors layoutSourceStart/End overrides for locked headings', () => {
  const title = '관찰 기록 정리';
  const text = ['시료를 얇게 잘라 올렸다.', C_BG, '', title, '끝맺는 문장이다.'].join('\n');
  const output = text.replace(C_BG, P_BG);
  const stale = { locked: true, lockType: 'heading', start: 0, end: 0 };

  const refused = citation.restoreCitationContents(text, output, [stale]);
  assert.equal(refused.text, output);
  assert.equal(refused.pass, false);

  const start = text.indexOf(title);
  const fixed = { ...stale, layoutSourceStart: start, layoutSourceEnd: start + title.length };
  const result = citation.restoreCitationContents(text, output, [fixed]);
  assert.equal(result.text, text);
  assert.equal(result.pass, true);
  assert.equal(result.restoredCount, 1);
});

test('protected blocks expose immutable raw ranges without changing the output', () => {
  const blocks = citation.citationProtectedBlocks(source, broken);
  assert.equal(blocks.length, 4);
  for (const block of blocks) {
    assert.equal(broken.slice(block.start, block.end), block.raw);
    assert.equal(bare(block.raw), bare(block.literal));
  }
  assert.deepEqual(blocks.map(block => block.rowKind), ['inline', 'standalone', 'inline', 'standalone']);
  assert.equal(blocks[0].status, 'inexact');

  const fixed = citation.restoreCitationLayout(source, broken);
  for (const block of fixed.protectedBlocks) {
    assert.equal(fixed.text.slice(block.start, block.end), block.literal);
  }
});
