'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RESTRUCTURE_PRICE_POLICY,
  RESTRUCTURE_TIERS,
  restructureBaseCredit,
  restructureEvidenceCredit,
  restructureCredit
} = require('../lib/humanizePricing');

test('고급 휴머나이징 가격 정책과 호환용 기준점은 변경되지 않도록 고정한다', () => {
  assert.deepEqual(RESTRUCTURE_PRICE_POLICY, {
    base: {
      includedLength: 3000,
      includedCredits: 100,
      mediumMaxLength: 10000,
      mediumMaxCredits: 200,
      mediumStepLength: 350,
      longMaxLength: 30000,
      longStepLength: 250,
      stepCredits: 5,
      maxCredits: 600
    },
    evidence: {
      includedLength: 3000,
      includedCredits: 50,
      graduatedMaxLength: 10000,
      stepLength: 700,
      stepCredits: 5,
      maxCredits: 100
    }
  });
  assert.equal(Object.isFrozen(RESTRUCTURE_PRICE_POLICY), true);
  assert.equal(Object.isFrozen(RESTRUCTURE_PRICE_POLICY.base), true);
  assert.equal(Object.isFrozen(RESTRUCTURE_PRICE_POLICY.evidence), true);

  assert.deepEqual(RESTRUCTURE_TIERS, [
    { maxLength: 3000, base: 100, evidence: 50 },
    { maxLength: 10000, base: 200, evidence: 100 },
    { maxLength: 20000, base: 400, evidence: 100 },
    { maxLength: Infinity, base: 600, evidence: 100 }
  ]);
  assert.equal(Object.isFrozen(RESTRUCTURE_TIERS), true);
  assert.ok(RESTRUCTURE_TIERS.every(Object.isFrozen));
});

test('고급 기본 요금은 5크레딧 단계와 600크레딧 상한을 지킨다', () => {
  const expected = [
    [3000, 100],
    [3001, 105],
    [3350, 105],
    [3351, 110],
    [3699, 110],
    [3700, 110],
    [10000, 200],
    [10001, 205],
    [10250, 205],
    [10251, 210],
    [20000, 400],
    [20001, 405],
    [30000, 600],
    [50000, 600]
  ];

  for (const [length, credits] of expected) {
    assert.equal(restructureBaseCredit(length), credits, `${length}자 기본 가격`);
    assert.equal(restructureCredit(length, false), credits, `${length}자 통합 기본 가격`);
  }
});

test('근거 보강 추가금은 700자가 채워질 때마다 5크레딧씩 오른다', () => {
  const expected = [
    [3000, 50],
    [3001, 50],
    [3699, 50],
    [3700, 55],
    [4399, 55],
    [4400, 60],
    [10000, 100],
    [10001, 100],
    [30000, 100],
    [50000, 100]
  ];

  for (const [length, credits] of expected) {
    assert.equal(restructureEvidenceCredit(length), credits, `${length}자 근거 보강 추가금`);
  }
});

test('대표 글자 수의 기본/근거 보강 포함 총액을 고정한다', () => {
  const expected = [
    [3000, 100, 150],
    [3001, 105, 155],
    [5000, 130, 190],
    [7000, 160, 235],
    [10000, 200, 300],
    [15000, 300, 400],
    [20000, 400, 500],
    [30000, 600, 700]
  ];

  for (const [length, base, withEvidence] of expected) {
    assert.equal(restructureCredit(length, false), base, `${length}자 기본 가격`);
    assert.equal(restructureCredit(length, true), withEvidence, `${length}자 근거 보강 포함 가격`);
  }
});

test('비정상 또는 음수 길이는 0자로 정규화한다', () => {
  assert.equal(restructureBaseCredit(-1), 100);
  assert.equal(restructureEvidenceCredit(Number.NaN), 50);
  assert.equal(restructureCredit(-1), 100);
  assert.equal(restructureCredit(Number.NaN, true), 150);
});
