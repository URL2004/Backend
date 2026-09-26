'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditTechnicalRelations, restoreAttestedRelations } = require('../engine-gpt-prod/technicalRelationAudit');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');

const evenSource = '우함수 신호의 b_n 계수는 sin 함수와의 곱으로 구한다. 우함수와 기함수를 곱한 결과는 기함수다. 따라서 대칭 구간 적분은 0이다.';
const oddSource = '기함수 신호의 a_n 계수는 cosine 함수와의 곱으로 구한다. 기함수와 cosine 함수의 곱은 기함수다. 따라서 대칭 구간 적분은 0이다.';
const source = `${evenSource}\n\n${oddSource}`;
const evenBad = '우함수 신호의 b_n 계수는 sin 함수와의 곱으로 구한다. 기함수와 cosine 함수의 곱은 기함수다. 따라서 b_n=0이다.';
const oddGood = '기함수 신호의 a_n 계수는 cosine 함수와의 곱으로 구한다. 기함수와 cosine 함수의 곱은 기함수다. 따라서 a_n=0이다.';

test('adjacent paragraph proof migration is found and restored locally', () => {
  const output = `${evenBad}\n\n${oddGood}`;
  const before = auditTechnicalRelations(source, output);
  assert.deepEqual(before.issues.map(issue => issue.type), ['even']);
  const restored = restoreAttestedRelations(source, output);
  assert.equal(restored.restoredCount, 1);
  assert.equal(restored.after.pass, true);
  assert.match(restored.text.split('\n\n')[0], /우함수와 기함수를 곱한 결과/u);
  assert.equal(restored.text.split('\n\n')[1], oddGood);
  assert.equal(auditCandidateIntegrity({ source, before: output, candidate: restored.text, mode: 'assignment' }).pass, true);
});

test('reverse odd-function proof migration is also caught', () => {
  const bad = '기함수 신호의 a_n 계수는 cosine 함수와의 곱으로 구한다. 우함수와 sine 함수의 곱은 기함수다. 따라서 a_n=0이다.';
  const result = restoreAttestedRelations(source, `${evenSource}\n\n${bad}`);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.after.pass, true);
});

test('source formula is not copied into the repaired proof clause', () => {
  const attested = '우함수 신호에서 b_n 계수에는 s(t)와 sin(2πn f_0 t)의 곱이 들어가는데, 우함수와 기함수를 곱한 결과는 기함수다.';
  const result = restoreAttestedRelations(attested, evenBad);
  assert.equal(result.restoredCount, 1);
  assert.equal((result.text.match(/sin/gu) || []).length, 1);
  assert.equal(result.after.pass, true);
});

test('no source attestation, duplicate sections, and comparison prose are not auto-edited', () => {
  assert.equal(restoreAttestedRelations('우함수의 b_n에는 sin이 포함된다.', evenBad).applied, false);
  assert.equal(restoreAttestedRelations(`${source}\n\n${evenSource}`, evenBad).applied, false);
  const comparison = '우함수 신호의 b_n에는 sin이 포함된다. 반면 기함수와 cosine 함수의 곱은 기함수다. 우함수와 기함수를 곱한 결과도 기함수다.';
  assert.equal(auditTechnicalRelations(source, comparison).pass, true);
});

test('a later candidate cannot reintroduce an attested wrong proof', () => {
  const good = `${evenSource}\n\n${oddGood}`;
  const bad = `${evenBad}\n\n${oddGood}`;
  const verdict = auditCandidateIntegrity({ source, before: good, candidate: bad, mode: 'assignment' });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reasons.includes('technical_relation_worsened'));
});

test('ordinary technical prose without symmetry proof remains untouched', () => {
  const prose = '콘벌루션은 두 함수의 곱을 적분한다. 직관적으로 겹치는 영역을 설명할 수 있다.';
  const result = restoreAttestedRelations(prose, prose);
  assert.equal(result.applied, false);
  assert.equal(result.text, prose);
});
