'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripInvisibleCharacters: strip } = require('../engine-gpt-prod/invisibleCharacters');
const { restoreWideGapParagraphs: restore } = require('../engine-gpt-prod/wideGapParagraphs');
const preflight = require('../engine-gpt-prod/sourcePreflight');

const CGJ = '͏', ZWSP = '​', WJ = '⁠', BOM = '﻿', SHY = '­', ZWJ = '‍', ZWNJ = '‌', VS16 = '️';
const paragraphs = text => text.split(/\n\s*\n/u).filter(part => part.trim());

test('invisible format characters between ordinary letters, digits and spaces are removed and counted', () => {
  const source = `${BOM}군${CGJ}생활은 ${CGJ}거울과${CGJ} 같다. 19${CGJ}68년에 태어난 저자${ZWSP}는 길을 돌${WJ}아본다. co${SHY}operate ‪왼쪽‬ ‎끝`;
  const out = strip(source);
  assert.equal(out.text, '군생활은 거울과 같다. 1968년에 태어난 저자는 길을 돌아본다. cooperate 왼쪽 끝');
  assert.equal(out.removedCount, 11);
  assert.deepEqual(out.codePoints, { 'U+FEFF': 1, 'U+034F': 4, 'U+200B': 1, 'U+2060': 1, 'U+00AD': 1, 'U+202A': 1, 'U+202C': 1, 'U+200E': 1 });
  assert.deepEqual(strip(out.text), { text: out.text, removedCount: 0, codePoints: {} }, 'idempotent');
  const clean = '보이지 않는 문자가 없는 글은 같은 문자열 그대로 돌아온다.';
  assert.equal(strip(clean).text, clean);
  assert.equal(strip(null).text, '');
});

test('joiners and selectors that do real work are kept', () => {
  const kept = [
    `가족 \u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467} 사진`,          // emoji ZWJ sequence
    `좋아요 ❤${VS16} 정말`,                                   // emoji presentation selector
    `1${VS16}⃣ 첫 항목`,                                      // keycap
    `\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} 국기`, // flag tag sequence
    `می${ZWNJ}خواهم`,          // Persian ZWNJ
    `क्${ZWJ}ष`,                                    // Devanagari ZWJ
    `a${CGJ}̈b`                                               // CGJ before a combining mark
  ];
  for (const text of kept) {
    const out = strip(text);
    assert.equal(out.text, text);
    assert.equal(out.removedCount, 0);
  }
  // 같은 문자라도 양옆이 평범한 글자면 걷어낸다.
  assert.equal(strip(`가${VS16}나 다${ZWJ}라 마${ZWNJ}바`).text, '가나 다라 마바');
  assert.equal(strip(`숨김\u{E0041}\u{E0042} 글`).text, '숨김 글');
  // 폭이 있는 채움 문자와 옛한글 채움 자모는 대상이 아니다.
  for (const filler of ['ㅤ', 'ﾠ', 'ᅟ', 'ᅠ']) assert.equal(strip(`가${filler}나`).text, `가${filler}나`);
});

test('a hidden character inside a number no longer reaches the working source', () => {
  const source = `인간의 삶은 연습할 기회가 없다. 19${CGJ}68년에 태${CGJ}어난 저자가 지나온 길을 돌아보듯 우리도 매 순간 변화를 경험한다.`;
  const result = preflight.auditAndSanitizeSource(source);
  assert.ok(result.text.includes('1968년에 태어난'));
  assert.equal(/[͏​⁠]/u.test(result.text + result.integrityText + result.submittedContentText), false);
  assert.equal(result.engineMeta.sourceInvisibleCharRemovedCount, 2);
  assert.equal(result.issueCodes.includes('source_invisible_character_removed'), false, 'diagnostic only, no user notice');
  assert.equal(result.warnings.length, preflight.auditAndSanitizeSource(source.replaceAll(CGJ, '')).warnings.length);
});

const s = (subject, n) => Array.from({ length: n }, (_, i) => `${subject}의 ${i + 1}번째 근거는 조사 자료에서 확인된다.`).join(' ');
const intro = `대체 시험법을 둘러싼 논의가 이어지고 있다. ${s('서론', 3)} 따라서 단계적으로 도입해야 한다.`;
const first = `첫째로 예측 실패율이 높게 나타난다. ${s('첫째', 3)} 따라서 보완적인 시험법이 필요하다.`;
const second = `둘째로 대체 기술이 주목받고 있다. ${s('둘째', 3)} 이 흐름에서 법적 근거도 마련됐다.`;
const closing = `의약품 개발에서는 대체 시험법의 활용이 넓어지고 있다. ${s('결론', 3)} 검증된 기술부터 받아들여야 한다.`;

test('a long single line with wide gaps between sentences gets its paragraphs back', () => {
  const line = [intro, first, second, closing].join('   ');
  assert.equal(line.includes('\n'), false);
  const out = restore(line);
  assert.equal(out.restoredCount, 3);
  assert.deepEqual(paragraphs(out.text), [intro, first, second, closing]);
  assert.equal(out.text.replace(/\s+/gu, ''), line.replace(/\s+/gu, ''), 'only whitespace changes');
  assert.deepEqual(restore(out.text), { text: out.text, restoredCount: 0 }, 'idempotent');
  // 전각 공백이 섞인 넓은 공백과 줄 앞 들여쓰기.
  const indented = `　${intro} 　${first}　　${second} ${closing}`;
  assert.ok(indented.length >= 400);
  const restoredIndented = restore(indented);
  assert.equal(restoredIndented.restoredCount, 2);
  assert.ok(restoredIndented.text.startsWith('　대체 시험법'));
  assert.deepEqual(paragraphs(restoredIndented.text).map(part => part.trim()), [intro, first, `${second} ${closing}`]);
  // 제목 줄 아래의 한 덩어리 본문도 줄 단위로 본다.
  const titled = `제목 줄\n${line}`;
  assert.equal(paragraphs(restore(titled).text).length, 4);
});

test('spacing habits, tables, short lines and thin evidence are left alone', () => {
  const untouched = [
    [intro, first, second, closing].join('  '),                                   // 두 칸은 버릇일 수 있다
    [intro, first, second, closing].join('   ').replace(/([다][.]) (?=\S)/gu, '$1   '), // 모든 문장 뒤가 넓다
    `${intro}   ${first} ${second} ${closing}`,                                    // 넓은 공백이 한 곳뿐
    `${intro}   짧다.   ${second}   ${closing}`,                                   // 조각이 너무 짧다
    `${intro}\t${first}   ${second}   ${closing}`,                                 // 탭이 있는 줄
    `${intro}   ${first} | ${second}   ${closing}`,                               // 세로선이 있는 줄
    '짧은 글이다.   둘째 문장이다.   셋째 문장이다.',                               // 짧은 줄
    `1.   서론 ${intro} 2.   본론 ${first} ${second}`                              // 번호 뒤 공백
  ];
  for (const text of untouched) assert.deepEqual(restore(text), { text, restoredCount: 0 });
  assert.equal(restore('').text, '');
});

test('preflight applies both repairs before every other step and reports them as diagnostics', () => {
  assert.equal(preflight.VERSION, 39);
  const line = [intro, first, second, closing].join('   ').replace('예측', `예${CGJ}측`);
  const result = preflight.auditAndSanitizeSource(line);
  assert.equal(paragraphs(result.text).length, 4);
  assert.match(paragraphs(result.text)[1], /^첫째로 /u);
  assert.match(paragraphs(result.text)[2], /^둘째로 /u);
  assert.match(paragraphs(result.text)[3], /^의약품 개발에서는 /u);
  assert.deepEqual(result.engineMeta, { sourceInvisibleCharRemovedCount: 1, sourceWideGapParagraphRestoreCount: 3 });
  // 정리할 것이 없는 글은 예전과 같은 결과다(진단값도 생기지 않는다).
  const ordinary = `${intro}\n\n${first}\n\n${second}`;
  const plain = preflight.auditAndSanitizeSource(ordinary);
  assert.equal(plain.text, ordinary);
  assert.equal(Object.hasOwn(plain.engineMeta || {}, 'sourceInvisibleCharRemovedCount'), false);
  assert.equal(Object.hasOwn(plain.engineMeta || {}, 'sourceWideGapParagraphRestoreCount'), false);
  assert.equal(preflight.auditAndSanitizeSource('').text, '');
});

test('the engine cleans its submitted-text evidence and history keeps the two counters', () => {
  const engine = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod/index.js'), 'utf8');
  assert.match(engine, /const submittedSource = require\('\.\/invisibleCharacters'\)\.stripInvisibleCharacters\(String\(text \|\| ''\)\)\.text\.trim\(\);/u);
  const { compactHistoryEngineMeta: compact } = require('../lib/historyService');
  const stored = compact({ sourceInvisibleCharRemovedCount: 81, sourceWideGapParagraphRestoreCount: 4 });
  assert.equal(stored.sourceInvisibleCharRemovedCount, 81);
  assert.equal(stored.sourceWideGapParagraphRestoreCount, 4);
  const legacy = compact({});
  assert.equal(Object.hasOwn(legacy, 'sourceInvisibleCharRemovedCount'), false);
  assert.equal(Object.hasOwn(legacy, 'sourceWideGapParagraphRestoreCount'), false);
});
