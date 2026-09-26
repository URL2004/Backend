'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditConvolutionPrecision, clarifyConvolutionPrecision } = require('../engine-gpt-prod/technicalExplanationAudit');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');
const structureChunk = require('../engine-gpt-prod/structureChunk');

const source = '콘벌루션은 (f*g)(t)=∫ f(τ)g(t-τ)dτ 로 정의됩니다. 두 함수를 겹쳐 보는 설명은 직관입니다.';
const shorthand = '그래프에서 콘벌루션을 구할 때는 함수를 이동합니다. 파형이 겹치기 시작하면 겹친 면적의 크기에 따라 결과 값이 정해집니다.';

test('a source-attested integral qualifies an unqualified overlap-area claim', () => {
  const before = auditConvolutionPrecision(source, shorthand);
  assert.equal(before.issues.length, 1);
  const result = clarifyConvolutionPrecision(source, shorthand);
  assert.equal(result.clarifiedCount, 1);
  assert.equal(result.after.pass, true);
  assert.match(result.text, /겹친 구간에서 두 함수의 곱을 적분한 값에 따라 결과가 정해집니다/u);
  assert.match(result.text, /^그래프에서 콘벌루션을 구할 때는 함수를 이동합니다/u);
  assert.equal(auditCandidateIntegrity({ source, before: shorthand, candidate: result.text, mode: 'assignment' }).pass, true);
  assert.equal(structureChunk.buildStructureAudit({ source, outputText: result.text }).pass, true);
});

test('an already precise product-integral explanation is not rewritten', () => {
  const precise = '콘벌루션은 두 함수가 겹친 구간에서 함숫값을 곱해 적분한 값입니다.';
  const result = clarifyConvolutionPrecision(source, precise);
  assert.equal(result.applied, false);
  assert.equal(result.text, precise);
});

test('without an in-document formula no factual correction is inferred', () => {
  const result = clarifyConvolutionPrecision('콘벌루션을 그래프로 이해합니다.', shorthand);
  assert.equal(result.before.applicable, false);
  assert.equal(result.applied, false);
});

test('unit-height rectangular pulses and quoted text are not auto-corrected', () => {
  const rectangular = '구형 펄스의 콘벌루션에서는 겹친 면적의 크기에 따라 결과가 정해집니다.';
  assert.equal(clarifyConvolutionPrecision(source, rectangular).applied, false);
  const quoted = '콘벌루션 수업 자료는 “겹친 면적의 크기에 따라 결과가 정해집니다.”라고 씁니다.';
  assert.equal(clarifyConvolutionPrecision(source, quoted).applied, false);
});

test('an unrelated area explanation is left alone', () => {
  const other = '도형이 겹친 면적의 크기에 따라 색을 정합니다.';
  assert.equal(clarifyConvolutionPrecision(source, other).applied, false);
});

test('late candidates cannot reintroduce an imprecise claim', () => {
  const precise = clarifyConvolutionPrecision(source, shorthand).text;
  const verdict = auditCandidateIntegrity({ source, before: precise, candidate: shorthand, mode: 'assignment' });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reasons.includes('technical_explanation_worsened'));
});
