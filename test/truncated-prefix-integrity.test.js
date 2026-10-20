'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { introducedTruncatedPrefixes: audit } = require('../engine-gpt-prod/truncatedPrefixIntegrity');
const prefix = '마을 도서관은 새로 들어온 책을 처음부';
const complete = '마을 도서관은 새로 들어온 책을 처음부터 주제에 따라 분류하고 주민들이 쉽게 찾도록 안내한다.';
const source = complete.replace('처음부터', '처음부\n터');
const output = prefix + '\n\n' + complete;
test('a uniquely owned unfinished particle prefix before its full sentence is detected without text in evidence', () => {
  const found = audit(source, output);
  assert.equal(found.length, 1);
  assert.equal(output.slice(found[0].outputStart, found[0].outputEnd), prefix);
  assert.ok(Object.entries(found[0]).every(([k, v]) => k === 'code' || typeof v === 'number'));
});
test('source repetitions, unchanged line wraps, headings and preserve-lines mode do not trip the prefix gate', () => {
  assert.equal(audit(source + '\n\n' + source, output).length, 0);
  assert.equal(audit(source, source).length, 0);
  assert.equal(audit(complete, output).length, 0);
  assert.equal(audit(source, output, { preserveLines: true }).length, 0);
  const heading = '마을 도서관의 새 도서 정리 계획';
  assert.equal(audit(heading + '\n' + complete, heading + '\n\n' + complete).length, 0);
});
test('quoted and fenced code examples are protected, including a multi-paragraph quotation', () => {
  for (const [left, right] of [['“', '”'], ["'", "'"], ['```\n', '\n```']]) {
    assert.equal(audit(source, left + output + right).length, 0);
  }
});
test('two reversed title quotations do not shield the intervening prose as a false giant quote', () => {
  const lead = '’도서관 운영백서‘에서는 안내 기준을 설명한다. ';
  const tail = '\n\n새로운 ’도서 관리 사업‘이 시작된다.';
  assert.equal(audit(lead + source + tail, lead + output + tail).length, 1);
  assert.equal(audit(source, '’' + prefix + '‘\n\n' + complete).length, 0);
});
