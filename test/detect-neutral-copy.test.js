'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDetectNarrativePolicy, SCORE_DEFINITION } = require('../lib/detectNarrativePolicy');
test('approved score definition is present across bands without attributing total to displayed metrics', () => {
  for (const probability of [0, 20, 21, 49, 50, 100]) {
    const result = applyDetectNarrativePolicy({ probability, signals: [] });
    assert.ok(result.detail.includes(SCORE_DEFINITION));
    assert.ok(result.detail.includes(`${probability}/100`));
    assert.doesNotMatch(result.detail, /점수를 높인|안전|위험|보정|짧은 글/u);
    assert.equal(result.probability, probability);
  }
});
