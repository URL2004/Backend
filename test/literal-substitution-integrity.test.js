'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const literal = require('../engine-gpt-prod/literalSpans');

test('math literal restoration is byte-exact for replacement metacharacters', () => {
  for (const value of ['$$x+y$$', '$$x=$&$$', "$$x=$'$$", '$$x=$`$$', '\\[a=$&+b\\]']) {
    const source = `앞 문장 ${value} 뒤 문장`;
    const frozen = literal.freezeMath(source);
    assert.ok(frozen.count > 0);
    const restored = literal.restoreMath(frozen.text, frozen);
    assert.equal(restored.pass, true);
    assert.equal(restored.text, source);
  }
});

test('inline code restoration never substitutes source prefix/suffix or matched token', () => {
  for (const body of ['$&', '$$', "$'", '$1', '${value}']) {
    const source = `앞 문장 \`${body}\` 뒤 문장`;
    const frozen = literal.freezeInlineCode(source);
    assert.equal(literal.restoreInlineCode(frozen.text, frozen).text, source);
  }
});

test('missing or duplicate placeholders do not gain a successful restoration verdict', () => {
  for (const [freeze, restore, source] of [
    [literal.freezeMath, literal.restoreMath, '검사 $$x+y$$ 결과'],
    [literal.freezeInlineCode, literal.restoreInlineCode, '검사 `$&` 결과']
  ]) {
    const frozen = freeze(source), token = frozen.blocks[0].token;
    for (const changed of [frozen.text.replace(token, ''), frozen.text + token]) {
      const result = restore(changed, frozen);
      assert.equal(result.pass, false);
      assert.equal(result.text, changed);
    }
  }
});
