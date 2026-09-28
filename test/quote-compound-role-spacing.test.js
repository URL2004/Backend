'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const documentProfile = { profile: 'academic_paper' };
const repair = text => korean.applySafeFormattingRepairs({ source: text, outputText: text, documentProfile }).text;

test('role and instrument particles with possessive endings never acquire a quote gap', () => {
  for (const [noun, suffix] of [['연구자', '로서의'], ['연구원', '으로서의'], ['도구', '로써의'], ['수단', '으로써의']]) {
    for (const [open, close] of [['‘', '’'], ['“', '”'], ['「', '」']]) {
      const text = `이 절은 ${open}${noun}${close}${suffix} 의미를 설명한다.`;
      assert.equal(repair(text), text);
      assert.equal(korean.detectTextIssues(text).some(x => ['closed_quote_spacing', 'quote_terminal_punctuation_review'].includes(x.code)), false);
      const spaced = text.replace(`${close}${suffix}`, `${close} ${suffix}`);
      const result = repair(spaced);
      assert.equal(result, text);
      assert.equal(result.replace(/\s/gu, ''), spaced.replace(/\s/gu, ''));
      assert.equal(repair(result), result);
    }
  }
});

test('compound role grammar does not join independent attribution or change quote contents', () => {
  for (const text of ['그는 “확인했다.” 하고 말했다.', '문서의 ‘역할과 책임’으로서의 의미를 검토했다.', '“확인했다.” 이 문장은 그대로 남았다.']) {
    assert.equal(repair(text), text);
    assert.equal(repair(repair(text)), text);
  }
});
