'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDetectInputDocument: build, modelSentences, locatePublicEvidence } = require('../lib/detectInputDocument');
const { groundSignals } = require('../lib/detectGrounding');
const { splitSentenceSpans } = require('../engine/koreanText');
const { wrappedSource } = require('../lib/detectSourceStructure');

test('pipe table prose keeps exact cell ownership without admitting headers, numbers, keywords or code', () => {
  const text = '  | 번호 | 질문 | 답변 |\r\n\r\n| 1 | 실제로 어떤 과정을 관찰했나요? | 여러 실험의 결과를 비교했다. 조건의 차이도 기록했다. |\r\n|---|---|---|\r\n| 2 | 핵심어, 협력, 성장 | `left | right` 값은 자료에서 확인했다. |';
  const doc = build(text);
  const prose = doc.sentences.filter(s => s.eligibleForDetection);
  assert.equal(doc.eligibleSentenceCount, 4);
  assert(prose.every(s => s.spanType === 'table_prose' && s.tableCell));
  for (const sentence of doc.sentences) {
    assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
    if (sentence.tableCell) assert(sentence.start >= sentence.tableCell.start && sentence.end <= sentence.tableCell.end);
  }
  assert(prose.every(s => !s.text.includes('|') && !s.text.includes('left')));
  assert(prose.some(s => s.tableCell.columnIndex === 1));
  assert.equal(doc.sentences.filter(s => s.spanType === 'code').length, 1);
  const signals = groundSignals([{ evidenceSentences: prose.map(s => s.index) }], text);
  assert(signals[0].locations.every(loc => loc.tableCell));
  const trimmedSignals = groundSignals([{ evidenceSentences: build(text.trim()).sentences.filter(s => s.eligibleForDetection).map(s => s.index) }], text.trim());
  assert(locatePublicEvidence(trimmedSignals, text)[0].locations.every(loc => loc.tableCell));
  assert(modelSentences(text).filter(s => s.eligibleForDetection).every(s => s.tableCell));
});

test('escaped cell pipes do not change columns and separate cells never share a sample', () => {
  const text = '| 왼쪽 자료의 값은 A \\| B로 표시했다. | 오른쪽 자료는 독립적으로 다시 확인했다. |';
  const doc = build(text), prose = doc.sentences.filter(s => s.eligibleForDetection);
  assert.equal(prose.length, 2);
  assert.deepEqual(prose.map(s => s.tableCell.columnIndex), [0, 1]);
  assert.notEqual(prose[0].sampleUnitIndex, prose[1].sampleUnitIndex);
});

const wrapped = Array.from({ length: 7 }, (_, i) =>
  `이번 관찰에서는 서로 다른 조건의 자료를 충분히 모아 결과를 확인했다. 하지만 ${i + 1}번째 자료에서\r\n\r\n발견한 차이는 별도로 기록했다.`).join('\r\n\r\n');
test('dense hard wraps restore sentence spans, not source text or physical paragraph ownership', () => {
  const doc = build(wrapped);
  assert.equal(doc.eligibleSentenceCount, 14);
  assert.equal(wrappedSource(wrapped).length, wrapped.length);
  assert(doc.sentences.some(s => s.paragraphEndIndex > s.paragraphIndex));
  assert(doc.sentences.every(s => wrapped.slice(s.start, s.end) === s.text));
  assert(!doc.sentences.some(s => /자료에서$/u.test(s.text)));
  assert(splitSentenceSpans(wrapped).length > doc.sentences.length, 'shared historical splitter does not opt in');
});

test('ordinary blank paragraphs, headings, lists and completed sentences do not join', () => {
  const ordinary = '이 문단에서 확인하려고 하는 여러 항목과 관련된 내용은\n\n다음 문단은 별개의 자료를 설명한다.\n\n# 별도 제목\n\n1. 항목을 관찰했다.';
  assert.equal(wrappedSource(ordinary), ordinary);
  const source = wrapped + '\r\n\r\n# 새 제목\r\n\r\n독립적인 결론을 기록했다.';
  const doc = build(source);
  assert(doc.sentences.some(s => s.spanType === 'heading' && s.text === '# 새 제목'));
  assert(doc.sentences.some(s => s.text === '독립적인 결론을 기록했다.'));
  const metadata = '2026학년도 새로운 학기에 제출하는 통합적 사고와 글쓰기 과제\r\n\r\n제목: 관찰 결과 기록\r\n\r\n전공: 예시학과 학번: 예시번호\r\n\r\n';
  assert(wrappedSource(metadata + wrapped).startsWith(metadata));
  const tabs = '항목 설명\t자료의 내용은 여러 차례의 실험을 통해 기록한 관찰 결과\r\n\r\n항목 결과\t추가 확인\r\n\r\n';
  assert(wrappedSource(tabs + wrapped).startsWith(tabs));
});

test('unspaced finite endings include wishes and contracted past without breaking numbers, code or nominal tokens', () => {
  for (const text of ['동료를 칭찬하고싶다.실험을 함께 진행했다.', '결과가 달라졌다.새 자료를 확인했다.']) {
    assert.equal(splitSentenceSpans(text).length, 2);
  }
  for (const text of ['3.14와 2026. 10. 2. 자료를 확인했다.', '바다.한국이라는 연결 표기', '`obj.값`을 확인했다.']) {
    assert.equal(splitSentenceSpans(text).length, 1);
  }
});

test('incomplete is a narrow tail signal, not a claim that templates or unpunctuated prose are complete', () => {
  assert.equal(build('관찰자는 주위에서 얻은 자료를 비교하다가').inputIncomplete, true);
  assert.equal(build('자료를 확인한 뒤 필요한 내용을 모두 기록했다').inputIncomplete, false);
  assert.equal(build('"관찰자는 주위에서 얻은 자료를 비교하다가"').inputIncomplete, false);
  assert.equal(build('```\n관찰자는 주위에서 얻은 자료를 비교하다가\n```').inputIncomplete, false);
});
