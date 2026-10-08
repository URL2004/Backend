'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const input = require('../engine-gpt-prod/sourceInputIntegrity');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const fragment = require('../engine-gpt-prod/fragmentIntegrity');
const trace = require('../engine-gpt-prod/auditTrace');

test('entity normalization uses exact UTF-16 receipts and never recursively decodes', () => {
  const source = '😀 연구&nbsp;개발 &amp; 검증 &#160; 자료 &amp;lt;태그';
  const out = input.normalizeProseEntities(source);
  assert.equal(out.text, '😀 연구 개발 & 검증   자료 &amp;lt;태그');
  assert.equal(out.changes.length, 3);
  for (const edit of out.changes) {
    assert.match(source.slice(edit.sourceStart, edit.sourceEnd), /^&/);
    assert.match(out.text.slice(edit.normalizedStart, edit.normalizedEnd), /^[ &]$/);
  }
  assert.equal(input.normalizeProseEntities(out.text).changed, false);
});

test('entities inside code, quote, URL, math or encoded quote remain literal', () => {
  for (const source of ['`a&nbsp;b`', '```html\na&nbsp;b\n```', '“자료&nbsp;검증”',
    '> 인용&nbsp;문장', 'https://example.org/?a=1&amp;b=2', '$a&nbsp;b$',
    '&quot;인용&nbsp;내용&quot;', '“닫히지 않은&nbsp;인용']) {
    assert.equal(input.normalizeProseEntities(source).text, source);
  }
  const source = '`a&nbsp;b`\n자료&nbsp;검증';
  assert.equal(input.normalizeProseEntities(source).text, '`a&nbsp;b`\n자료 검증');
});

test('preflight normalizes prose entities while exposing incomplete input separately', () => {
  const source = '제를 정리하기 위해 여러 자료를&nbsp;검토했습니다.';
  const out = preflight.auditAndSanitizeSource(source);
  assert.match(out.text, /^제를/);
  assert.ok(out.issueCodes.includes('source_prose_entity_decoded'));
  assert.ok(out.issueCodes.includes('source_clipped_opening_review'));
  const status = input.inputStatus(out, 'pass', 'limited');
  assert.equal(status.completeness, 'review_required');
  assert.equal(status.semantic, 'pass');
  assert.equal(status.style, 'limited');
  assert.equal(status.entityRepairCount, 1);
  assert.equal(input.inputStatus({}, 'pass', 'normal').completeness, 'no_issue_detected');
});

test('a clipped initial noun cannot be invented; intact words are not locked', () => {
  const source = '제를 정리하기 위해 여러 자료를 검토했습니다.';
  assert.ok(fragment.auditFragmentIntegrity(source, source.replace('제를', '글을')).codes.includes('source_clipped_opening_replaced'));
  assert.ok(fragment.auditFragmentIntegrity(source, source.replace('검토', '확인')).pass);
  assert.deepEqual(input.auditInputCompletion(source.replace('제를', '과제를'), '과제를 정리했습니다.'), []);
  assert.equal(input.clippedOpening('제를'), null);
});

test('input and encoding summaries survive bounded compaction without raw text', () => {
  const encoding = input.normalizeProseEntities('자료&nbsp;'.repeat(60));
  const value = { inputStatus: input.inputStatus({ issueCodes: ['source_math_content_gap'] }),
    encodingNormalization: encoding };
  const clean = trace.compactAuditTrace(value);
  assert.equal(clean.encodingNormalization.changeCount, 60);
  assert.equal(clean.encodingNormalization.changes.length, 40);
  assert.equal(clean.encodingNormalization.truncated, true);
  assert.ok(!JSON.stringify(clean).includes('자료'));
  assert.deepEqual(trace.compactAuditTrace(clean), clean);
});
