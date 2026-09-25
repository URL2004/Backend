'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSentences, splitSentenceSpans } = require('../engine/koreanText');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { detectSemanticRelationShifts: audit } = require('../engine-gpt-prod/fingerprintAudit');

// Synthetic fixture, no production user text.
const units = [
  '지역 전시관은 소장품뿐 아니라 주민들의 생활 변화를 보여 주는 것 같다',
  '초기 전시에서는 생활 도구와 오래된 사진이 주요 자료로 등장했다',
  '이후에는 산업 기술과 교통수단을 설명하는 자료가 점차 늘어났다',
  '새로운 공간이 마련되면서 관람객이 직접 참여하는 활동도 생겼다',
  '최근에는 여러 지역의 자료를 함께 소개하면서 전시의 주제가 다양해졌다',
  '이러한 전시관은 지역의 경험을 함께 돌아보는 장소라고 생각한다'
];
const source = units.join(' ');
const output = units.join('. ') + '.';
const hedge = result => result.shifts.some(item => item.family === 'epistemic_hedge_hardened');

test('plain missing punctuation is opt-in and preserves original offsets', () => {
  assert.equal(splitSentences(source).length, 1);
  const spans = splitSentenceSpans(source, { inferPlainEndings: true });
  assert.deepEqual(spans.map(span => span.text), units);
  for (const span of spans) assert.equal(source.slice(span.start, span.end), span.text);
  assert.equal(spans.map(span => span.text).join(' '), source);
});

test('genre no longer depends on punctuation for multi-claim general prose', () => {
  for (const basicStyle of ['', 'blog', 'report']) {
    const before = detectDocumentProfile(source, { basicStyle });
    const punctuated = detectDocumentProfile(output, { basicStyle });
    assert.equal(before.profile, 'general');
    assert.equal(before.profile, punctuated.profile);
    assert.equal(before.confidence, punctuated.confidence);
    assert.equal(before.signals.sentenceCount, units.length);
  }
});

test('actual ambiguous short input is still unclassified', () => {
  assert.equal(detectDocumentProfile('조용한 풍경과 그날의 기억').profile, 'unknown');
});

test('one-to-many punctuation and paragraph expansion does not harden retained hedge', () => {
  for (const text of [output, units.join('.\n\n') + '.', source]) {
    assert.equal(hedge(audit(source, text)), false);
  }
});

test('actual hedge removal remains a warning with original source ordinal', () => {
  const changed = output.replace('보여 주는 것 같다', '분명히 보여 준다');
  const result = audit(source, changed);
  assert.equal(hedge(result), true);
  assert.deepEqual(result.shifts.find(item => item.family === 'epistemic_hedge_hardened').sentenceOrdinals, [1]);
});

test('a retained hedge on another claim does not excuse deletion on the first', () => {
  const source = '지역 도서관의 새 독서 프로그램은 참여자의 관심을 높이는 것 같다 올해 지역 도서관의 야간 대출 서비스는 이용자의 편의를 높이는 것 같다';
  const result = '지역 도서관의 새 독서 프로그램은 참여자의 관심을 높인다. 올해 지역 도서관의 야간 대출 서비스는 이용자의 편의를 높이는 것 같다.';
  assert.equal(hedge(audit(source, result)), true);
  assert.equal(hedge(audit(source, result.replace('높인다.', '높이는 것 같다.'))), false);
});

test('inferred local units never leak as public restoration ordinals', () => {
  const prefix = '지난 회의에서는 이번 지역 행사에 관한 자료를 검토했다.';
  const changed = output.replace('보여 주는 것 같다', '명확히 보여 준다');
  const result = audit(prefix + ' ' + source, prefix + ' ' + changed);
  assert.deepEqual(result.shifts.find(item => item.family === 'epistemic_hedge_hardened').sentenceOrdinals, [2]);
});

test('quotes, parentheses and code are protected during analysis inference', () => {
  for (const [open, close] of [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['"', '"'], ["'", "'"], ['(', ')'], ['`', '`'], ['```\n', '\n```']]) {
    const text = open + source + close;
    assert.equal(splitSentences(text, { inferPlainEndings: true }).length, 1, open);
  }
});

test('nouns, comparison and reporting constructions do not become boundaries', () => {
  for (const text of [
    '주요 수요 변화와 필요 조건을 비교하는 연구가 진행 중이다',
    '잔잔한 바다 소리와 시원한 사이다 음료를 함께 떠올렸다',
    '검토를 충분히 진행했다 하더라도 결과는 달라질 수 있다',
    '검토를 충분히 진행했다 라고 말한 사람의 의견을 기록했다',
    '검토를 충분히 진행했다 싶었다',
    '검토를 충분히 진행했다 한다',
    '첫 번째 작품보다 두 번째 작품을 더 좋아하는 사람들이 많았다',
    '관찰 항목을 정리하면서 다음 단계에 필요한 내용을 준비했다'
  ]) assert.equal(splitSentences(text, { inferPlainEndings: true }).length, 1, text);
});

test('mixed punctuation, tabs and CRLF retain complete clauses', () => {
  const text = units[0] + '\t' + units[1] + '.\r\n' + units[2] + ' ' + units[3];
  assert.deepEqual(splitSentences(text, { inferPlainEndings: true }), [units[0], units[1] + '.', units[2], units[3]]);
});

test('unrelated repeated claims do not erase a genuine certainty warning', () => {
  const tail = '행사장의 안내 자료는 여러 언어로 제공된다';
  const changed = output.replace('보여 주는 것 같다', '분명히 보여 준다');
  assert.equal(hedge(audit(source + ' ' + tail, changed + ' ' + tail + '. ' + tail + '.')), true);
});

test('date, decimal and initial spans remain intact', () => {
  const text = '2026. 9. 25. 자료와 A. B. Kim의 기록에서 3.14라는 수치를 확인했다 다음 자료에서는 전혀 다른 수치를 확인했다';
  const rows = splitSentenceSpans(text, { inferPlainEndings: true });
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /2026\. 9\. 25\./u);
  assert.match(rows[0].text, /3\.14/u);
});

test('contracted past endings and present predicates infer without changing words', () => {
  for (const ending of ['늘어났다', '생겼다', '줄어들었다', '좋아졌다', '확인했다', '직접 봤다', '마련됐다', '제시한다', '확인된다', '남아 있다', '남아 있지 않다']) {
    const first = `기관의 공개 자료를 살펴보면 이러한 변화가 ${ending}`;
    const second = '다음 자료에서는 참여자의 의견을 자세히 확인했다';
    assert.deepEqual(splitSentences(first + ' ' + second, { inferPlainEndings: true }), [first, second], ending);
  }
});

test('distributed one-to-many paraphrase retains its own hedge', () => {
  const source = '지역 행사의 안내 자료와 교통 정보 제공은 방문객의 불편을 줄이는 것 같다';
  const output = '지역 행사에서는 안내 자료와 교통 정보를 제공한다. 이러한 정보 제공은 방문객의 불편을 줄이는 것 같다.';
  assert.equal(hedge(audit(source, output)), false);
});

test('either missing hedge among two distinct claims is detected', () => {
  const first = '새 독서 모임은 참여자의 어휘력과 독해 능력을 높이는 것 같다';
  const second = '온라인 예약 서비스는 시설 관리자의 대기 업무를 줄이는 것 같다';
  for (const rows of [[first, second], [second, first]]) {
    for (const index of [0, 1]) {
      const changed = rows.map((row, i) => i === index ? row.replace('것 같다', '것이 분명하다') : row);
      assert.equal(hedge(audit(rows.join(' '), changed.join('. ') + '.')), true);
    }
  }
});
