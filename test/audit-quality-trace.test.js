'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const trace = require('../engine-gpt-prod/auditTrace');
const provenance = require('../engine-gpt-prod/semanticProvenance');

test('normalization trace addresses raw UTF-16 text without copying its content', () => {
  const raw = '😀 자료를\n정리했다.\n\n다음 항목', normalized = raw.replace('를\n', '를 ');
  const summary = trace.sourceNormalization(raw, normalized, raw);
  assert.equal(summary.submittedDigest, provenance.textDigest(raw));
  assert.equal(summary.normalizedDigest, provenance.textDigest(normalized));
  assert.equal(raw.slice(summary.changeRange.sourceStart, summary.changeRange.sourceEnd), '\n');
  assert.equal(normalized.slice(summary.changeRange.normalizedStart, summary.changeRange.normalizedEnd), ' ');
  assert.ok(!JSON.stringify(summary).includes('자료'));
});

test('final receipt proves allowed layout materialization and distinguishes stale edits', () => {
  const source = '자료를 확인했다. 결과를 기록했다.';
  const report = provenance.bindSemanticValidation({ ran: true, pass: true }, source, source);
  const final = source.replace(' 결과', '\n\n결과');
  const receipt = trace.finalValidationReceipt(report, source, final);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.materialization, 'whitespace_layout');
  assert.equal(receipt.validatedCandidateDigest, provenance.textDigest(source));
  assert.equal(receipt.finalCandidateDigest, provenance.textDigest(final));
  assert.equal(trace.finalValidationReceipt(report, source, final + ' 추가했다.').status, 'stale');
});

test('trace compaction is bounded, idempotent and leaves legacy absence unknown', () => {
  const privateText = 'private text must never appear';
  const meta = { candidateLedgerEnabled: true, candidateLedgerRollbackApplied: true,
    candidateLedgerSelectedStage: 'safe_checkpoint', candidateLedgerSelectionReason: 'semantic_audit_pass',
    candidateLedgerSelectedDigest: 'a'.repeat(64), candidateLedgerCheckpointCount: 5,
    candidateLedger: { checkpoints: [{ text: privateText }] },
    finalValidationReceipt: { version: 'final-validation-summary-v1', status: 'pass', sourceDigest: privateText, text: privateText },
    sourceNormalization: { ...trace.sourceNormalization('a', 'b', 'a'), text: privateText } };
  const clean = trace.compactAuditTrace(meta);
  assert.equal(clean.candidateLedgerRollbackApplied, true);
  assert.equal(clean.candidateLedgerSelectedDigest, 'a'.repeat(64));
  assert.ok(!JSON.stringify(clean).includes(privateText));
  assert.equal(clean.finalValidationReceipt, undefined, 'a malformed receipt cannot create a pass');
  assert.deepEqual(trace.compactAuditTrace(JSON.parse(JSON.stringify(clean))), clean);
  assert.deepEqual(trace.compactAuditTrace({}), {});
});
