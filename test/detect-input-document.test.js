'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceSentences } = require('../lib/detectGrounding');
const { paragraphSpans, buildDetectInputDocument, modelSentences, locatePublicEvidence } = require('../lib/detectInputDocument');
const { groundSignals } = require('../lib/detectGrounding');
const { locateNormalizedEvidence, assertDetectInputAdmissible, MAX_MODEL_SENTENCES, MAX_MODEL_INPUT_BYTES } = require('../lib/detectInputDocument');

test('legacy normalization maps only unchanged source sentences after a removed URL parameter', () => {
  const raw = ' \r\n자료는 https://example.test/reference?utm_source=chatgpt.com 에서 확인했다.\r\n\r\n참여자는 접수 안내문을 확인했다. 준비물은 별도의 수첩에 적었다.  ';
  const normalized = require('../engine/spacing').stripAiUrlParams(raw).text;
  assert.notEqual(normalized, raw);
  const evidence = groundSignals([{ category: 'generic_abstraction', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1, 2] }], normalized.trim());
  const result = locateNormalizedEvidence(evidence, raw, normalized);
  const slices = result[0].locations.map(loc => raw.slice(loc.start, loc.end));
  assert.deepEqual(slices, ['참여자는 접수 안내문을 확인했다.', '준비물은 별도의 수첩에 적었다.']);
  assert.equal(result[0].locations[0].paragraphIndex, 1);
  assert.equal(result[0].locations[0].sentenceIndex, 1);
  assert.equal(evidence[0].locations.length, 3, 'cached normalized evidence remains immutable');
});

test('split-word whitespace mapping preserves raw source and refuses ambiguous deletion', () => {
  const raw = '참여자는 지 역 도서관을 방문했다.\n\n안내문을 확인하고 준비물을 적었다.';
  const normalized = raw.replace('지 역', '지역');
  const evidence = groundSignals([{ category: 'ending_repetition', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }], normalized);
  const result = locateNormalizedEvidence(evidence, raw, normalized);
  assert.equal(raw.slice(result[0].locations[0].start, result[0].locations[0].end), '참여자는 지 역 도서관을 방문했다.');
  assert.equal(result[0].locations[1].start, raw.indexOf('안내문'));
  const repeated = '동일한 설명을 확인했다. 동일한 설명을 확인했다.';
  const once = '동일한 설명을 확인했다.';
  const ambiguous = locateNormalizedEvidence(groundSignals([{ category: 'ending_repetition', evidenceSentences: [0] }], once), repeated, once);
  assert.equal(ambiguous[0].locationStatus, 'unlocated'); assert.deepEqual(ambiguous[0].locations, []);
});

test('admission rejects all-protected input and metadata expansion without sampling eligible prose', () => {
  for (const source of ['```js\nconst count = 3;\nconsole.log(count);\n```', '| 항목 | 수치 |\n|---|---|\n| 이름 | 내용 |']) {
    assert.throws(() => assertDetectInputAdmissible(source), error => error.code === 'DETECT_NO_ELIGIBLE_PROSE' && error.status === 422 && error.charged === 0);
  }
  const fragmented = Array.from({ length: MAX_MODEL_SENTENCES + 1 }, (_, i) => `${i}번이다.`).join(' ');
  assert.throws(() => assertDetectInputAdmissible(fragmented), error => error.code === 'DETECT_INPUT_TOO_FRAGMENTED');
  const allowed = Array.from({ length: 200 }, (_, i) => `${i}번째 안내문을 확인했다.`).join(' ');
  const result = assertDetectInputAdmissible(allowed, { referenceContext: '참고 문맥이다.' });
  assert.equal(result.document.eligibleSentenceCount, 200); assert.equal(result.modelInput.sentences.length, 200);
  assert.equal(result.modelInput.sentences.map(s => s.text).join(' '), allowed);
  assert.ok(Buffer.byteLength(result.serialized) < MAX_MODEL_INPUT_BYTES);
  // The serialized cap also protects direct engine callers, independently of
  // the public route's 30,000-character limit and the span-count limit.
  const oversized = '자료'.repeat(MAX_MODEL_INPUT_BYTES / 6) + '를 확인했다.';
  assert.throws(() => assertDetectInputAdmissible(oversized), error => error.code === 'DETECT_INPUT_TOO_FRAGMENTED');
});

test('paragraph metadata preserves canonical sentence indices and exact original offsets', () => {
  const text = '  첫 번째 문장이다. 두 번째 문장이다.\r\n\r\n세 번째 문장이다.\r\n줄바꿈 뒤의 네 번째 문장이다.  ';
  const result = buildDetectInputDocument(text);
  assert.equal(result.paragraphs.length, 2);
  assert.deepEqual(result.sentences.map(({ start, end, text }) => ({ start, end, text })), sourceSentences(text));
  assert.deepEqual(result.sentences.map(sentence => sentence.paragraphIndex), [0, 0, 1, 1]);
  for (const sentence of result.sentences) assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
  assert.deepEqual(result.paragraphs.map(paragraph => paragraph.sentenceIndices), [[0, 1], [2, 3]]);
});

test('single CRLF is a wrapped line while whitespace-only blank lines separate paragraphs', () => {
  const text = '첫 줄의 아직 끝나지 않은 설명\r\n이어서 마무리한다.\r\n \t\r\n다음 문단이다.\n\n\n마지막 문단이다.';
  const result = buildDetectInputDocument(text);
  assert.equal(result.paragraphs.length, 3);
  assert.deepEqual(result.sentences.map(sentence => sentence.paragraphIndex), [0, 1, 2]);
  assert.equal(result.sentences[0].text.includes('\r\n'), true);
});

test('punctuation-free fragments retain a spanning sentence instead of renumbering evidence', () => {
  const text = '앞 문단의 제목\n \n뒤 문단의 미완성 구절';
  const canonical = sourceSentences(text);
  const result = buildDetectInputDocument(text);
  assert.equal(result.paragraphs.length, 2);
  assert.equal(result.sentences.length, canonical.length);
  assert.equal(result.sentences[0].paragraphIndex, 0);
  assert.equal(result.sentences[0].paragraphEndIndex, 1);
  assert.deepEqual(modelSentences(text)[0], { index: 0, paragraphIndex: 0, sampleUnitIndex: 0, spanType: 'prose', eligibleForDetection: true, paragraphEndIndex: 1, text: canonical[0].text });
});

test('empty input and repeated text have stable, source-bound paragraph locations', () => {
  assert.deepEqual(paragraphSpans(' \r\n\r\n '), []);
  assert.deepEqual(modelSentences(''), []);
  const text = '같은 문장이다.\n\n같은 문장이다.';
  const result = buildDetectInputDocument(text);
  assert.equal(result.sentences.length, 2);
  assert.equal(result.sentences[0].start, 0);
  assert.equal(result.sentences[1].start, text.lastIndexOf('같은'));
  assert.deepEqual(result.sentences.map(sentence => sentence.paragraphIndex), [0, 1]);
});

test('public evidence translates trimmed model offsets back to exact source and paragraph positions', () => {
  const text = ' \r\n 첫 문장이다. 두 번째 문장이다.\r\n \t\r\n세 번째 문장이다.  ';
  const evidence = groundSignals([{category:'ending_repetition',scope:'recurring',strength:'moderate',evidenceSentences:[0,2]}],text.trim());
  const before = JSON.stringify(evidence);
  const result = locatePublicEvidence(evidence,text);
  assert.equal(JSON.stringify(evidence),before,'cached scoring evidence is immutable');
  assert.deepEqual(result[0].locations.map(loc=>loc.paragraphIndex),[0,1]);
  assert.equal(text.slice(result[0].locations[0].start,result[0].locations[0].end),'첫 문장이다.');
  assert.equal(text.slice(result[0].locations[1].start,result[0].locations[1].end),'세 번째 문장이다.');
  assert.equal(result[0].strength,evidence[0].strength);
  assert.equal(result[0].scope,evidence[0].scope);
});

test('stale offsets are not promoted to verified public locations', () => {
  const text = '첫 문장이다.\n\n둘째 문장이다.';
  const item = {category:'ending_repetition',locationStatus:'source_range_verified',locations:[{sentenceIndex:0,start:2,end:8}]};
  const result = locatePublicEvidence([item],text);
  assert.equal(result[0].locationStatus,'unlocated');
  assert.deepEqual(result[0].locations,[]);
});
