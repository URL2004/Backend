'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const assist = require('../lib/detectStatisticalAssist');
const preflight = require('../engine-gpt-prod/sourcePreflight');

const letters = Array.from({ length: 650 }, (_, i) => String.fromCharCode(0xac00 + i)).join('');
const features = Array.from({ length: 300 }, (_, i) => letters.slice(i, i + 2));
const modelValue = { features, idf: features.map(() => 1), weights: features.map(() => 1), intercept: 0, threshold: 0 };
const options = { profile: 'general', active: true, independentActive: true, modelValue };
const low = { probability: 18, confidence: 'high', signalEvidence: [] };

test('whitespace padding cannot enable short-prose statistical support', () => {
  const prose = Array.from({ length: 4 }, (_, i) => letters.slice(i * 120, (i + 1) * 120) + '.').join(' ');
  assert(prose.length < 500);
  for (const whitespace of [' '.repeat(30), '\t'.repeat(30), '\u00a0'.repeat(30), '\r\n'.repeat(30)]) {
    const padded = prose.replace(' ', whitespace);
    assert(padded.length >= 500);
    assert.equal(assist.applyAssist(low, padded, options), low);
  }
});

test('whitespace padding cannot disable eligible prose or alter its numeric support', () => {
  const prose = Array.from({ length: 5 }, (_, i) => letters.slice(i * 120, (i + 1) * 120) + '.').join(' ');
  const expected = assist.applyAssist(low, prose, options);
  assert.equal(expected.probability, 49);
  for (const whitespace of [' '.repeat(2700), '\t'.repeat(2700), '\u00a0'.repeat(2700), '\r\n'.repeat(1400)]) {
    assert.deepEqual(assist.applyAssist(low, prose.replace(' ', whitespace), options), expected);
  }
});

test('previous bounded statistical support stays readable and gets a different cache policy', () => {
  const legacy = { version: 'statistical-assist-v4-evidence-bounded', applied: true, originalScore: 60, score: 65, margin: .6, features: 200, profile: 'general' };
  assert.equal(assist.sanitizeSupport(legacy).score, 65);
  assert.equal(assist.sanitizeSupport({ ...legacy, originalScore: 18, score: 49, basis: 'independent_statistics' }).score, 49);
  assert.notEqual(assist.VERSION, legacy.version);
});

test('pasted nonbreaking spaces do not hide numbered prose boundaries', () => {
  for (const space of [' ', '\u00a0', '\u202f']) {
    const source = `탐색 결과를 정리하였다. 1. 문제 분석: 기존 조건을 확인하였다.${space}2. 대안 검토: 다른 방법도 비교하였다.\n3. 결론 정리: 검토 결과를 기록하였다.`;
    const out = preflight.repairInlineHeadingBoundaries(source).text;
    assert.match(out, /확인하였다\.\n\n2\. 대안 검토/);
    assert.equal(out.replace(/\s/gu, ''), source.replace(/\s/gu, ''));
    assert.equal(preflight.repairInlineHeadingBoundaries(out).text, out);
  }
});

test('nonbreaking date and quoted/code boundaries remain intact', () => {
  for (const source of ['검토일은 2026.\u00a09.\u00a020. 이후로 정하였다.', '“확인하였다.\u00a02. 대안을 검토하였다.”', '```\n확인하였다.\u00a02. 대안을 검토하였다.\n```']) {
    assert.equal(preflight.repairInlineHeadingBoundaries(source).text, source);
  }
});
