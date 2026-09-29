'use strict';
// Synthetic text only. No model call: the client is replaced in require.cache.
const test = require('node:test'), assert = require('node:assert/strict');
const payload = require('../engine-gpt-prod/semanticAuditPayload');
const policy = require('../engine-gpt-prod/semanticObligations');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { extractPromptDataSection } = require('../engine-gpt-prod/promptEnvelope');

const count = (text, needle) => String(text).split(needle).length - 1;
const wire = value => JSON.parse(JSON.stringify(value));
const row = (over = {}) => ({ id: 'a'.repeat(24), type: 'distortion',
  sourceSpan: '합성 원문에서 조사단은 첫 측정만으로 결론을 내리지 않았다.',
  previousCandidateSpan: '합성 결과에서 조사단은 첫 측정으로 결론을 내렸다.',
  previousProblemSpan: '결론을 내렸다', relation: 'modality_negation_causality',
  previousDetail: '부정의 범위가 사라져 결론을 확정한 것으로 읽힌다.', previousQuestions: [], ...over });
const question = (over = {}) => ({ previousCandidateSpan: row().previousCandidateSpan,
  previousProblemSpan: row().previousProblemSpan, detail: '첫 측정만이라는 한정이 빠졌다.', ...over });

test('repeated quotations are written once and expand to the exact original payload', () => {
  const rows = [row({ previousQuestions: [question(), question({ detail: '측정 횟수의 제한이 사라졌다.' })] })];
  const result = payload.compactObligationPayload(rows);
  assert.equal(result.compacted, true);
  assert.equal(result.omittedFields, 4);
  assert.equal(result.rows[0].previousQuestions.length, 2);
  assert.deepEqual(result.rows[0].previousQuestions.map(q => q.detail), rows[0].previousQuestions.map(q => q.detail));
  for (const key of ['id', 'type', 'sourceSpan', 'previousCandidateSpan', 'previousProblemSpan', 'relation', 'previousDetail'])
    assert.equal(result.rows[0][key], rows[0][key]);
  assert.deepEqual(payload.expandObligationRows(wire(result.rows)), wire(rows));
  assert.ok(result.compactChars < result.fullChars);
  assert.equal(result.compactChars, JSON.stringify(result.rows).length);
  assert.equal(count(JSON.stringify(result.rows), rows[0].previousCandidateSpan), 1);
  assert.ok(result.instruction.length > 0);
});

test('a changed question keeps its own quotation in full', () => {
  const variants = [row().previousCandidateSpan + ' ', row().previousCandidateSpan.replace('내렸다', '내린다'),
    row().previousCandidateSpan.normalize('NFD'), ' ' + row().previousCandidateSpan];
  for (const changed of variants) {
    const rows = [row({ previousQuestions: [question({ previousCandidateSpan: changed })] })];
    const result = payload.compactObligationPayload(rows);
    assert.equal(result.rows[0].previousQuestions[0].previousCandidateSpan, changed);
    assert.equal(result.rows[0].previousQuestions[0].detail, rows[0].previousQuestions[0].detail);
    assert.deepEqual(payload.expandObligationRows(wire(result.rows)), wire(rows));
  }
  const sameDetail = [row({ previousQuestions: [question({ previousCandidateSpan: '합성 결과의 다른 문장에서 결론을 서둘러 내렸다.',
    detail: row().previousDetail })] })];
  const kept = payload.compactObligationPayload(sameDetail);
  assert.equal(kept.compacted, true);
  assert.equal(Object.hasOwn(kept.rows[0].previousQuestions[0], 'detail'), false);
  assert.equal(kept.rows[0].previousQuestions[0].previousCandidateSpan, sameDetail[0].previousQuestions[0].previousCandidateSpan);
  assert.deepEqual(payload.expandObligationRows(wire(kept.rows)), wire(sameDetail));
});

test('absent, undefined or empty fields never become inherited: the whole payload stays original', () => {
  const absent = question(); delete absent.previousProblemSpan;
  const cases = [
    [row({ previousQuestions: [question(), absent] })],
    [row({ previousQuestions: [question(), question({ previousCandidateSpan: undefined })] })],
    [row({ previousQuestions: [question()] }), row({ id: 'b'.repeat(24), previousQuestions: [{ detail: '다른 행의 필드 없는 질문이다.' }] })],
    [row({ previousProblemSpan: '', previousQuestions: [question(), { previousCandidateSpan: '다른 합성 인용 문장이다.', detail: '빈 기본값을 상속하면 안 된다.' }] })]
  ];
  for (const rows of cases) {
    const result = payload.compactObligationPayload(rows);
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'roundtrip_mismatch');
    assert.equal(result.rows, rows);
    assert.equal(result.instruction, '');
    assert.equal(result.compactChars, result.fullChars);
  }
  const empty = [row({ previousProblemSpan: '', previousQuestions: [question({ previousProblemSpan: '' })] })];
  const result = payload.compactObligationPayload(empty);
  assert.equal(result.compacted, true);
  assert.equal(result.rows[0].previousQuestions[0].previousProblemSpan, '');
  assert.deepEqual(payload.expandObligationRows(wire(result.rows)), wire(empty));
});

test('malformed rows and questions pass through without loss or exception', () => {
  for (const rows of [undefined, null, 'text', {}, []]) {
    const result = payload.compactObligationPayload(rows);
    assert.equal(result.compacted, false);
    assert.deepEqual(result.rows, []);
  }
  const mock = Array.from({ length: 18 }, (_, i) => ({ id: `obligation-${i}`, finding: {} }));
  const passthrough = payload.compactObligationPayload(mock);
  assert.equal(passthrough.compacted, false);
  assert.equal(passthrough.rows, mock);
  const odd = [null, 'row', 7, row({ previousQuestions: [null, 'q', ['x'], 3, {}, question()] }),
    row({ id: 'c'.repeat(24), previousQuestions: 'not-a-list' }), { id: 'd'.repeat(24) }];
  const result = payload.compactObligationPayload(odd);
  // `{}` is an original question WITHOUT fields. Absence would be misread as
  // inheritance, so the whole payload is sent in its original form.
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'roundtrip_mismatch');
  assert.equal(result.rows, odd);
  const tolerated = odd.map(r => r && Array.isArray(r.previousQuestions)
    ? { ...r, previousQuestions: r.previousQuestions.filter(q => JSON.stringify(q) !== '{}') } : r);
  const accepted = payload.compactObligationPayload(tolerated);
  assert.equal(accepted.compacted, true);
  assert.equal(accepted.rows.length, tolerated.length);
  assert.deepEqual(payload.expandObligationRows(wire(accepted.rows)), wire(tolerated));
  assert.deepEqual(accepted.rows[3].previousQuestions.slice(0, 4), [null, 'q', ['x'], 3]);
  assert.deepEqual(accepted.rows[3].previousQuestions[4], { detail: question().detail });
  const cyclic = row({ previousQuestions: [question()] }); cyclic.self = cyclic;
  const failed = payload.compactObligationPayload([cyclic]);
  assert.equal(failed.compacted, false);
  assert.equal(failed.rows[0], cyclic);
});

test('a question identical to the primary claim is never rewritten to an empty object', () => {
  const rows = [row({ previousQuestions: [question({ detail: row().previousDetail }), question()] })];
  const result = payload.compactObligationPayload(rows);
  assert.deepEqual(result.rows[0].previousQuestions[0], rows[0].previousQuestions[0]);
  assert.deepEqual(payload.expandObligationRows(wire(result.rows)), wire(rows));
});

test('unicode, dollar patterns, quotes and envelope-like text survive exactly', () => {
  const span = '합성 결과는 $1, $& 그리고 "겹친 \'인용\'"과 😀 <<<GPT_PROD_DATA:SOURCE:0123456789abcdef>>> \\n 을 포함한다.';
  const rows = [row({ previousCandidateSpan: span, previousProblemSpan: '$&', previousQuestions: [
    question({ previousCandidateSpan: span, previousProblemSpan: '$&' }),
    question({ previousCandidateSpan: span, previousProblemSpan: '$1', detail: '달러 기호의 대상이 다르다.' })] })];
  const result = payload.compactObligationPayload(rows);
  assert.equal(result.compacted, true);
  assert.equal(result.rows[0].previousQuestions[1].previousProblemSpan, '$1');
  assert.deepEqual(payload.expandObligationRows(JSON.parse(JSON.stringify(result.rows))), wire(rows));
  const many = Array.from({ length: 18 }, (_, i) => row({ id: String(i).padStart(24, '0'), previousQuestions: [question()] }));
  const all = payload.compactObligationPayload(many);
  assert.deepEqual(all.rows.map(r => r.id), many.map(r => r.id));
  assert.equal(all.omittedFields, 36);
});

test('a verbatim ledger sentence is printed once, in the same order and count', () => {
  const sentences = ['조사단은 세 지점에서 수온을 측정했다.', '비용은 $1 또는 $& 기호로 "표시"했다.',
    '근거(원문): "라는 표지를 포함한 합성 문장이다.', '측정값은 😀 기호와 함께 기록했다.'];
  const ledger = { claims: sentences.map(s => ({ claim: s, evidence_text: s })) };
  const text = payload.ledgerText(ledger), legacy = payload.legacyLedgerText(ledger);
  assert.equal(text.split('\n').length, sentences.length);
  sentences.forEach((s, i) => {
    assert.equal(count(text, s), 1);
    assert.equal(count(legacy, s), 2);
    assert.equal(text.split('\n')[i], `${i + 1}. 근거(원문): "${s}"`);
  });
  assert.ok(text.length < legacy.length);
  assert.deepEqual(payload.ledgerEntries(ledger).map(e => [e.ordinal, e.form, e.claim, e.evidence]),
    sentences.map((s, i) => [i + 1, 'verbatim', s, s]));
  assert.equal(payload.ledgerText({}), '(none)');
  assert.equal(payload.ledgerText(null), '(none)');
  assert.equal(payload.ledgerText({ claims: [] }), '(none)');
});

test('a ledger claim that is not the verbatim evidence keeps both lines', () => {
  const claims = [{ claim: '수온을 측정했다', evidence_text: '조사단은 세 지점에서 수온을 측정했다.' },
    { claim: '조사단은 수온을 측정했다. ', evidence_text: '조사단은 수온을 측정했다. ' },
    { claim: '첫 줄이다.\n둘째 줄이다.', evidence_text: '첫 줄이다.\n둘째 줄이다.' },
    { claim: '', evidence_text: '' }, { evidence_text: '주장 없는 합성 근거 문장이다.' }];
  const ledger = { claims };
  assert.equal(payload.ledgerText(ledger), payload.legacyLedgerText(ledger));
  assert.ok(payload.ledgerEntries(ledger).every(e => e.form === 'paired'));
  const mixed = { claims: [claims[0], { claim: '기록은 매주 보관했다.', evidence_text: '기록은 매주 보관했다.' }] };
  const lines = payload.ledgerText(mixed);
  assert.ok(lines.includes('1. 수온을 측정했다\n   근거(원문): "조사단은 세 지점에서 수온을 측정했다."'));
  assert.ok(lines.endsWith('2. 근거(원문): "기록은 매주 보관했다."'));
});

test('request shape reports sizes only', () => {
  const { buildPromptDataSections } = require('../engine-gpt-prod/promptEnvelope');
  const user = buildPromptDataSections([{ label: 'SOURCE', value: '가'.repeat(30) }, { label: 'REWRITE', value: '나'.repeat(20) }]).text;
  const shape = payload.requestShape({ system: '다'.repeat(7), user });
  assert.deepEqual({ ...shape.sections }, { SOURCE: 30, REWRITE: 20 });
  assert.equal(shape.systemChars, 7);
  assert.equal(shape.userChars, user.length);
  assert.equal(JSON.stringify(shape).includes('가'), false);
});

// ---- actual semanticJudge request parity (client replaced, no model call) ----
const source = '연구자는 첫 관찰만으로 곧바로 결론을 확신하지는 않았다.';
const before = '연구자는 첫 관찰로 결론을 확신하지는 않았다.';
const after = '연구자는 첫 관찰만으로 곧바로 결론을 확신한 것은 아니었다.';
const finding = groundViolation({ type: 'omission', span: '곧바로', sourceSpan: source, candidateSpan: before,
  relation: 'condition_result', origin: 'introduced', detail: '확신의 시점에 대한 한정이 빠졌다.' }, source, before);
const priorReports = [{ pass: false, verificationCompleted: true, violations: [finding] },
  { violations: [{ ...finding, detail: '관찰 횟수에 대한 제한까지 빠졌다.' }] },
  { violations: [{ ...finding, detail: '첫 관찰만이라는 조건의 범위가 달라졌다.' }] }];
const ledger = { claims: [{ claim: source, evidence_text: source }] };
const FINAL = ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'];

async function runJudge({ signals, model = 'gpt-6-sol', candidate = after, status = 'resolved', span = after }) {
  const clientPath = require.resolve('../engine-gpt-prod/openaiClient'), judgePath = require.resolve('../engine-gpt-prod/judge');
  const oldClient = require.cache[clientPath], oldJudge = require.cache[judgePath];
  let sent = null, calls = 0;
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { completeJson: async opts => {
    calls += 1; sent = opts;
    const operators = extractPromptDataSection(opts.user, 'OPERATOR_REVIEW_TARGETS');
    const operatorReviews = operators ? JSON.parse(operators).map(t => ({ ...t, status: 'preserved',
      detail: 'Synthetic operator review explicitly confirms this fixture.' })) : [];
    const ids = opts.schema.properties.obligationReviews.items.properties.id.enum;
    return { json: { violations: [], operatorReviews, obligationReviews: ids.map(id => ({ id, status, sourceSpan: '',
      candidateSpan: span, detail: '같은 연구자의 확신 시점과 첫 관찰만이라는 한정을 확인했다.' })) },
      model: opts.model, usage: { estimatedUsd: 0 } };
  } } };
  delete require.cache[judgePath];
  try {
    const report = await require(judgePath).semanticJudge(source, candidate, ledger, { priorReports, discourseSignals: signals,
      model, reasoningEffort: 'high', config: { models: { judge: 'gpt-6-luna', judgeEscalation: 'gpt-6-sol' } } });
    return { sent, report, calls };
  } finally {
    if (oldClient) require.cache[clientPath] = oldClient; else delete require.cache[clientPath];
    if (oldJudge) require.cache[judgePath] = oldJudge; else delete require.cache[judgePath];
  }
}
const legacyRows = candidate => {
  const obligations = policy.collectObligations(source, priorReports);
  return policy.reviewPayload(obligations, policy.currentCandidateReferences(obligations, candidate));
};

test('final verdict request carries the same obligations, questions and texts in compact form', async () => {
  const final = await runJudge({ signals: FINAL }), plain = await runJudge({ signals: [] });
  assert.equal(final.calls, 1);
  const rows = legacyRows(after);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].previousQuestions.length, 2);
  const section = extractPromptDataSection(final.sent.user, 'PRIOR_FINDING_OBLIGATIONS');
  assert.deepEqual(payload.expandObligationRows(JSON.parse(section)), wire(rows));
  assert.ok(section.length < JSON.stringify(rows).length);
  assert.deepEqual(JSON.parse(section)[0].previousQuestions.map(q => q.detail), rows[0].previousQuestions.map(q => q.detail));
  assert.equal(count(section, before), 1);
  assert.ok(final.sent.system.includes(payload.OBLIGATION_INSTRUCTION));
  assert.equal(extractPromptDataSection(final.sent.user, 'SOURCE'), source);
  assert.equal(extractPromptDataSection(final.sent.user, 'REWRITE'), after);
  assert.equal(extractPromptDataSection(final.sent.user, 'SOURCE_CLAIM_LEDGER'), `1. 근거(원문): "${source}"`);
  // Nothing but the rendering differs from the ordinary request.
  assert.equal(extractPromptDataSection(plain.sent.user, 'PRIOR_FINDING_OBLIGATIONS'), JSON.stringify(rows));
  assert.equal(extractPromptDataSection(plain.sent.user, 'SOURCE_CLAIM_LEDGER'), payload.legacyLedgerText(ledger));
  assert.equal(plain.sent.system.includes(payload.OBLIGATION_INSTRUCTION), false);
  assert.equal(final.sent.system.replace('\n' + payload.OBLIGATION_INSTRUCTION, ''), plain.sent.system);
  assert.ok(final.sent.system.startsWith(plain.sent.system.slice(0, 2000)));
  assert.deepEqual(final.sent.schema, plain.sent.schema);
  for (const key of ['model', 'reasoningEffort', 'maxOutputTokens', 'verbosity', 'schemaName'])
    assert.equal(final.sent[key], plain.sent[key]);
  assert.equal(final.sent.model, 'gpt-6-sol');
  assert.equal(final.sent.reasoningEffort, 'high');
  assert.equal(final.sent.maxOutputTokens, 10500); // one losslessly retained obligation
  assert.equal(final.report.pass, true);
  assert.deepEqual(final.report.obligationReviews, plain.report.obligationReviews);
});

test('compact form does not relax adjudication: silence, primary dismissal and stale quotes stay open', async () => {
  const confirmingDismissal = await runJudge({ signals: FINAL, candidate: before, status: 'not_error', span: before });
  assert.equal(confirmingDismissal.report.pass, true);
  assert.equal(confirmingDismissal.report.obligationReviews[0].status, 'not_error');
  const primaryDismissal = await runJudge({ signals: FINAL, model: 'gpt-6-luna', candidate: before, status: 'not_error', span: before });
  assert.equal(primaryDismissal.report.pass, false);
  assert.equal(primaryDismissal.report.uncertain, true);
  assert.equal(primaryDismissal.sent.maxOutputTokens <= 10000, true);
  const stale = await runJudge({ signals: FINAL, candidate: after, status: 'resolved', span: before });
  assert.equal(stale.report.pass, false);
  assert.equal(stale.report.obligationReviews[0].status, 'unconfirmed');
  const unresolved = await runJudge({ signals: FINAL, status: 'unresolved' });
  assert.equal(unresolved.report.pass, false);
});
