'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const literal = require('../engine-gpt-prod/literalSpans');
const structure = require('../engine-gpt-prod/structureChunk');

test('restored equation/code audit chunks preserve source identity without mutating masked recovery data', () => {
  const source = '1. 적분 성질\n\n∫ δ(t)dt = 1\n\n설정값은 `delay = 3`이다. 적분 결과는 기준값을 나타낸다.';
  const inlineCodeFreeze = literal.freezeInlineCode(source);
  const inlineMathFreeze = literal.freezeMath(inlineCodeFreeze.text);
  const plan = structure.splitChunksForGpt(inlineMathFreeze.text);
  const original = JSON.stringify(plan.chunks);
  const chunks = literal.materializeChunkLiterals(plan.chunks, { inlineMathFreeze, inlineCodeFreeze });
  assert.equal(JSON.stringify(plan.chunks), original);
  assert.deepEqual(chunks.map(c => [c.index, c.start, c.end, c.sourceSpanId]),
    plan.chunks.map(c => [c.index, c.start, c.end, c.sourceSpanId]));
  assert.ok(plan.chunks.some(c => c.locked && c.text.includes('ZXQMATH')));
  assert.ok(chunks.some(c => c.locked && c.text.includes('∫ δ(t)dt = 1')));
  assert.doesNotMatch(chunks.map(c => c.text).join('\n'), /ZXQ(?:MATH|CODE)/u);
  assert.equal(structure.buildStructureAudit({ source, outputText: source, chunks, plan }).pass, true);
  for (const changed of [source.replace('∫ δ(t)dt = 1', ''), source.replace('∫ δ(t)dt = 1', '∫ δ(t)dt = 2')]) {
    const audit = structure.buildStructureAudit({ source, outputText: changed, chunks, plan });
    assert.equal(audit.pass, false);
    assert.ok(audit.lostLockedCount > 0);
  }
});

test('projection restores only known literals, including output text, and never fabricates missing source blocks', () => {
  const frozen = { blocks: [{ token: 'ZXQMATH0000QXZ', value: '$x=1$' }] };
  const chunks = [{ text: 'ZXQMATH0000QXZ ZXQMATH9999QXZ', outputText: 'ZXQMATH0000QXZ' },
    { text: '다른 문장', outputText: null }];
  const result = literal.materializeChunkLiterals(chunks, { inlineMathFreeze: frozen });
  assert.equal(result[0].text, '$x=1$ ZXQMATH9999QXZ');
  assert.equal(result[0].outputText, '$x=1$');
  assert.equal(result[1].text, '다른 문장');
  assert.equal(result[1].outputText, null);
  assert.equal(chunks[0].outputText, 'ZXQMATH0000QXZ');
});
