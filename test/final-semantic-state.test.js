'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const outcome = require('../engine-gpt-prod/finalSemanticOutcome');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const source = '합성 원문은 관찰 결과를 기록한다.';
const candidate = '합성 원문은 관찰한 결과를 적는다.';
const verify = report => provenance.verifySemanticValidation(report, { source, candidate, requireDigest: true });
const bound = fields => provenance.bindSemanticValidation({ ran: true, ...fields }, source, candidate);

test('unknown/not_needed is unconfirmed, never a completed pass', () => {
  const report = { ran: true, pass: true, judgeCallCount: 9 };
  const validation = verify(report);
  assert.equal(validation.status, 'unknown');
  assert.equal(outcome.finalSemanticState(report, validation), 'unconfirmed');
  assert.equal(outcome.needsFinalSemanticAudit({ report, priorStatus: validation.status }), true);
  assert.equal(report.validation, undefined, 'state projection does not manufacture provenance');
});

test('exact final states distinguish pass, failed verdict, uncertainty, incomplete and stale', () => {
  for (const [fields, expected] of [
    [{ pass: true }, 'verified_pass'],
    [{ pass: false }, 'verified_fail'],
    [{ pass: false, uncertain: true }, 'uncertain'],
    [{ pass: true, verificationCompleted: false }, 'incomplete']
  ]) {
    const report = bound(fields);
    assert.equal(outcome.finalSemanticState(report, verify(report)), expected);
  }
  const stale = provenance.bindSemanticValidation({ ran: true, pass: true }, source, '다른 합성 후보이다.');
  assert.equal(outcome.finalSemanticState(stale, verify(stale)), 'stale');
  const pass = bound({ pass: true });
  assert.equal(outcome.finalSemanticState(pass, verify(pass), { confirmationPending: true }), 'confirmation_pending');
  assert.equal(outcome.finalSemanticState({ ran: false, pass: true }, { status: 'pass' }), 'not_run');
  assert.equal(outcome.finalSemanticState(null, null), 'not_run');
});

test('audit eligibility preserves no-verdict-shopping and does not admit jobs that skipped audit', () => {
  const report = { ran: true };
  for (const priorStatus of ['pass', 'fail', 'uncertain', 'skipped']) {
    assert.equal(outcome.needsFinalSemanticAudit({ report, priorStatus }), false);
  }
  for (const priorStatus of ['stale', 'unknown']) {
    assert.equal(outcome.needsFinalSemanticAudit({ report, priorStatus }), true);
  }
  for (const report of [undefined, { ran: false }, { ran: true, skipped: true }]) {
    assert.equal(outcome.needsFinalSemanticAudit({ report, priorStatus: 'unknown' }), false);
  }
  assert.equal(outcome.needsFinalSemanticAudit({ report, priorStatus: 'fail', preparedRestore: true }), true);
  assert.equal(outcome.needsFinalSemanticAudit({ report, priorStatus: 'pass', needsObligationReview: true }), true);
});

test('incomplete final supersedes prior pass while an exact verified fallback is classified separately', () => {
  const pass = bound({ pass: true });
  const incomplete = outcome.retainIncompleteFinalAudit(pass, bound({ pass: false, verificationCompleted: false,
    progress: { expectedSections: 1, completedSections: 0 }, reports: [] }));
  assert.equal(outcome.finalSemanticState(incomplete, verify(incomplete)), 'incomplete');
  assert.equal(outcome.finalSemanticState(pass, verify(pass)), 'verified_pass');
  assert.equal(incomplete.progress.completedSections, 0);
});
