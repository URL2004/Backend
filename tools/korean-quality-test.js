'use strict';

const assert = require('assert');
const koreanQuality = require('../engine/koreanQuality');

function run() {
  detectsTranslationese();
  detectsGrammarRegression();
  doesNotBlockStyleOnlyRegression();
  buildsCompactPromptHints();
  detectsRegisterShiftAsRepairCandidate();
  console.log('korean-quality tests passed');
}

function detectsTranslationese() {
  const text = '이 시스템을 통해 데이터를 처리할 수 있다. 기업에 대해 분석하고 전략적 효과를 확인할 수 있다.';
  const report = koreanQuality.analyzeText(text);
  const ids = report.topPatterns.map(p => p.id);
  assert(ids.includes('through_overuse'), 'through_overuse should be detected');
  assert(ids.includes('can_formula'), 'can_formula should be detected');
  assert(report.translationeseRisk > 0, 'translationese risk should be positive');
}

function detectsGrammarRegression() {
  const source = '화장실은 물때를 중심으로 정리했다. 작업 후 상태를 확인했다.';
  const output = '화장실은 물때를 중심으로 정리했다. 작업 후 상태를 확인했으며';
  const gate = koreanQuality.evaluateKoreanQuality(source, output);
  assert.strictEqual(gate.action, 'escalation_candidate');
  assert.strictEqual(gate.blocking, true);
  assert.strictEqual(gate.reason, 'korean_quality_grammar_regression');
}

function doesNotBlockStyleOnlyRegression() {
  const source = '사무실 바닥의 먼지를 정리했다. 화장실 오염도 함께 닦았다. 작업 후 상태를 확인했다.';
  const output = '사무실 바닥의 먼지를 정리했다. 이처럼 실내 청결은 한층 중요한 의미를 가진다. 결국 전반적 관리가 핵심이다.';
  const gate = koreanQuality.evaluateKoreanQuality(source, output);
  assert(['warn', 'repair_candidate', 'pass'].includes(gate.action), 'style-only regression should not be escalation');
  assert.strictEqual(gate.blocking, false);
}

function buildsCompactPromptHints() {
  const report = koreanQuality.analyzeText('조사를 통해 의미 있는 전략적 효과를 확인할 수 있다.');
  const hints = koreanQuality.buildPromptHints(report, { max: 3 });
  assert(hints.includes('[한국어 품질 힌트]'));
  assert(hints.split('\n').filter(line => line.startsWith('- ')).length <= 3);
}

function detectsRegisterShiftAsRepairCandidate() {
  const source = '현장을 확인했습니다. 바닥을 정리했습니다. 마무리 상태도 점검했습니다.';
  const output = '현장을 확인했다. 바닥을 정리했다. 마무리 상태도 점검했다.';
  const gate = koreanQuality.evaluateKoreanQuality(source, output);
  assert.strictEqual(gate.action, 'repair_candidate');
  assert.strictEqual(gate.reason, 'korean_quality_register_shift');
  assert.strictEqual(gate.blocking, false);
}

run();
