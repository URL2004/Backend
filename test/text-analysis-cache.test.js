'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withTextAnalysisCache, memoizeSpans } = require('../engine/textAnalysisCache');
const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');

test('analysis cache is bounded to one request and never shares mutable spans', async () => {
  let calls = 0;
  const read = () => memoizeSpans('test', 'same', () => { calls++; return [{ start: 0, end: 4 }]; });
  await withTextAnalysisCache(async () => {
    const first = read(); first[0].start = 99; first.push({ end: 9 });
    const second = read(); assert.deepEqual(second, [{ start: 0, end: 4 }]);
    second.pop(); assert.equal(read().length, 1);
    await withTextAnalysisCache(async () => assert.equal(read().length, 1));
    assert.equal(calls, 1);
  });
  read(); read(); assert.equal(calls, 3);
  await Promise.all([1, 2, 3].map(() => withTextAnalysisCache(async () => {
    read(); await new Promise(setImmediate); read();
  })));
  assert.equal(calls, 6);
});

test('sentence options and quote offsets remain distinct with memoization', () => withTextAnalysisCache(() => {
  const text = '“A. B. 연구”를 인용했다. 값은 3.5이다.\n두 번째\n행이다.';
  const normal = splitSentenceSpans(text);
  const lines = splitSentenceSpans(text, { preserveLines: true });
  assert.ok(lines.length > normal.length);
  assert.deepEqual(splitSentenceSpans(text), normal);
  const syntax = syntaxSpans(text); syntax[0].end = 1;
  assert.equal(syntaxSpans(text)[0].end, '“A. B. 연구”'.length);
}));

test('many paragraphs evict old entries instead of accumulating unbounded text', () => withTextAnalysisCache(() => {
  let calls = 0;
  const read = key => memoizeSpans('test', key, () => { calls++; return []; });
  read('old');
  for (let i = 0; i < 300; i++) read('paragraph-' + i);
  read('old'); assert.equal(calls, 302);
}));
