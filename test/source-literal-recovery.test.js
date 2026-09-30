'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverSourceLiterals, restoreAttributedQuoteSlots } = require('../engine-gpt-prod/sourceLiteralRecovery');
const structure = require('../engine-gpt-prod/structureChunk');
const voice = require('../engine-gpt-prod/voiceProfile');
const reference = '교재 참고: p.35~36 7.3.2. 관찰 결과 정리';

test('attested parenthetical terms survive a slot restore while new or altered parentheticals refuse it', () => {
  const source = `1. 관찰 기록\n“관찰 기록은 분류(classification)를 거쳐 해석한다.” ${reference}`;
  const output = `1. 관찰 기록\n분류(classification)한 관찰 기록을 해석한다. ${reference}`;
  const chunks = structure.splitChunksForGpt(source).chunks;
  assert.equal(recoverSourceLiterals(source, output, chunks).text, source);
  for (const changed of [output.replace('classification', 'evaluation'), output.replace('해석한다.', '해석한다(새 정보).')]) {
    const result = restoreAttributedQuoteSlots(source, changed, chunks);
    assert.equal(result.restoredCount, 0);
    assert.equal(result.text, changed);
  }
});

test('narrative moved from after a reference into the quote slot is never consumed', () => {
  const source = `1. 관찰 기록\n“여러 활동을 관찰한 결과를 정리한다.” ${reference}\n관찰은 3주간 진행되었다.`;
  const output = `1. 관찰 기록\n활동의 관찰 결과를 정리했다. 관찰은 3주간 진행되었다. ${reference}`;
  const result = restoreAttributedQuoteSlots(source, output, structure.splitChunksForGpt(source).chunks);
  assert.equal(result.restoredCount, 0);
  assert.ok(result.text.includes('관찰은 3주간 진행되었다.'));
});

test('an existing quotation moved after its citation is not duplicated', () => {
  const literal = '“활동을 관찰한 결과를 정리한다.”';
  const source = `1. 관찰 기록\n${literal} ${reference}`;
  const output = `1. 관찰 기록\n작성자는 이렇게 기록했다. ${reference}\n${literal}`;
  const result = restoreAttributedQuoteSlots(source, output, structure.splitChunksForGpt(source).chunks);
  assert.equal(result.restoredCount, 0);
  assert.equal(result.text.split(literal).length - 1, 1);
  assert.ok(result.text.includes('작성자는 이렇게 기록했다.'));
});

test('owned quotations on a heading row never become body restoration slots', () => {
  const source = `1. “왜 기록하는가? 관찰의 목적”\n${reference}`;
  const output = source.replace('\n', '\n이 절에서는 목적을 정리한다.\n');
  const result = restoreAttributedQuoteSlots(source, output, structure.splitChunksForGpt(source).chunks);
  assert.equal(result.restoredCount, 0);
  assert.equal(result.text, output);
});

test('short source terms and book-title delimiters in a quote slot are not erased', () => {
  const source = `1. 관찰 기록\n“여러 활동을 관찰하고 결과를 기록한다.” ${reference}\n\n2. 용어\n‘분류’라는 용어를 설명한다.`;
  for (const content of ['‘분류’라는 용어로 결과를 정리한다.', '『관찰 안내』를 읽고 결과를 정리한다.',
    '분류」를 통해 결과를 정리한다.', "'분류'라는 용어로 결과를 정리한다.", '【분류】라는 용어로 결과를 정리한다.']) {
    const output = source.replace('“여러 활동을 관찰하고 결과를 기록한다.”', content);
    const result = restoreAttributedQuoteSlots(source, output, structure.splitChunksForGpt(source).chunks);
    assert.equal(result.restoredCount, 0);
    assert.ok(result.text.includes(content));
  }
});

test('a missing rewritten quotation is restored only between its witnessed heading and citation', () => {
  const source = `1. 관찰 기록\n“여러 활동을 관찰한 결과를 구체적으로 정리한다.“ ${reference}\n${reference}\n\n2. 본인 의견\n활동을 지속할 수 있는 환경을 마련해야 한다.`;
  const output = `1. 관찰 기록\n관찰한 여러 활동의 결과를 정리했다. ${reference}\n${reference}\n\n2. 본인 의견\n활동이 계속되도록 환경을 조성해야 한다.`;
  const chunks = structure.splitChunksForGpt(source).chunks;
  const fixed = recoverSourceLiterals(source, output, chunks);
  assert.equal(voice.auditDirectQuoteIntegrity(source, output).pass, false);
  assert.equal(fixed.quoteRestoredCount, 1);
  assert.equal(fixed.quotePass, true);
  assert.match(fixed.text, /“여러 활동을 관찰한 결과를 구체적으로 정리한다\.“/u);
  assert.ok(fixed.text.endsWith('활동이 계속되도록 환경을 조성해야 한다.'));
  const options = { source, chunks, outputText: fixed.text, mode: 'assignment', normalizeVisualGaps: true };
  const final = structure.restoreFinalDocumentLayout(options);
  assert.equal(final.pass, true);
  assert.equal(voice.auditDirectQuoteIntegrity(source, final.text).pass, true);
  assert.equal(structure.restoreFinalDocumentLayout({ ...options, outputText: final.text }).text, final.text);
  const delivery = recoverSourceLiterals(source, final.text, chunks);
  assert.equal(delivery.text, final.text);
  const again = structure.restoreFinalDocumentLayout({ ...options, outputText: delivery.text });
  assert.equal(recoverSourceLiterals(source, again.text, chunks).text, delivery.text);
});

test('CRLF quote slot recovery uses the same normalized coordinates as citation ownership', () => {
  const source = `1. 관찰 기록\r\n“여러 활동의 결과를 구체적으로 기록한다.“ ${reference}\r\n\r\n2. 의견\r\n기록을 활용한다.`;
  const output = source.replace('“여러 활동의 결과를 구체적으로 기록한다.“', '활동 결과를 정리한다.');
  const fixed = recoverSourceLiterals(source, output, structure.splitChunksForGpt(source).chunks);
  assert.equal(fixed.quotePass, true);
  assert.equal(fixed.citationPass, true);
  assert.equal(fixed.quoteRestoredCount, 1);
  assert.equal(fixed.text, source.replace(/\r\n/gu, '\n'));
});

test('narrative between the heading and the original quote makes slot recovery inapplicable', () => {
  const source = `1. 관찰 기록\n작성자는 현장 상황을 설명했다. “활동 결과를 기록한다.” ${reference}`;
  const output = `1. 관찰 기록\n현장에서 별도 관찰을 수행했다. 활동 결과를 새롭게 정리했다. ${reference}`;
  const fixed = restoreAttributedQuoteSlots(source, output, structure.splitChunksForGpt(source).chunks);
  assert.equal(fixed.restoredCount, 0);
  assert.equal(fixed.text, output);
});

test('a missing citation or moved existing quote cannot witness a quote replacement', () => {
  const first = '“첫 번째 활동은 관찰하여 정리한다.”';
  const second = '“두 번째 활동은 검토하여 기록한다.”';
  const source = `1. 관찰 기록\n${first} ${reference}\n\n2. 검토 결과\n${second} 교재 참고: p.40 검토 방법`;
  for (const output of [source.replace(reference, ''), source.replace(first, second)]) {
    const fixed = restoreAttributedQuoteSlots(source, output, structure.splitChunksForGpt(source).chunks);
    assert.equal(fixed.restoredCount, 0);
    assert.ok(fixed.refusedCount > 0);
  }
});
