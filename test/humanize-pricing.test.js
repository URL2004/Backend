'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RESTRUCTURE_TIERS,
  restructureCredit
} = require('../lib/humanizePricing');

test('고급 휴머나이징 가격표는 단일 export에 3,000자 신규 구간을 포함한다', () => {
  assert.deepEqual(RESTRUCTURE_TIERS, [
    { maxLength: 3000, base: 100, evidence: 50 },
    { maxLength: 10000, base: 200, evidence: 100 },
    { maxLength: 20000, base: 400, evidence: 100 },
    { maxLength: Infinity, base: 600, evidence: 100 }
  ]);
  assert.equal(Object.isFrozen(RESTRUCTURE_TIERS), true);
  assert.ok(RESTRUCTURE_TIERS.every(Object.isFrozen));
});

test('고급 휴머나이징 가격은 각 길이 경계와 근거 보강 추가금을 지킨다', () => {
  const expected = [
    [2999, 100, 150],
    [3000, 100, 150],
    [3001, 200, 300],
    [10000, 200, 300],
    [10001, 400, 500],
    [20000, 400, 500],
    [20001, 600, 700]
  ];

  for (const [length, base, withEvidence] of expected) {
    assert.equal(restructureCredit(length, false), base, `${length}자 기본 가격`);
    assert.equal(restructureCredit(length, true), withEvidence, `${length}자 근거 보강 가격`);
  }
});

test('비정상 또는 음수 길이는 0자로 정규화한다', () => {
  assert.equal(restructureCredit(-1), 100);
  assert.equal(restructureCredit(Number.NaN, true), 150);
});
