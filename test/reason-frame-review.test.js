'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTextIssues } = require('../engine-gpt-prod/koreanRefinement');
const has = text => detectTextIssues(text).some(x => x.code === 'case_frame_corruption');
test('hanging reason frame enters existing review without automatic rewriting', () => {
  assert.equal(has('참가자들이 제안을 받아들이는 데에는, 운영 과정에 대한 신뢰가 자리 잡고 있기 때문입니다.'), true);
  assert.equal(has('참가자들이 제안을 받아들이는 데에는, 운영 과정에 대한 신뢰가 자리 잡고 있기 때문입니다 [12:34].'), true);
  for (const text of [
    '참가자들이 제안을 받아들이는 이유는 운영 과정에 대한 신뢰가 자리 잡고 있기 때문입니다.',
    '참가자들이 제안을 받아들이는 데에는 여러 이유가 있습니다.',
    '참가자들이 제안을 받아들이는 데에는, 여러 이유가 있는데 첫째는 운영 과정을 신뢰하기 때문입니다.',
    '참가자들이 제안을 받아들이는 데에는, 시간이 걸리지만 이는 추가 설명이 필요하기 때문입니다.',
    '그는 “제안을 받아들이는 데에는, 운영 과정에 대한 신뢰가 자리 잡고 있기 때문입니다.”라고 말했다.'
  ]) assert.equal(has(text), false, text);
});
