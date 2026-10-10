'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
const gate = require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const { confirmedOmissions, explainConfirmedOmissions: explain, sanitizeOmissionGateDiagnostics: sanitize } = gate;
const history = require('../lib/historyService');

// F-03. Synthetic sentences only. The gate's conditions are unchanged; these
// tests pin that the new record agrees with the gate and holds no quotation.
const A = '측정 결과를 직접 정리하는 일에 익숙하다.';
const B = '연구 모임에서 자료를 모으고 발표했다.';
const C = '남은 기간에는 실험 절차를 다시 점검했다.';
const source = `${A} ${B} ${C}`;
const candidate = '연구 모임에서 자료를 수집하고 발표를 맡았다. 남은 기간에는 실험 절차를 다시 점검했다.';
const finding = (overrides = {}) => ({ type: 'omission', origin: 'introduced', repairable: true, relationGrounded: true,
  grounding: 'unique_exact_span', sourceSpanVerified: true, sourceSpan: A, candidateSpan: candidate.split('. ')[0] + '.', ...overrides });
const failed = (violations, extra = {}) => ({ ran: true, pass: false, verificationCompleted: true, violations, ...extra });
const final = (violations = [finding()], extra = {}, text = candidate) => bindSemanticValidation(failed(violations, extra), source, text);
const prior = (violations = [finding()], extra = {}) => failed(violations, extra);
const hasHangul = value => /[ㄱ-ㆎ가-힣]/u.test(JSON.stringify(value));

test('the record agrees with the gate in every state and never changes it', () => {
  const reports = [
    final(), { ...final(), uncertain: true }, { ...final(), verificationCompleted: false }, { ...final(), nominationOnly: true },
    final([finding({ type: 'addition' })]), final([finding({ origin: 'source_issue' })]), final([finding({ repairable: false })]),
    final([finding(), finding({ sourceSpan: B })]), final([]), bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true,
      violations: [] }, source, candidate), final([finding()], {}, candidate + ' 덧붙인 문장이다.'), null, { ran: false }
  ];
  const priors = [[], [prior()], [prior([finding()], { uncertain: true })], [prior([finding()], { verificationCompleted: false })],
    [prior([finding({ sourceSpan: B })])], [{ reports: [prior()] }], [prior([finding({ origin: 'unconfirmed' })])]];
  let fired = 0;
  for (const report of reports) for (const list of priors) {
    const before = JSON.stringify([report, list]);
    const expected = report ? confirmedOmissions(source, candidate, report, list).length : 0;
    const record = explain(source, candidate, report, list);
    assert.equal(record.confirmedCount, expected);
    assert.equal(record.state === 'evaluated' ? record.conditionsMetCount : 0, expected);
    assert.equal(JSON.stringify([report, list]), before, 'observation does not mutate reports');
    assert.equal(hasHangul(record), false, 'no quotation in the record');
    fired += expected;
  }
  assert.ok(fired > 0, 'the matrix includes cases where the gate fires');
});

test('each state is distinguishable, the timed-out final verdict in particular', () => {
  const state = (report, priors = [prior()]) => explain(source, candidate, report, priors).state;
  assert.equal(state(final()), 'evaluated');
  assert.equal(state(null), 'no_final_verdict');
  assert.equal(state({ ran: false }), 'no_final_verdict');
  assert.equal(state(final([finding()], {}, candidate + ' 덧붙인 문장이다.')), 'final_verdict_stale');
  assert.equal(state({ ...final(), uncertain: true }), 'final_verdict_uncertain');
  assert.equal(state({ ...final(), nominationOnly: true }), 'nomination_only');
  assert.equal(state(bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true, violations: [] }, source, candidate)),
    'final_verdict_pass');
  // What F-01 produced: a final audit cut by time keeps its completed
  // sections' findings but is not a completed verdict.
  const cut = bindSemanticValidation({ ran: true, pass: false, uncertain: true, verificationCompleted: false,
    decisionReason: 'final_semantic_revalidation_incomplete', violations: [finding()] }, source, candidate);
  const record = explain(source, candidate, cut, [prior()]);
  assert.equal(record.state, 'final_verification_incomplete');
  assert.equal(record.finalVerificationCompleted, false);
  assert.equal(record.finalStatus, 'uncertain');
  assert.equal(record.conditionsMetCount, 1, 'the finding met every per-finding condition');
  assert.equal(record.confirmedCount, 0, 'but the gate did not decide on an incomplete verdict');
  assert.equal(confirmedOmissions(source, candidate, cut, [prior()]).length, 0);
});

test('every per-finding condition is counted on its own and by first failure', () => {
  const twice = `${A} ${B} ${A}`;
  const cases = [
    ['not_introduced', source, candidate, finding({ origin: 'unconfirmed' }), [prior()]],
    ['not_grounded', source, candidate, finding({ relationGrounded: false }), [prior()]],
    ['source_span_not_unique', twice, candidate, finding(), [prior()]],
    ['candidate_span_not_unique', source, candidate, finding({ candidateSpan: '다.' }), [prior()]],
    ['source_span_still_present', source, `${candidate} ${A}`, finding(), [prior()]],
    ['no_prior_same_span', source, candidate, finding(), []]
  ];
  for (const [code, src, out, violation, priors] of cases) {
    const report = bindSemanticValidation(failed([violation]), src, out);
    const record = explain(src, out, report, priors);
    assert.equal(record.state, 'evaluated', code);
    assert.equal(record.omissionCount, 1);
    assert.equal(record.conditionFailedCounts[code], 1, code);
    assert.equal(record.firstFailedCounts[code], 1, code);
    assert.equal(record.rows[0].firstFailedCondition, code);
    assert.equal(record.confirmedCount, 0);
    assert.equal(confirmedOmissions(src, out, report, priors).length, 0);
  }
  const ok = explain(source, candidate, final(), [prior()]);
  assert.deepEqual(Object.values(ok.conditionFailedCounts), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([ok.conditionsMetCount, ok.confirmedCount, ok.priorOverlapCounts.exact], [1, 1, 1]);
  assert.deepEqual(ok.rows[0], { sourceSpanChars: A.replace(/\s/gu, '').length,
    candidateSpanChars: finding().candidateSpan.replace(/\s/gu, '').length, sourceSpanDigest: ok.rows[0].sourceSpanDigest,
    introduced: true, grounded: true, sourceUnique: true, candidateUnique: true, absentFromCandidate: true, priorSameSpan: true,
    priorOverlapOfShorter: 1, priorOverlapOfLonger: 1, nearestPriorChars: A.replace(/\s/gu, '').length, firstFailedCondition: '' });
  assert.match(ok.rows[0].sourceSpanDigest, /^[0-9a-f]{12}$/u);
});

test('an earlier finding that quoted nearly the same passage is counted, not accepted', () => {
  // The earlier judge quoted the sentence without its final word; the later
  // judge quoted the whole sentence. Not the same string, so the gate stays shut.
  const shorter = A.slice(0, A.length - 5);
  const near = explain(source, candidate, final(), [prior([finding({ sourceSpan: shorter })])]);
  assert.equal(near.confirmedCount, 0);
  assert.equal(confirmedOmissions(source, candidate, final(), [prior([finding({ sourceSpan: shorter })])]).length, 0);
  assert.deepEqual(near.onlyPriorMissing, { count: 1, high: 1, partial: 0, low: 0 });
  assert.equal(near.priorOverlapCounts.high, 1);
  assert.equal(near.rows[0].priorSameSpan, false);
  assert.equal(near.rows[0].priorOverlapOfShorter, 1);
  assert.ok(near.rows[0].priorOverlapOfLonger > 0.6 && near.rows[0].priorOverlapOfLonger < 1);
  // A window that straddles two sentences overlaps only in part.
  const straddling = `${A.slice(8)} ${B.slice(0, 12)}`;
  const partial = explain(source, candidate, final(), [prior([finding({ sourceSpan: straddling })])]);
  assert.equal(partial.onlyPriorMissing.count, 1);
  assert.equal(partial.onlyPriorMissing.partial + partial.onlyPriorMissing.high, 1);
  assert.ok(partial.rows[0].priorOverlapOfShorter >= 0.5);
  // An unrelated earlier omission is far.
  const far = explain(source, candidate, final(), [prior([finding({ sourceSpan: C })])]);
  assert.deepEqual(far.onlyPriorMissing, { count: 1, high: 0, partial: 0, low: 1 });
  // Earlier findings the gate does not accept as independent evidence are counted too.
  const weak = explain(source, candidate, final(), [prior([finding()], { uncertain: true })]);
  assert.deepEqual([weak.priorReportCount, weak.priorQualifiedReportCount, weak.priorOmissionFindingCount,
    weak.priorOmissionUnqualifiedCount, weak.priorOmissionSpanCount], [1, 0, 1, 1, 0]);
});

test('rows are bounded and the stored projection keeps codes and numbers only', () => {
  const many = Array.from({ length: 20 }, () => finding());
  const record = explain(source, candidate, final(many), [prior()]);
  assert.equal(record.omissionCount, 20);
  assert.equal(record.rows.length, 12);
  assert.equal(record.overflowRowCount, 8);
  const dirty = { ...record, note: '합성 문장', sourceSpan: A, rows: record.rows.map(row => ({ ...row, sourceSpan: A, detail: '합성 문장',
    sourceSpanDigest: row.sourceSpanDigest, firstFailedCondition: '합성 문장' })) };
  const clean = sanitize(dirty);
  assert.equal(hasHangul(clean), false);
  assert.deepEqual(Object.keys(clean.rows[0]).sort(), ['absentFromCandidate', 'candidateSpanChars', 'candidateUnique',
    'firstFailedCondition', 'grounded', 'introduced', 'nearestPriorChars', 'priorOverlapOfLonger', 'priorOverlapOfShorter',
    'priorSameSpan', 'sourceSpanChars', 'sourceSpanDigest', 'sourceUnique']);
  assert.deepEqual(sanitize(clean), clean, 'the projection is stable');
  assert.equal(sanitize(null), null);
  assert.equal(sanitize({ ...record, version: 'other' }), null);
  assert.equal(sanitize({ ...record, state: '합성' }), null);
  assert.equal(sanitize({ ...record, rows: [{ sourceSpanDigest: 'not-hex', priorOverlapOfShorter: 7 }] }).rows[0].sourceSpanDigest, '');
  assert.equal(sanitize({ ...record, rows: [{ priorOverlapOfShorter: 7 }] }).rows[0].priorOverlapOfShorter, 1);
});

test('history keeps the record and leaves older results without one', () => {
  const record = explain(source, candidate, final(), [prior()]);
  const stored = history.compactHistoryEngineMeta({ confirmedOmissionGate: record, httpAttemptCount: 3 });
  assert.equal(stored.confirmedOmissionGate.state, 'evaluated');
  assert.equal(stored.confirmedOmissionGate.confirmedCount, 1);
  assert.equal(stored.confirmedOmissionGate.rows.length, 1);
  assert.equal(hasHangul(stored.confirmedOmissionGate), false);
  assert.equal(Object.hasOwn(history.compactHistoryEngineMeta({}), 'confirmedOmissionGate'), false);
  assert.equal(Object.hasOwn(history.compactHistoryEngineMeta({ confirmedOmissionGate: { state: 'evaluated' } }),
    'confirmedOmissionGate'), false);
});

test('the engine records the gate beside the unchanged decision (source check)', () => {
  const code = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod'), 'utf8');
  const decision = code.indexOf("const confirmedMissingClaims = require('./confirmedDeliveryIntegrity').confirmedOmissions(");
  const record = code.indexOf("confirmedOmissionGate = require('./confirmedDeliveryIntegrity').explainConfirmedOmissions(");
  // The record is taken just above the decision and is not one of its inputs.
  assert.ok(record > 0 && decision > record && decision - record < 400);
  assert.match(code.slice(decision, decision + 400),
    /semanticRestorationEvidence\);\r?\n\s+if \(confirmedMissingClaims\.length\) addFloorCriticals/u);
  assert.equal(/confirmedOmissionGate[^\n]*addFloorCriticals|addFloorCriticals[^\n]*confirmedOmissionGate/u.test(code), false);
  assert.match(code, /\n\s+confirmedOmissionGate,\r?\n/u);
  // The gate itself is byte-for-byte the function shipped in v2.5.106.
  const gateCode = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod/confirmedDeliveryIntegrity'), 'utf8')
    .replace(/\r\n/gu, '\n');
  assert.ok(gateCode.includes(`  return (report.violations||[]).filter(v=>v.type==='omission' && v.origin==='introduced'
    && hasGroundedSpan(v) && unique(source,v.sourceSpan) && unique(candidate,v.candidateSpan)
    && !candidateBare.includes(bare(v.sourceSpan)) && previous.has(bare(v.sourceSpan)));`));
});
