'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeKoreanRefinement } = require('../engine-gpt-prod/koreanRefinement');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');
const owned = '이런 경험이 있어서 나는 관측 장비의 기록을 꾸준히 살펴볼 필요가 있다고 생각한다.';
const generated = '이런 변화가 흥미롭지만 한편으로는 조심스럽기도 하다.';
const source = `연구실에서 관측 기록을 함께 검토했다. ${owned} 다음 회의에서는 조사 절차를 논의했다. 기술의 변화는 흥미롭지만 조심스럽기도 하다.`;
const before = `연구실에서 관측 기록을 함께 검토했다.\n\n이런 경험을 통해 나는 관측 장비의 기록을 꾸준히 살펴볼 필요가 있다고 생각하게 됐다. 다음 회의에서는 조사 절차를 논의했다.\n\n${generated}`;
const candidate = before.replace('이런 경험을 통해 나는 관측 장비의 기록을 꾸준히 살펴볼 필요가 있다고 생각하게 됐다.', owned);
const audit = (current, next) => auditCandidateIntegrity({ source, before: current, candidate: next });
const korean = outputText => analyzeKoreanRefinement({ source, outputText });

test('exact source restoration cannot make an unchanged baseline opener a new integrity regression', () => {
  assert.equal(korean(before).weightedRisk, 0, 'one occurrence is below the existing notice threshold');
  const warning = korean(candidate).issues.find(v => v.code === 'repeated_vague_demonstrative');
  assert.equal(warning.afterCount, 2);
  assert.equal(warning.introducedCount, 1, 'document notice stays truthful; no blanket suppression');
  assert.equal(audit(before, candidate).reasons.includes('korean_integrity_worsened'), false);
});

test('source restoration plus new vague wording still fails relative integrity', () => {
  const changed = candidate.replace(generated, '이런 변화가 흥미로워서 다음 실험도 기대하고 있다.');
  assert.equal(audit(before, changed).reasons.includes('korean_integrity_worsened'), true);
});

test('extra copies of a baseline or source-owned opener remain regressions', () => {
  for (const extra of [generated, owned]) {
    assert.equal(audit(before, candidate + '\n\n' + extra).reasons.includes('korean_integrity_worsened'), true);
  }
});

test('one newly generated opener is not excused when an owned opener activates repetition', () => {
  const current = before.replace(generated, '기술 변화는 조심스럽게 지켜보고 있다.');
  assert.equal(audit(current, candidate).reasons.includes('korean_integrity_worsened'), true);
});

test('another new Korean defect is not hidden by inherited threshold activation', () => {
  const broken = candidate.replace('관측 기록을 함께 검토했다.', '관측 기록을 함께 검토했다했다.');
  assert.equal(audit(before, broken).pass, false);
});

test('an owned sentence already in prose cannot be duplicated as a new paragraph opener', () => {
  const current = candidate.replace('\n\n' + owned, ' ' + owned);
  const duplicated = current + '\n\n' + owned;
  assert.equal(audit(current, duplicated).reasons.includes('source_sentence_copy_added'), true);
  assert.equal(audit(current, duplicated).pass, false);
});
