'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine-gpt-prod');

test('web-search trust requires the exact canonical path and query', () => {
  const source = 'https://Example.com/research/item?id=7&utm_source=official#section';
  const verified = new Set([engine.normalizeEvidenceUrl(source)]);
  assert.equal(engine.hasVerifiedUrl(source, verified), true);
  assert.equal(engine.matchedVerifiedUrl(source, verified), 'https://example.com/research/item?id=7&utm_source=official');
  assert.equal(engine.hasVerifiedUrl('https://example.com/research/item?id=8&utm_source=official', verified), false);
  assert.equal(engine.hasVerifiedUrl('https://example.com/research/item/child?id=7&utm_source=official', verified), false);
  assert.equal(engine.hasVerifiedUrl('https://example.com/?next=https://169.254.169.254/', verified), false);
});

test('path case remains significant and fragments do not', () => {
  const verified = new Set([engine.normalizeEvidenceUrl('https://example.com/Case/Report#one')]);
  assert.equal(engine.hasVerifiedUrl('https://example.com/Case/Report#two', verified), true);
  assert.equal(engine.hasVerifiedUrl('https://example.com/case/report', verified), false);
});
