'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const canonicalAudit = require('../engine-gpt-prod/semanticCanonicalAudit');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { restoreConfirmedRelations } = require('../engine-gpt-prod/confirmedRelationRestore');

const heading = '## 합성 관측 장비의 점검 기록과 보관 절차';
const token = 'ZXQLOCK0000QXZ';
const a = '동쪽 관측소에서는 기온이 낮아 내부 배관이 얼었다는 점을 확인했다.';
const b = '동쪽 관측소에서는 기온이 낮고 내부 배관이 얼었다는 점을 확인했다.';
const tail = Array.from({ length: 16 }, (_, i) => `별도 자료 ${i + 1}번의 측정값은 다른 기록과 혼동하지 않도록 보관했다.`).join(' ');
const source = heading + '\n\n' + a + ' ' + tail;
const candidate = heading + '\n\n' + b + ' ' + tail;
const frozenSource = source.replace(heading, token), frozenCandidate = candidate.replace(heading, token);
const canonical = canonicalAudit.createCanonicalAudit({ rawSource: source, frozenSource,
  lockedBlocks: [{ token, value: heading }] });
const grounded = groundViolation({ type: 'distortion', origin: 'introduced', relation: 'other',
  sourceSpan: a, candidateSpan: b, span: b }, source, candidate);
const bound = (text, values) => provenance.bindSemanticValidation({ ran: true, verificationCompleted: true,
  pass: false, uncertain: false, outputText: text, ...values }, source, text, { now: () => 0 });

test('canonical evidence keeps raw coordinates and digest parents; restoration relocates exact spans', () => {
  assert.equal(canonical.ok, true);
  const report = bound(candidate, { violations: [grounded], initialViolations: [grounded] });
  const view = canonicalAudit.frozenView(report, { canonical, frozenCandidate, canonicalCandidate: candidate });
  assert.equal(view.validation.parentSourceDigest, provenance.textDigest(source));
  assert.equal(view.validation.parentCandidateDigest, provenance.textDigest(candidate));
  assert.equal(view.validation.candidateDigest, provenance.textDigest(frozenCandidate));
  assert.equal(view.canonicalAudit.coordinateSpace, 'canonical_raw');
  assert.deepEqual(view.violations[0].candidateRange, grounded.candidateRange);
  assert.notEqual(frozenCandidate.slice(grounded.candidateRange.start, grounded.candidateRange.end), b);
  const raw = canonical.materialize(view.outputText).text;
  // Deliberately stale section-relative offsets are diagnostic, not authority.
  const shifted = { ...view, violations: [{ ...grounded, candidateRange: { start: 0, end: b.length },
    sourceRange: { start: 0, end: a.length } }], initialViolations: [] };
  const proposal = restoreConfirmedRelations(source, raw, shifted);
  assert.equal(proposal.text, source);
  assert.equal(proposal.restoredCount, 1);
  assert.equal(proposal.pass, undefined);
});

test('failed canonical repair keeps both finding generations without using rejected offsets', () => {
  const rejected = candidate.replace(heading, heading + ' 변경').replace(b, b.replace('확인했다', '기록했다'));
  const residual = groundViolation({ ...grounded, candidateSpan: b.replace('확인했다', '기록했다'),
    span: b.replace('확인했다', '기록했다') }, source, rejected);
  const view = canonicalAudit.frozenView(bound(rejected, { initialViolations: [grounded], violations: [residual] }),
    { canonical, frozenCandidate, canonicalCandidate: candidate });
  assert.equal(view.pass, false);
  assert.equal(view.outputText, frozenCandidate);
  assert.equal(view.validation, undefined);
  assert.equal(view.canonicalAudit.frozenViewExact, false);
  assert.deepEqual(view.violations, [grounded, residual]);
  const proposal = restoreConfirmedRelations(source, canonical.materialize(view.outputText).text, view);
  assert.equal(proposal.restoredCount, 1, 'only the unchanged initial pair still belongs to the adopted candidate');
  assert.equal(proposal.text, source);
  assert.equal(proposal.pass, undefined);
});

test('raw/frozen provenance mismatch never certifies or drops initial and residual evidence', () => {
  const wrongBinding = provenance.bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true,
    outputText: candidate, initialViolations: [grounded], violations: [{ ...grounded, relation: 'condition_result' }] },
    frozenSource, frozenCandidate);
  const view = canonicalAudit.frozenView(wrongBinding, { canonical, frozenCandidate, canonicalCandidate: candidate });
  assert.equal(view.pass, false);
  assert.equal(view.reason, 'canonical_provenance_mismatch');
  assert.equal(view.violations.length, 2);
  assert.equal(view.validation, undefined);
});
