'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');
const { finalSemanticDeadline } = require('../engine-gpt-prod/finalSemanticDeadline');
const literals = require('../engine-gpt-prod/literalSpans');

// F-01: the reserve follows the final verdict schedule (one 270s section limit
// per expected wave). A second wave starts above 18,000 characters, so the
// growth this test observes moved from the old 6,000 boundary to that one.
test('materialized candidate growth reserves the long audit even when frozen tokens stay short', () => {
  const source = '가'.repeat(17900);
  const materialized = '가'.repeat(17700) + '`' + 'code'.repeat(99) + 'xx`';
  assert.equal(materialized.length, 18100);
  const frozen = literals.freezeInlineCode(materialized);
  assert.ok(frozen.text.length < 18000);
  let current = source;
  const budget = createRecoveryBudget(1, { clock: () => 1, jobDeadlineMs: 660000,
    finalAuditReserveMs: finalSemanticDeadline({ source }).limitMs,
    getFinalAuditReserveMs: () => finalSemanticDeadline({ source,
      candidate: literals.restoreInlineCode(current, frozen).text }).limitMs });
  assert.equal(budget.snapshot().finalAuditReserveMs, 270000);
  current = frozen.text;
  assert.equal(budget.reserveCall(0.01, { priority: 'late' }), null);
  assert.equal(budget.snapshot().finalAuditReserveMs, 540000);
  assert.equal(budget.deadlineMs(), 120000);
  current = source;
  assert.equal(budget.snapshot().finalAuditReserveMs, 540000);
  assert.equal(budget.snapshot().attemptedCallCount, 0);
  const final = finalSemanticDeadline({ source, candidate: materialized,
    startedAt: 600000, jobDeadlineMs: 660000 });
  assert.equal(final.limitMs, 540000);
  assert.equal(final.deadlineMs, 660000, 'candidate growth cannot extend the job');
  assert.equal(final.postRepairDeadlineMs, 660000);
  assert.equal(final.verdictDeadlineMs(650000), 660000, 'the verdict clock cannot extend the job either');
});

test('index observes live chunks before merge and live materialized output before subsequent admissions', () => {
  const code = fs.readFileSync(require.resolve('../engine-gpt-prod'), 'utf8');
  const initial = code.indexOf('let readFinalAuditCandidate =');
  const budget = code.indexOf('const recoveryBudget = createRecoveryBudget', initial);
  const sectionRecovery = code.indexOf('sectionRecoveryReport = await', budget);
  const output = code.indexOf('let outputText =', sectionRecovery);
  const materializer = code.indexOf('const materializeExactLineCandidate =', output);
  const switchReader = code.indexOf('readFinalAuditCandidate = () => materializeExactLineCandidate(outputText)', materializer);
  assert.ok(initial > 0 && initial < budget && budget < sectionRecovery && sectionRecovery < output);
  assert.ok(output < materializer && materializer < switchReader);
  assert.match(code.slice(initial, budget), /structureChunk\.mergeChunks\(chunks\)/);
  assert.match(code.slice(initial, budget), /restoreMath/);
  assert.match(code.slice(initial, budget), /restoreInlineCode/);
  assert.doesNotMatch(code.slice(initial, budget), /outputText|frozen\./, 'initial getter must not read TDZ variables');
  assert.match(code.slice(budget, sectionRecovery), /getFinalAuditReserveMs:[\s\S]*candidate: readFinalAuditCandidate\(\)/);
  assert.ok(switchReader < code.indexOf('recoveryBudget.tryStart(', switchReader));
});
