'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeterministicAudit, STRICT_CODES, SEMANTIC_WARNING_TYPES } = require('../engine-gpt-prod/finalQualityV2');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');
const { buildStructureAudit } = require('../engine-gpt-prod/structureChunk');
const delivery = require('../lib/humanizeDeliveryPolicy');

function quality(source, outputText, structureAudit) {
  return buildDeterministicAudit({ source, outputText, mode: 'blog',
    documentProfile: 'general', voiceProfile: buildVoiceProfile(source, { documentProfile: 'general', mode: 'blog' }),
    structureAudit });
}

test('retained headings cannot hide a new orphan ending from final review delivery', () => {
  const source = '[결론]\n\n측정한 결과를 조건별로 자세히 기록했습니다.';
  const outputText = source + '\n\n다.';
  const structure = buildStructureAudit({ source, outputText, chunks: [] });
  assert.equal(structure.fragmentIntegrityPass, false);
  const audit = quality(source, outputText, structure);
  const warnings = audit.warnings.filter(item => item.code === 'introduced_orphan_ending');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'warning');
  assert.equal(warnings[0].count, 1);
  const outcome = delivery.applyDeliveryPolicy({ status: 'clean', criticals: [], warnings }, { mode: 'blog' });
  assert.equal(outcome.report.status, 'needs_review');
  assert.equal(outcome.decision, 'deliver_review');
  assert.deepEqual(outcome.report.criticals, []);
  assert.equal(delivery.reconcileFinalDelivery({ qualityWarnings: warnings }).decision, 'deliver_review');
});

test('duplicate-tail warnings are bounded, private-evidence free and never technical blocks', () => {
  const source = '실험 참가자에게 검사 방법을 충분히 설명했습니다.';
  const audit = quality(source, source, { fragmentIntegrityPass: false, fragmentIntegrityIssueCount: Infinity,
    fragmentIntegrityCodes: ['introduced_duplicate_predicate_tail', 'introduced_duplicate_predicate_tail', source, 'bad_private_value'],
    fragmentIntegrityIssues: [{ outputStart: 123, text: source }] });
  const warnings = audit.warnings.filter(item => item.code.startsWith('introduced_'));
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(warnings[0]).sort(), ['code', 'count', 'message', 'severity']);
  assert.equal(warnings[0].count, 1);
  assert.equal(JSON.stringify(warnings).includes(source), false);
  for (const warning of warnings) {
    assert.equal(STRICT_CODES.has(warning.code), false);
    assert.equal(delivery.isTechnicalCritical(warning), false);
    assert.equal(delivery.isEffectOnly(warning), false);
    assert.equal(SEMANTIC_WARNING_TYPES.has(warning.code), false, 'the warning alone must not add paid calls');
  }
});

test('missing old audit data and passing audits do not create a fragment warning', () => {
  const source = '실험 참가자에게 검사 방법을 충분히 설명했습니다.';
  for (const structure of [{}, { fragmentIntegrityPass: true, fragmentIntegrityCodes: ['introduced_orphan_ending'] }]) {
    assert.equal(quality(source, source, structure).warnings.some(item => /fragment|orphan_ending|predicate_tail/u.test(item.code)), false);
  }
});

test('an explicitly failed audit with missing codes still receives a nonblocking review reason', () => {
  const source = '실험 참가자에게 검사 방법을 충분히 설명했습니다.';
  const warnings = quality(source, source, { fragmentIntegrityPass: false }).warnings.filter(item => item.code === 'fragment_boundary_review');
  assert.equal(warnings.length, 1);
  assert.equal(delivery.isTechnicalCritical(warnings[0]), false);
  assert.equal(delivery.reconcileFinalDelivery({ qualityWarnings: warnings }).decision, 'deliver_review');
});
