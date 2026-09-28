'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSemanticAuditText: prepare } = require('../engine-gpt-prod/semanticAuditFormatting');
const { relationDigest } = require('../engine-gpt-prod/layoutRelations');
const options = { mode: 'assignment', requestStrength: 'advanced', documentProfile: { profile: 'report_assignment' } };

test('empty, whitespace-only and frozen candidates remain byte-exact', async () => {
  for (const value of ['', ' \n\t\n ', 'ZXQLOCK0000QXZ\n본문이다.', 'ZXQCODE10000QXZ']) {
    assert.equal(await prepare(value, value, options), value);
  }
});

test('quote compound-particle formatting settles before validation, not by reusing a verdict', async () => {
  const source = '이 절은 ‘연구원’으로서의 책임을 설명한다.';
  const input = '\n\n이 절은 ‘연구원’ 으로서의 책임을 설명한다.\n\n';
  const result = await prepare(source, input, options);
  assert.equal(result, '\n\n' + source + '\n\n');
  assert.equal(await prepare(source, result, options), result);
  assert.equal(result.replace(/\s/gu, ''), input.replace(/\s/gu, ''));
  assert.equal(relationDigest(result), relationDigest(input));
});

test('code, formula, direct quotation and tabular values do not silently change', async () => {
  for (const value of [
    '명령은 `a  + b` 이다. 식은 $$x +  y$$ 이다.',
    '```js\nconst  name = "a  b";\n```\n\n이 코드를 설명한다.',
    '~~~text\na  b\n~~~\n\n이 내용을 설명한다.',
    '그는 “값은 0.05이며, 조건 A에서만 적용한다.” 하고 말했다.',
    '| 조건 | 수치 |\n| --- | --- |\n| A | 0.05 |\n| B | 0.50 |'
  ]) {
    const result = await prepare(value, value, options);
    assert.equal(result, value);
    assert.equal(await prepare(value, result, options), result);
  }
});

test('headings and numbered relationships survive paragraph gap normalization', async () => {
  const source = 'Ⅰ. 실험\n\n1. 조건 A\n\n조건 A에서 값을 측정한다.\n\n2. 조건 B\n\n조건 B에서는 값을 비교한다.';
  const candidate = source.replace(/\n\n/gu, '\n');
  const result = await prepare(source, candidate, options);
  assert.equal(relationDigest(result), relationDigest(candidate));
  assert.equal(result.replace(/\s/gu, ''), candidate.replace(/\s/gu, ''));
  assert.equal(await prepare(source, result, options), result);
});

test('early paragraph role work is observed once, without counting the idempotence probe', async () => {
  const { activity } = require('./fixtures/mode-paragraphs');
  const source = '1. 지역 조사 활동\n\n자기평가의견\n\n' + activity;
  const candidate = source.replace(/했다/gu, '하였다');
  const events = [];
  const result = await prepare(source, candidate, { ...options, onApplied: value => events.push(value) });
  assert.notEqual(result, candidate);
  assert.equal(events.length, 1);
  assert.ok(events[0].paragraphRoleBoundaryCount > 0);
  await prepare(source, result, { ...options, onApplied: value => events.push(value) });
  assert.equal(events.length, 1);
});
