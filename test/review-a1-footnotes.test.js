'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../engine-gpt-prod/sourcePreflight');
const c = require('../engine-gpt-prod/inlineCitationLayout');
test('attached numeric citations stay with sentences regardless of following opener', () => {
  for (const opener of ['이러한 관찰은 의미가 있다.', '다음 실험을 진행했다.']) {
    const source = `실험 자료에는 서로 다른 측정 결과가 존재한다.9) ${opener}`;
    assert.equal(p.repairInlineHeadingBoundaries(source).text, source);
    assert.ok(!p.auditAndSanitizeSource(source).text.includes('\n\n9)'));
    assert.equal(c.restoreInlineCitationLayout(source, source.replace('.9)', '.\n\n9)')).text, source);
  }
});
test('genuine numbered items and fused section headings retain their boundaries', () => {
  const source = '1) 첫 관찰을 기록한다. 2) 다음 관찰을 기록한다.';
  assert.ok(p.repairInlineHeadingBoundaries(source).text.includes('\n\n2)'));
  assert.ok(p.repairInlineHeadingBoundaries('관찰을 마쳤다.2) 결론\n결과를 정리한다.').text.includes('\n\n2) 결론'));
  assert.equal(p.repairInlineHeadingBoundaries('1) 첫 관찰\n2) 다음 관찰').text, '1) 첫 관찰\n2) 다음 관찰');
  for (const gap of ['', ' ']) {
    const list = `1) 첫 관찰 결과를 자세하게 기록한다.${gap}2) 다음 관찰 결과를 기록한다.`;
    const separated = p.repairInlineHeadingBoundaries(list).text;
    assert.ok(separated.includes('\n\n2)'));
    assert.equal(c.restoreInlineCitationLayout(list,separated).repairCount,0);
  }
});
