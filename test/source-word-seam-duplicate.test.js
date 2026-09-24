'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { removeGeneratedLocalOverlapDuplicates: repair, auditGeneratedDuplicateIntegrity: audit } = require('../engine/dedupe');
const source = '측정 조건을 일정하게 유지하였다.[2] 보편\n\n적인 현상은 같은 조건에서 관찰된다.';
const result = '측정 조건은 일정하게 유지하였다.[2] 보편\n\n보편적인 현상은 같은 조건에서 관찰된다.';

test('source-proven PDF word seam prefix is removed while paragraph boundary stays', () => {
  const fixed = repair(source, result);
  assert.equal(fixed.removedCount, 1);
  assert.ok(fixed.reasons.includes('source_proven_word_seam_prefix'));
  assert.match(fixed.text, /\[2\]\s*\n\n보편적인/u);
  assert.equal(audit(source, result).pass, false);
  assert.equal(audit(source, fixed.text).pass, true);
  assert.equal(repair(source, fixed.text).applied, false);
});

test('no source seam, headings and deliberate repetitions cannot authorize prefix deletion', () => {
  assert.equal(repair(source.replace('보편\n\n적인', '보편적인'), result).applied, false);
  const heading = '보편\n\n보편적인 현상은 같은 조건에서 관찰된다.';
  assert.equal(repair(heading, heading).applied, false);
  assert.equal(repair(result, result).applied, false);
});

test('quoted and fenced broken words remain protected', () => {
  for (const wrap of [x => `“${x}”`, x => `\`\`\`text\n${x}\n\`\`\``]) {
    assert.equal(repair(wrap(source), wrap(result)).applied, false);
  }
});

test('the production final dedupe acceptance gate keeps the source-proven repair', () => {
  const fixed = require('../engine-gpt-prod').applyFinalGeneratedDedupe({
    source, outputText: result, documentProfile: { profile: 'report_assignment' }, mode: 'assignment'
  });
  assert.equal(fixed.applied, true);
  assert.equal(fixed.rejected, false);
  assert.equal(fixed.removedLocalOverlapCount, 1);
});
