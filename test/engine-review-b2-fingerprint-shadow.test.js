'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');

// 2026-10-09 점검(F-04): 문서마다 한 번씩 주입되는 계열을 관측 전용 목록에 넣는다.
// 기록만 남기고 위반·재시도에는 연결하지 않는다.

const NEW_SHADOW_CODES = [
  'touching_adjacent',
  'advance_from_there',
  'because_of_this',
  'interlocked',
  'also_especially_impressive'
];

test('새 관측 계열 다섯 가지는 원문 대비 순증만 shadow로 기록하고 위반을 만들지 않는다', () => {
  const source = [
    '이 책의 질문은 내 고민과 여기에 맞닿는다.',
    '기술 설명 수준을 넘어 적용 사례까지 다룬다.',
    '그래서 결과가 달라졌다.',
    '두 요인이 함께 작용해 변화가 생겼다.',
    '마지막 장의 결말도 기억에 남았다.'
  ].join(' ');
  const output = [
    '이 책의 질문은 내 고민과 맞닿아 있다.',
    '기술을 설명하는 데서 나아가 적용 사례까지 다룬다.',
    '이 때문에 결과가 달라졌다.',
    '두 요인이 맞물려 변화가 생겼다.',
    '마지막 장의 결말도 특히 인상 깊었다.'
  ].join(' ');
  const report = fingerprint.auditFingerprint(source, output, 'general');
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  for (const code of NEW_SHADOW_CODES) {
    const row = report.shadow.find(item => item.code === code);
    assert.ok(row, code);
    assert.equal(row.sourceCount, 0, code);
    assert.equal(row.outputCount, 1, code);
    assert.equal(row.delta, 1, code);
  }
  assert.ok(fingerprint.SHADOW_PATTERNS.length >= 10);
});

test('원문에 이미 있던 계열은 순증 0으로 기록한다', () => {
  const text = '두 요인이 맞물려 변화가 생겼다. 이 때문에 결과가 달라졌고, 이 점이 내 경험과 맞닿아 있다.';
  const report = fingerprint.auditFingerprint(text, text, 'report_assignment');
  assert.equal(report.pass, true);
  for (const code of ['interlocked', 'because_of_this', 'touching_adjacent']) {
    const row = report.shadow.find(item => item.code === code);
    assert.equal(row.delta, 0, code);
  }
  // `원인이 때문에`처럼 조사 뒤의 이는 세지 않는다.
  const noun = fingerprint.auditFingerprint('', '비용 상승이 때문에 늦어졌다.', 'general');
  assert.equal(noun.shadow.find(item => item.code === 'because_of_this').outputCount, 0);
});
