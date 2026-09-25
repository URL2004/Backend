'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { bareCodeSpans } = require('../engine/bareCode');
const { syntaxSpans } = require('../engine/textSyntax');
const structure = require('../engine-gpt-prod/structureChunk');
const { buildDetectInputDocument } = require('../lib/detectInputDocument');

const code = '#include <stdio.h>\n\nint total(int n) {\n    if (n > 4) return 0;\n    return n + total(n + 1);\n}\n\nint main() {\n    printf("%d\\n", total(0));\n    return 0;\n}';
const document = '함수를 직접 구현한 경험을 설명한다.\n\n' + code + '\n이 함수는 종료 조건을 확인한다. 이어서 계산 과정을 설명한다.';

test('unfenced functions remain exact while surrounding prose stays editable', () => {
  const plan = structure.splitChunksForGpt(document, { coalesceEditable: true });
  const locked = plan.chunks.filter(c => c.locked && c.lockType === 'code');
  assert.equal(locked.length, 3);
  assert.ok(locked[1].text.includes('\n    if (n > 4) return 0;\n'));
  assert.ok(locked[2].text.endsWith('\n}'));
  assert.ok(plan.chunks.some(c => !c.locked && c.text.includes('이 함수는')));
  assert.equal(structure.mergeChunks(plan.chunks), document);
});

test('strings and comments containing braces do not end a code block', () => {
  const text = 'int sample() {\n    puts("}"); // }\n    /* } */\n    if (true) { return 2; }\n    return 0;\n} // end';
  assert.deepEqual(bareCodeSpans(text).map(s => text.slice(s.start, s.end)), [text]);
});

test('CRLF offsets are preserved without normalization', () => {
  const text = document.replace(/\n/g, '\r\n');
  for (const span of bareCodeSpans(text)) {
    assert.ok(text.slice(span.start, span.end).startsWith('#include') || text.slice(span.start, span.end).startsWith('int '));
  }
  assert.equal(structure.mergeChunks(structure.splitChunksForGpt(text).chunks), text);
});

test('ordinary prose, formulas and unfinished braces never freeze the rest', () => {
  for (const text of ['결과는 {1, 2, 3}으로 표현한다.', 'int 형의 변수를 설명한다. 다음 내용이다.',
    '함수 f(x)는 {x + 1}이다.', 'int unfinished() {\n열린 중괄호 뒤에는 일반 설명이 있다.']) {
    assert.deepEqual(bareCodeSpans(text), [], text);
  }
});

test('fenced and inline ownership is not duplicated by bare-code recognition', () => {
  const text = '```c\n' + code + '\n```';
  const spans = syntaxSpans(text).filter(s => s.spanType === 'code');
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), text);
});

test('detection excludes program syntax but retains authored explanation', () => {
  const input = buildDetectInputDocument(document);
  assert.ok(input.sentences.some(s => s.spanType === 'code' && !s.eligibleForDetection));
  assert.ok(!input.eligibleText.includes('return n'));
  assert.ok(input.eligibleText.includes('함수를 직접 구현한 경험'));
  assert.ok(input.eligibleText.includes('이 함수는 종료 조건'));
});

test('repairing prose duplication does not normalize whitespace in unrelated code', () => {
  const korean = require('../engine-gpt-prod/koreanRefinement');
  const source = code + '\n\n검토 결과를 기록했다.';
  const output = code + '\n\n프로젝트에서 검토 결과를 기록했다. 검토 결과를 기록했다.';
  const repaired = korean.repairIntroducedResidualClauseDuplications(source, output);
  assert.equal(repaired.repairCount, 1);
  assert.ok(repaired.text.startsWith(code + '\n\n'));
});
