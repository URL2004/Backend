'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../engine-gpt-prod/semanticSegmentReceipts');

// Synthetic fixtures only.
const config = { models: { judge: 'judge-a', judgeEscalation: 'judge-b', repair: 'repair-a' },
  reasoning: { judge: 'low', escalation: 'high', repair: 'medium' } };
const pairs = [
  { sourceContext: '## 가\n가 문장 하나.\n', output: '## 가\n가 문장 하나.\n', alignment: 'shared_unique_heading' },
  { sourceContext: '## 나\n나 문장 둘.\n', output: '## 나\n나 문장 둘.\n', alignment: 'shared_unique_heading' },
  { sourceContext: '## 다\n다 문장 셋.\n', output: '## 다\n다 문장 셋.\n', alignment: 'shared_unique_heading' }
];
const source = pairs.map(p => p.sourceContext).join('');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const base = { source, pairs, index: 1, signals: ['x_code'],
  lang: 'ko', mode: 'assignment', allowedExtra: '', documentProfile: null, safetyIdentifier: 's', config };
const key = over => r.receiptKey({ ...base, ...over });
const clonePairs = (i, field, value) => pairs.map((p, j) => j === i ? { ...p, [field]: value } : p);

test('receipt key is exact and changes with every bound input', () => {
  const k = key();
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(key(), k);
  const variants = {
    source: key({ source: source + ' ' }),
    candidate: key({ pairs: clonePairs(1, 'output', '## 나\n나 문장 둘!\n') }),
    sourceContext: key({ pairs: clonePairs(1, 'sourceContext', '## 나\n나 문장 둘?\n') }),
    listOwnershipSameWords: key({ pairs: clonePairs(1, 'output', '## 나\n나 문장\n둘.\n') }),
    neighbourPrevious: key({ pairs: clonePairs(0, 'output', '## 가\n가 문장 하나 아님.\n') }),
    neighbourNext: key({ pairs: clonePairs(2, 'output', '## 다\n다 문장 셋 아님.\n') }),
    segmentation: key({ pairs: [pairs[0], pairs[1], { ...pairs[2], sourceContext: '## 다\n' }] }),
    index: key({ index: 0 }),
    alignment: key({ pairs: clonePairs(1, 'alignment', 'shared_monotonic_sentence') }),
    signals: key({ signals: ['y_code'] }),
    pairedHint: key({ signals: ['x_code', JSON.stringify({ code: 'c', sourceSpan: '나 문장 둘.', outputSpan: '나 문장 둘.' })] }),
    mode: key({ mode: 'polish' }),
    lang: key({ lang: 'en' }),
    allowedExtra: key({ allowedExtra: '메모' }),
    profile: key({ documentProfile: { profile: 'academic_paper' } }),
    model: key({ config: { ...config, models: { ...config.models, judge: 'judge-c' } } }),
    escalationModel: key({ config: { ...config, models: { ...config.models, judgeEscalation: 'judge-d' } } }),
    reasoning: key({ config: { ...config, reasoning: { ...config.reasoning, escalation: 'medium' } } })
  };
  for (const [name, value] of Object.entries(variants)) assert.notEqual(value, k, name);
  assert.equal(new Set(Object.values(variants)).size, Object.keys(variants).length);
});

test('pure control markers and stale unpaired hints do not change key; unknown identity disables reuse', () => {
  assert.equal(key({ signals: ['x_code', 'final_semantic_revalidation'] }), key());
  // Unpaired hints are dropped from the prompt, but their routing code is
  // still bound so a filtered mapping code cannot admit a weaker verdict tier.
  const unpaired = code => key({ signals: ['x_code', JSON.stringify({ code, sourceSpan: '없는 구절', outputSpan: '없는 구절' })] });
  assert.notEqual(unpaired('number_ownership_candidate'), key());
  assert.equal(unpaired('number_ownership_candidate'),
    key({ signals: [JSON.stringify({ code: 'number_ownership_candidate', sourceSpan: '다른 없는 구절', outputSpan: '다른' }), 'x_code'] }));
  assert.equal(r.expectedRoute(['alias_owner_binding_candidate'], 1, config), 'confirmation_first');
  assert.equal(key({ config: {} }), '');
  assert.equal(key({ config: undefined }), '');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(key({ documentProfile: cyclic }), '');
  assert.match(r.policyFingerprint(), /^[0-9a-f]{64}$/);
});

test('expected route mirrors judge routing and minted route uses actual report', () => {
  assert.equal(r.expectedRoute(['a'], 1, config), 'primary_first');
  assert.equal(r.expectedRoute(['final_semantic_revalidation', 'prior_failed_semantic_confirmation'], 0, config), 'confirmation_first');
  assert.equal(r.expectedRoute(['final_semantic_revalidation', 'prior_failed_semantic_confirmation'], 1, config), 'primary_first');
  assert.equal(r.expectedRoute(['number_ownership_candidate'], 1, config), 'confirmation_first');
  const same = { ...config, models: { judge: 'j', judgeEscalation: 'j' } };
  assert.equal(r.expectedRoute(['number_ownership_candidate'], 0, same), 'primary_first');
  assert.equal(r.mintedRoute({ relationConfirmationFirst: true }), 'confirmation_first');
  assert.equal(r.mintedRoute({}), 'primary_first');
});

const bound = (src, cand, extra = {}) => ({
  ...provenance.bindSemanticValidation({ ran: true, pass: true }, src, cand), pass: true, outputText: cand,
  rounds: 0, violations: [], selectedJudgeModel: 'judge-a', ...extra });
const finding = { type: 'distortion', origin: 'introduced', sourceSpan: '합성 원문 구절 열두 글자 이상', relation: 'x', span: 'y' };
const findingId = require('../engine-gpt-prod/semanticObligations').obligationId(finding);

test('only a provenance-bound completed pass by an identified tier is receipt-worthy', () => {
  const opts = { sourceContext: 'S', candidate: 'abc', config };
  assert.equal(r.isReceiptWorthy(bound('S', 'abc'), opts), true);
  // Repaired candidate is fine when the judge's provenance binds that text.
  assert.equal(r.isReceiptWorthy(bound('S', 'abc', { rounds: 1 }), opts), true);
  for (const bad of [
    { pass: false }, { uncertain: true }, { skipped: true }, { verificationCompleted: false },
    { repairRejected: true }, { escalationFailed: true }, { partialSemanticRepairRetained: true },
    { confirmedRelationRestoreRejected: true }, { violations: [{ type: 'omission' }] }, { outputText: 'abd' },
    { selectedJudgeModel: '' }, { selectedJudgeModel: 'unknown' }, { validation: undefined },
    { escalated: true } // escalated verdict must come from the configured confirming model
  ]) assert.equal(r.isReceiptWorthy({ ...bound('S', 'abc'), ...bad }, opts), false, JSON.stringify(bad));
  assert.equal(r.isReceiptWorthy(bound('S', 'abd'), opts), false);
  assert.equal(r.isReceiptWorthy(bound('T', 'abc'), opts), false);
  assert.equal(r.isReceiptWorthy(bound('S', 'abc'), { ...opts, candidate: undefined }), false);
  // Given obligations must all be explicitly adjudicated.
  assert.equal(r.isReceiptWorthy(bound('S', 'abc'), { ...opts, obligations: [finding] }), false);
  assert.equal(r.isReceiptWorthy(bound('S', 'abc', { obligationReviews: [{ id: findingId, status: 'unresolved' }] }),
    { ...opts, obligations: [finding] }), false);
  assert.equal(r.isReceiptWorthy(bound('S', 'abc', { obligationReviews: [{ id: findingId, status: 'resolved' }] }),
    { ...opts, obligations: [finding] }), true);
  assert.equal(r.verdictTier(bound('S', 'abc', { selectedJudgeModel: 'judge-b', escalated: true }), config), 'confirming');
  assert.equal(r.verdictTier(bound('S', 'abc', { selectedJudgeModel: 'judge-b', relationConfirmationFirst: true }), config), 'confirming');
  assert.equal(r.verdictTier(bound('S', 'abc'), config), 'primary');
});

test('lookup enforces tier capability and identical adjudicated obligations', () => {
  const store = r.createReceiptStore(), k = key();
  const opts = { sourceContext: 'S', candidate: 'abc', config };
  assert.equal(store.record(k, bound('S', 'abc'), opts), true);
  assert.ok(store.lookup(k, { route: 'primary_first' }));
  assert.equal(store.lookup(k, { route: 'confirmation_first' }), null); // weak tier never satisfies strong route
  assert.equal(store.lookup(k, { obligations: [finding] }), null); // unadjudicated obligation
  assert.equal(store.record(k, bound('S', 'abc', { selectedJudgeModel: 'judge-b', relationConfirmationFirst: true,
    obligationReviews: [{ id: findingId, status: 'resolved' }] }), { ...opts, obligations: [finding] }), true);
  assert.ok(store.lookup(k, { route: 'confirmation_first', obligations: [finding] }));
  assert.ok(store.lookup(k, { route: 'primary_first', obligations: [finding] })); // strong satisfies weak
  const changedQuestion = { ...finding, obligationQuestions: [{ previousCandidateSpan: 'z', previousProblemSpan: 'z', detail: 'new' }] };
  assert.equal(store.lookup(k, { route: 'confirmation_first', obligations: [changedQuestion] }), null);
  assert.equal(store.has(k, { route: 'confirmation_first', obligations: [finding] }), true);
});

test('store keeps digests and minimal verdicts only, and is request local', () => {
  const a = r.createReceiptStore(), b = r.createReceiptStore();
  const k = key();
  const opts = { sourceContext: 'S', candidate: 'x', config };
  assert.equal(a.record(k, { ...bound('S', 'x'), pass: false }, opts), false);
  assert.equal(a.record('', bound('S', 'x'), opts), false);
  assert.equal(a.record(k, bound('S', 'x', { obligationReviews: [{ id: 'o', status: 'resolved' }],
    sourceContext: 'SECRET', usage: { estimatedUsd: 1 } }), opts), true);
  assert.equal(b.lookup(k), null);
  const hit = a.lookup(k);
  assert.equal(hit.pass, true);
  assert.equal(hit.selectedJudgeModel, 'judge-a');
  assert.equal(JSON.stringify(hit).includes('SECRET'), false);
  assert.equal(Object.hasOwn(hit, 'usage'), false);
  assert.throws(() => { hit.pass = false; });
  assert.deepEqual(a.stats(), { minted: 1, reused: 1, misses: 0, size: 1 });
  assert.equal(r.isReceiptStore(a), true);
  assert.equal(r.isReceiptStore({}), false);
});

test('reused section report is zero cost and fully verified without fragments', () => {
  const report = r.reusedSectionReport({ index: 2, sourceContext: 'S', output: 'O', alignment: 'shared_unique_heading' },
    { pass: true, selectedJudgeModel: 'judge-a', relationContract: 'semantic-relations-v2', obligationReviews: [] });
  assert.equal(report.usage, null);
  assert.equal(report.rounds, 0);
  assert.equal(report.escalated, false);
  assert.equal(report.receiptReused, true);
  assert.equal(report.verificationCompleted, true);
  assert.equal(report.pass, true);
  assert.equal(Object.hasOwn(report, 'sourceContext') || Object.hasOwn(report, 'output'), false);
});

test('segmentation preference only when it strictly reuses and stays within concurrency', () => {
  const plan = ['p'], alt = ['a'];
  const counts = new Map([[plan, { reused: 0, fresh: 2 }], [alt, { reused: 2, fresh: 2 }]]);
  assert.equal(r.preferReusableSegmentation(plan, alt, l => counts.get(l)), alt);
  counts.set(alt, { reused: 1, fresh: 3 });
  assert.equal(r.preferReusableSegmentation(plan, alt, l => counts.get(l)), plan);
  counts.set(alt, { reused: 0, fresh: 1 });
  assert.equal(r.preferReusableSegmentation(plan, alt, l => counts.get(l)), plan);
});
