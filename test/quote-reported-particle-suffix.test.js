'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const documentProfile = { profile: 'report_assignment' };
const quoteCodes = new Set(['closed_quote_spacing', 'closed_quote_particle_spacing', 'quote_terminal_punctuation_review']);

test('reported quotation plus bound auxiliary particles stay attached in both deterministic paths', () => {
  for (const suffix of ['라고만', '라고도', '라고는', '라고까지', '라고조차', '이라고만', '이라고도', '고만', '고도', '고는']) {
    for (const [open, close] of [['“', '”'], ['‘', '’'], ['「', '」']]) {
      const text = `그는 ${open}준비를 마쳤다${close}${suffix} 말했다.`;
      assert.equal(korean.detectTextIssues(text).some(issue => quoteCodes.has(issue.code)), false, suffix);
      const spaced = text.replace(`${close}${suffix}`, `${close} ${suffix}`);
      for (const repair of [korean.applySafeDeterministicRepairs, korean.applySafeFormattingRepairs]) {
        assert.equal(repair({ source: text, outputText: text, documentProfile }).text, text, suffix);
        const result = repair({ source: text, outputText: spaced, documentProfile }).text;
        assert.equal(result, text, suffix);
        assert.equal(result.replace(/\s/gu, ''), spaced.replace(/\s/gu, ''));
        assert.equal(repair({ source: text, outputText: result, documentProfile }).text, result);
      }
    }
  }
});

test('complete quoted speech, independent attribution and independent next sentences keep distinct spacing', () => {
  for (const text of ['그는 “준비를 마쳤다.”라고만 말했다.', '그는 “준비를 마쳤다.” 하고 말했다.',
    '그는 “준비를 마쳤다” 하는 말을 남겼다.', '“완료했다.” 이 문장은 그대로 남았다.',
    '표현은 “발표했다” 라고만들었다는 새로운 조어였다.']) {
    const result = korean.applySafeFormattingRepairs({ source: text, outputText: text, documentProfile }).text;
    if (text.includes('라고만들었다')) {
      assert(result.includes('” 라고만들었다'), 'prefix coincidence is not a complete particle suffix');
    } else assert.equal(result, text);
    assert.equal(korean.applySafeFormattingRepairs({ source: result, outputText: result, documentProfile }).text, result);
  }
});

test('quote contents and code remain outside the surface repair ownership', () => {
  const text = '그는 “안쪽   공백은 그대로”라고만 말했다.\n\n```\nconst quoted = “예시” 라고만;\n```';
  assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: text, documentProfile }).text, text);
});
