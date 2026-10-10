'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Synthetic, generated fixtures only. The judge and heading alignment are
// stubbed so tests make no model calls and control segmentation exactly.
const judge = require('../engine-gpt-prod/judge');
const alignment = require('../engine-gpt-prod/reviewAlignment');
const receipts = require('../engine-gpt-prod/semanticSegmentReceipts');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const obligationPolicy = require('../engine-gpt-prod/semanticObligations');
const qualityPath = require.resolve('../engine-gpt-prod/finalQualityV2');

const config = { models: { judge: 'judge-a', judgeEscalation: 'judge-b', repair: 'repair-a' },
  reasoning: { judge: 'low', escalation: 'high', repair: 'medium' } };
const body = n => Array.from({ length: 60 }, (_, i) => `구역 ${n}의 합성 문장 ${i + 1}번은 검사용으로 만든 설명입니다.`).join(' ');
const section = (n, extra = '') => `## 절${n}\n${body(n)}${extra}\n\n`;
const doc = (edits = {}) => [1, 2, 3, 4].map(n => edits[n] ?? section(n)).join('');
const SOURCE = doc();

function splitSections(text) {
  return String(text).split(/(?=^## )/mu).filter(Boolean);
}
function headingPairs(src, out, maxChars) {
  const a = splitSections(src), b = splitSections(out);
  if (a.length !== b.length) return [{ index: 0, sourceContext: src, output: out, alignment: 'whole_document_uncertain', repairSafe: false }];
  const group = maxChars >= 6000 ? 2 : 1;
  const pairs = [];
  let s = 0, o = 0;
  for (let i = 0; i < a.length; i += group) {
    const sc = a.slice(i, i + group).join(''), oc = b.slice(i, i + group).join('');
    pairs.push({ index: pairs.length, sourceStart: s, sourceEnd: s + sc.length, outputStart: o, outputEnd: o + oc.length,
      sourceContext: sc, output: oc, alignment: 'shared_unique_heading', repairSafe: true });
    s += sc.length; o += oc.length;
  }
  return pairs;
}

async function withAudit(fn) {
  const originalJudge = judge.judgeAndRepair, originalAlign = alignment.alignedReviewPairs;
  const calls = [];
  const state = { verdict: () => ({ pass: true }) };
  judge.judgeAndRepair = async (src, text, options) => {
    calls.push({ src, text, options });
    const signals = options.discourseSignals || [];
    const confirmationFirst = options.maxRounds === 0 && signals.includes('final_semantic_revalidation')
      && signals.includes('prior_failed_semantic_confirmation');
    const v = await state.verdict(src, text, options);
    // Like the real judge: every given obligation is explicitly adjudicated
    // on a pass, and the verdict is bound to the exact text it judged.
    const given = obligationPolicy.collectObligations(src, options.priorReports || []);
    const out = { outputText: text, rounds: 0, violations: [], usage: { estimatedUsd: 0.01, inputTokens: 10 },
      selectedJudgeModel: confirmationFirst ? 'judge-b' : 'judge-a',
      obligationReviews: given.map(o => ({ id: o.id, status: 'resolved', sourceSpan: o.finding.sourceSpan, candidateSpan: '', detail: '' })),
      ...(confirmationFirst ? { relationConfirmationFirst: true } : {}), ...v };
    if (!Object.hasOwn(v, 'validation')) {
      out.validation = provenance.bindSemanticValidation({ ran: true, pass: out.pass, uncertain: out.uncertain,
        verificationCompleted: out.verificationCompleted }, src, out.outputText).validation;
    }
    return out;
  };
  alignment.alignedReviewPairs = headingPairs;
  delete require.cache[qualityPath];
  try {
    const audit = require(qualityPath).runSemanticDocumentAudit;
    const run = (outputText, extra = {}) => audit({ source: SOURCE, outputText, config, mode: 'assignment', ...extra });
    await fn({ run, calls, state });
  } finally {
    judge.judgeAndRepair = originalJudge;
    alignment.alignedReviewPairs = originalAlign;
    delete require.cache[qualityPath];
  }
}

const judged = calls => calls.map(c => splitSections(c.text).map(s => s.slice(3, 6).trim()).join('+'));

test('fixture produces four heading sections above the whole-document limit', () => {
  assert.ok(SOURCE.length > 6000 && SOURCE.length < 12000);
  assert.equal(headingPairs(SOURCE, SOURCE, 4500).length, 4);
  assert.equal(headingPairs(SOURCE, SOURCE, 6000).length, 2);
});

test('without a store behaviour is unchanged: every section is judged every time', async () => {
  await withAudit(async ({ run, calls }) => {
    await run(SOURCE);
    await run(SOURCE);
    assert.equal(calls.length, 8);
  });
});

test('document preparation precedes segmentation and receipt lookup; final bytes reuse exact verdicts', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    const prepared = SOURCE.replaceAll('검사용으로', '검사용 으로');
    let baseline;
    const first = await run(SOURCE, { receiptStore: store,
      prepareCandidateText: async (_source, candidate) => candidate.replaceAll('검사용으로', '검사용 으로'),
      onPreparedCandidate: text => { baseline = text; } });
    assert.equal(baseline, prepared);
    assert.equal(first.outputText, prepared);
    assert.equal(calls.length, 4);
    const final = await run(prepared, { receiptStore: store, allowRepair: false,
      discourseSignals: ['final_semantic_revalidation'] });
    assert.equal(final.pass, true);
    assert.equal(calls.length, 4, 'same exact prepared bytes need no additional model request');
    assert.equal(final.reports.filter(r => r.receiptReused).length, 4);
    await run(prepared.replace('합성 문장 1번', '달라진 문장 1번'), { receiptStore: store, allowRepair: false });
    assert.ok(calls.length > 4, 'changed text still requires a new verdict');
  });
});

test('earlier audit receipts connect to the final verdict-only audit for unchanged sections', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, discourseSignals: [] });
    assert.equal(earlier.pass, true);
    assert.equal(calls.length, 4);
    calls.length = 0;
    const late = doc({ 4: section(4, ' 늦은 단계에서 추가된 합성 문장입니다.') });
    const final = await run(late, { receiptStore: store, allowRepair: false,
      discourseSignals: ['final_semantic_revalidation'] });
    // Section 4 changed, so its whole neighbour (section 3) is judged again.
    // Sections 1 and 2 are exact with exact neighbours: reused at zero cost.
    assert.deepEqual(judged(calls).sort(), ['절3', '절4']);
    assert.equal(final.sectionCount, 4);
    assert.equal(final.progress.reusedSections, 2);
    assert.deepEqual(final.reports.map(r => r.receiptReused === true), [true, true, false, false]);
    assert.equal(final.reports[0].usage, null);
    assert.equal(final.usage.estimatedUsd, 0.02);
    assert.equal(final.verificationCompleted, true);
    assert.equal(final.pass, true);
    assert.equal(final.outputText, late);
    assert.equal(final.validation.status, 'validated_pass');
    assert.equal(JSON.stringify(final.reports[0]).includes('합성 문장'), false);
  });
});

test('confirmation-first final route never reuses primary-route receipts', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    calls.length = 0;
    const final = await run(SOURCE, { receiptStore: store, allowRepair: false,
      discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] });
    assert.equal(final.progress.reusedSections, 0);
    assert.equal(calls.length, 2); // default verdict-only plan, nothing reused
    calls.length = 0;
    // Same confirmation route and exact text: now reused.
    const again = await run(SOURCE, { receiptStore: store, allowRepair: false,
      discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] });
    assert.equal(calls.length, 0);
    assert.equal(again.pass, true);
    assert.equal(again.usage?.estimatedUsd || 0, 0);
    assert.equal(again.reports.every(r => r.receiptReused && r.usage === null), true);
  });
});

test('model, reasoning, mode, allowedExtra or source change invalidates every receipt', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    const variants = [
      { config: { ...config, models: { ...config.models, judge: 'judge-z' } } },
      { config: { ...config, reasoning: { ...config.reasoning, judge: 'high' } } },
      { mode: 'polish' },
      { allowedExtra: '합성 메모' },
      { lang: 'en' }
    ];
    for (const extra of variants) {
      calls.length = 0;
      await run(SOURCE, { receiptStore: store, ...extra });
      assert.equal(calls.length, 4, JSON.stringify(extra));
    }
  });
});

test('changed section source text invalidates only through exact binding', async () => {
  await withAudit(async ({ calls }) => {
    const store = receipts.createReceiptStore();
    const audit = require(qualityPath).runSemanticDocumentAudit;
    await audit({ source: SOURCE, outputText: SOURCE, config, receiptStore: store });
    calls.length = 0;
    const otherSource = doc({ 1: section(1, ' 원문 쪽에만 있는 합성 문장입니다.') });
    await audit({ source: otherSource, outputText: SOURCE, config, receiptStore: store });
    assert.equal(calls.length, 4); // whole-document source digest differs
  });
});

test('completed receipts survive a sibling timeout and are reused later in the request', async () => {
  await withAudit(async ({ run, calls, state }) => {
    const store = receipts.createReceiptStore();
    let failOnce = true;
    state.verdict = (src) => {
      if (failOnce && src.startsWith('## 절2')) { failOnce = false; throw Object.assign(new Error('synthetic timeout'), { usage: { estimatedUsd: 0.005 } }); }
      return { pass: true };
    };
    const first = await run(SOURCE, { receiptStore: store });
    assert.equal(first.verificationCompleted, false);
    assert.equal(first.pass, false);
    assert.equal(store.size, 3);
    calls.length = 0;
    const second = await run(SOURCE, { receiptStore: store });
    assert.deepEqual(judged(calls), ['절2']);
    assert.equal(second.pass, true);
    assert.equal(second.progress.reusedSections, 3);
    assert.equal(second.usage.estimatedUsd, 0.01);
  });
});

test('receipts are usable after cancellation but never create an aggregate pass alone', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    calls.length = 0;
    const controller = new AbortController(); controller.abort();
    const late = doc({ 2: section(2, ' 합성 추가 문장입니다.') });
    const result = await run(late, { receiptStore: store, signal: controller.signal });
    assert.equal(calls.length, 0);
    assert.equal(result.pass, false);
    assert.equal(result.verificationCompleted, false);
    assert.deepEqual(result.reports.map(r => r.receiptReused === true), [false, false, false, true]);
    assert.equal(result.validation.status, 'uncertain');
  });
});

test('failed, uncertain, skipped and repaired verdicts are never minted', async () => {
  await withAudit(async ({ run, calls, state }) => {
    const store = receipts.createReceiptStore();
    const verdicts = [
      { pass: false, violations: [{ type: 'distortion' }] },
      { pass: false, uncertain: true },
      { pass: true, skipped: true },
      { pass: true, validation: undefined }, // no bound provenance
      { pass: true, selectedJudgeModel: '' },
      { pass: true, selectedJudgeModel: 'unknown-model' },
      { pass: true, verificationCompleted: false }
    ];
    for (const v of verdicts) {
      state.verdict = () => v;
      await run(SOURCE, { receiptStore: store, allowRepair: false });
    }
    assert.equal(store.size, 0);
    // A repaired candidate whose delivered section boundary would differ from
    // the judged text is never receipted.
    state.verdict = (src, text) => ({ pass: true, outputText: text + ' 수리됨' });
    await run(SOURCE, { receiptStore: store });
    assert.equal(store.size, 0);
    assert.ok(calls.length > 0);
  });
});

test('fresh uncertain section keeps aggregate failed even when other sections are reused', async () => {
  await withAudit(async ({ run, state }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    state.verdict = () => ({ pass: false, uncertain: true });
    const late = doc({ 2: section(2, ' 합성 추가 문장입니다.') });
    const result = await run(late, { receiptStore: store });
    assert.equal(result.pass, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.validation.status, 'uncertain');
    assert.equal(result.reports.filter(r => r.receiptReused).length, 1);
  });
});

test('changed neighbour meaning invalidates both adjacent receipts', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    calls.length = 0;
    const changed = section(3).replace('구역 3의 합성 문장 1번은', '구역 3의 합성 문장 1번은 아닌');
    await run(doc({ 3: changed }), { receiptStore: store });
    assert.deepEqual(judged(calls).sort(), ['절2', '절3', '절4']);
    calls.length = 0;
    // Change deep inside section 3 (not near any boundary) still invalidates 2 and 4.
    const inner = section(3).replace('구역 3의 합성 문장 30번은', '구역 3의 합성 문장 30번만');
    await run(doc({ 3: inner }), { receiptStore: store });
    assert.deepEqual(judged(calls).sort(), ['절2', '절3', '절4']);
  });
});

test('same words with changed line or list ownership are not reused', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    const listed = n => `## 절${n}\n${body(n)}\n- 항목 가 항목 나\n- 항목 다\n${body(n + 10)}\n\n`;
    const src = [1, 2, 3, 4, 5, 6].map(listed).join('');
    const audit = require(qualityPath).runSemanticDocumentAudit;
    await audit({ source: src, outputText: src, config, receiptStore: store });
    calls.length = 0;
    const moved = src.replace('- 항목 가 항목 나\n- 항목 다\n' + body(16), '- 항목 가\n항목 나\n- 항목 다\n' + body(16));
    assert.notEqual(moved, src);
    // Identical whitespace-run projection: only exact binding can see it.
    assert.equal(moved.replace(/\s+/gu, ' '), src.replace(/\s+/gu, ' '));
    await audit({ source: src, outputText: moved, config, receiptStore: store });
    // Long document: 9,000-character windows own 1-2, 3-4 and 5-6. Only the
    // changed window and its neighbour are judged; window 1-2 is reused.
    assert.deepEqual(judged(calls).sort(), ['절3+절4', '절5+절6']);
  });
});

test('new or changed prior obligations invalidate the owning section receipt', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    const sourceSpan = '구역 1의 합성 문장 7번은 검사용으로 만든 설명입니다.';
    const finding = { type: 'distortion', origin: 'introduced', repairable: true, relationGrounded: true,
      grounding: 'unique_exact_span', spanVerified: true, sourceSpan, candidateSpan: sourceSpan,
      span: sourceSpan, relation: 'actor_action_target', detail: '합성 관계 점검 항목입니다.' };
    calls.length = 0;
    await run(SOURCE, { receiptStore: store, priorReports: [{ violations: [finding] }] });
    assert.deepEqual(judged(calls), ['절1']);
    calls.length = 0;
    // Same obligation, explicitly adjudicated before: reused.
    await run(SOURCE, { receiptStore: store, priorReports: [{ violations: [finding] }] });
    assert.equal(calls.length, 0);
    await run(SOURCE, { receiptStore: store, priorReports: [{ violations: [{ ...finding,
      obligationQuestions: [{ previousCandidateSpan: sourceSpan, previousProblemSpan: sourceSpan, detail: '다른 합성 질문입니다.' }] }] }] });
    assert.deepEqual(judged(calls), ['절1']);
  });
});

// Final-audit reuse of an earlier verified repair.

test('same-request verified repaired pass is reused by the final audit with its adjudicated obligation', async () => {
  await withAudit(async ({ run, calls, state }) => {
    const store = receipts.createReceiptStore();
    const wrong = '구역 4의 합성 문장 9번은 검사용으로 만든 설명입니다.';
    const fixedSentence = '구역 4의 합성 문장 9번은 검사용으로 만든 해설입니다.';
    const earlierInput = doc({ 4: section(4).replace(wrong, '구역 4의 합성 문장 9번은 검사와 무관한 설명입니다.') });
    const finding = { type: 'distortion', origin: 'introduced', repairable: true, relationGrounded: true,
      grounding: 'unique_exact_span', spanVerified: true, sourceSpan: wrong,
      candidateSpan: '구역 4의 합성 문장 9번은 검사와 무관한 설명입니다.', span: '검사와 무관한',
      relation: 'actor_action_target', detail: '합성 관계 점검 항목입니다.' };
    const id = obligationPolicy.obligationId(finding);
    state.verdict = (src, text) => {
      if (!src.startsWith('## 절4')) return { pass: true };
      // One non-escalated repair round; the post-repair judge validated the
      // repaired text and adjudicated the round's initial finding.
      const repaired = text.replace(finding.candidateSpan, fixedSentence);
      return { pass: true, rounds: 1, outputText: repaired, initialViolations: [finding],
        obligationReviews: [{ id, status: 'resolved', sourceSpan: wrong, candidateSpan: fixedSentence, detail: '합성 해소 근거입니다.' }] };
    };
    const earlier = await run(earlierInput, { receiptStore: store });
    assert.equal(earlier.pass, true);
    assert.notEqual(earlier.outputText, earlierInput);
    state.verdict = () => ({ pass: true });
    calls.length = 0;
    const final = await run(earlier.outputText, { receiptStore: store, allowRepair: false,
      priorReports: [earlier], discourseSignals: ['final_semantic_revalidation'] });
    // Section 3's receipt was bound to the pre-repair neighbour; only it is judged.
    assert.deepEqual(judged(calls), ['절3']);
    assert.equal(final.pass, true);
    assert.deepEqual(final.reports.map(r => r.receiptReused === true), [true, true, false, true]);
    assert.ok(final.reports[3].obligationReviews.some(r => r.id === id && r.status === 'resolved'));
    assert.equal(obligationPolicy.allExplicitlyReviewed(
      obligationPolicy.collectObligations(SOURCE, [earlier]), final), true);
    // A stronger (confirmation-first) route cannot reuse these primary receipts.
    calls.length = 0;
    await run(earlier.outputText, { receiptStore: store, allowRepair: false, priorReports: [earlier],
      discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] });
    assert.ok(calls.length > 0);
    assert.ok(calls.every(c => c.options.maxRounds === 0));
  });
});

test('index wires one request-local store into every semantic document audit (source check)', () => {
  const text = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod/index.js'), 'utf8');
  const audits = text.split('qualityV2.runSemanticDocumentAudit(').length - 1;
  assert.equal((text.match(/createReceiptStore\(\)/gu) || []).length, 1);
  assert.equal((text.match(/receiptStore: semanticSectionReceipts/gu) || []).length, audits);
  assert.equal(/global\.[A-Za-z]*[Rr]eceipt|module\.exports[^;]*semanticSectionReceipts/u.test(text), false);
});

test('reused receipts count as zero judge calls in the job call count', () => {
  const text = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod/index.js'), 'utf8');
  const start = text.indexOf('function semanticCallCount(');
  const tail = /\r?\n\}\r?\n/u.exec(text.slice(start));
  const end = start + tail.index + tail[0].length;
  const context = {};
  require('node:vm').createContext(context);
  require('node:vm').runInContext(text.slice(start, end), context);
  const report = { ran: true, reports: [
    { receiptReused: true, rounds: 0 }, { receiptReused: true, rounds: 0 },
    { escalated: true, rounds: 0 }, { rounds: 1 }
  ] };
  assert.equal(context.semanticCallCount(report), 2 + 3);
  assert.equal(context.semanticCallCount({ ran: true, reports: [{ receiptReused: true }] }), 0);
  assert.equal(context.semanticCallCount({ ran: true, reports: [{ started: false, skipped: true }, { rounds: 0 }] }), 1);
});

test('H0378-shaped flow: three initial sections, escalated repaired pass and failure, then final confirmation remap', async () => {
  // Synthetic shape only (actual document unverified): three heading sections
  // in the earlier audit, two verdict-only windows by default in the final.
  const three = [1, 2, 3].map(n => `## 절${n}\n${body(n)} ${body(n + 20).slice(0, 1000)}\n\n`).join('');
  assert.ok(three.length > 6000 && three.length < 12000);
  await withAudit(async ({ calls, state }) => {
    const audit = require(qualityPath).runSemanticDocumentAudit;
    const store = receipts.createReceiptStore();
    const bad = '구역 2의 합성 문장 5번은 검사와 무관한 설명입니다.';
    const good = '구역 2의 합성 문장 5번은 검사용으로 만든 설명입니다.';
    const earlierInput = three.replace(good, bad);
    const finding = { type: 'distortion', origin: 'introduced', repairable: true, relationGrounded: true,
      grounding: 'unique_exact_span', spanVerified: true, sourceSpan: good, candidateSpan: bad,
      span: '검사와 무관한', relation: 'actor_action_target', detail: '합성 관계 점검 항목입니다.' };
    const id = obligationPolicy.obligationId(finding);
    const failing = { type: 'omission', origin: 'introduced', repairable: false, detail: '합성 누락 후보입니다.' };
    state.verdict = (src, text) => {
      if (src.startsWith('## 절2')) return { pass: true, escalated: true, selectedJudgeModel: 'judge-b', rounds: 1,
        outputText: text.replace(bad, good), initialViolations: [finding],
        obligationReviews: [{ id, status: 'resolved', sourceSpan: good, candidateSpan: good, detail: '합성 해소 근거입니다.' }] };
      if (src.startsWith('## 절3')) return { pass: false, violations: [failing] };
      return { pass: true };
    };
    const earlier = await audit({ source: three, outputText: earlierInput, config, receiptStore: store });
    assert.equal(earlier.sectionCount, 3);
    assert.equal(earlier.pass, false);
    state.verdict = () => ({ pass: true });
    calls.length = 0;
    const final = await audit({ source: three, outputText: earlier.outputText, config, receiptStore: store,
      allowRepair: false, priorReports: [earlier],
      discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] });
    // Section 1 was a primary-tier pass: not reusable under forced confirmation.
    // Section 2's confirming, provenance-bound repaired pass with its explicitly
    // resolved obligation is reused. Section 3 failed earlier: judged again.
    assert.deepEqual(judged(calls).sort(), ['절1', '절3']);
    assert.deepEqual(final.reports.map(r => r.receiptReused === true), [false, true, false]);
    assert.equal(final.sectionCount, 3); // stable earlier partition kept only because it reuses
    assert.ok(calls.every(c => c.options.maxRounds === 0));
    assert.equal(final.pass, true);
    assert.equal(final.usage.estimatedUsd, 0.02);
    // Without the confirming receipt the final keeps its default two windows.
    calls.length = 0;
    const fresh = await audit({ source: three, outputText: earlier.outputText, config,
      receiptStore: receipts.createReceiptStore(), allowRepair: false, priorReports: [earlier],
      discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] });
    assert.equal(fresh.sectionCount, 2);
    assert.equal(calls.length, 2);
  });
});

// ---- Canonical audit representation (semanticCanonicalAudit) ----
const canonicalAudit = require('../engine-gpt-prod/semanticCanonicalAudit');
const literalSpans = require('../engine-gpt-prod/literalSpans');

// Mirrors index.js freezeLockedBlocks: first exact occurrence, source order.
function lockFreeze(text, values) {
  let out = String(text);
  const blocks = [];
  values.forEach((value, index) => {
    const token = `ZXQLOCK${String(index).padStart(4, '0')}QXZ`;
    const at = out.indexOf(value);
    if (at < 0) return;
    out = out.slice(0, at) + token + out.slice(at + value.length);
    blocks.push({ token, value });
  });
  return { text: out, blocks };
}
function canonicalFixture(raw, lockedValues) {
  const code = literalSpans.freezeInlineCode(raw);
  const math = literalSpans.freezeMath(code.text);
  const lock = lockFreeze(math.text, lockedValues);
  const canonical = canonicalAudit.createCanonicalAudit({ rawSource: raw, frozenSource: lock.text,
    lockedBlocks: lock.blocks, mathBlocks: math.blocks, codeBlocks: code.blocks });
  return { frozenSource: lock.text, canonical };
}
const RAW = '## 개요\n1. 첫째 항목은 `code_a` 를 설명합니다.\n2. 둘째 항목은 $$x^2$$ 값과 `$&` 기호를 다룹니다.\n본문 문장은 검사용 합성 설명입니다.\n';
const LOCKED = ['## 개요', '1.', '2.'];
const bound = (src, out, extra = {}) => provenance.bindSemanticValidation(
  { ran: true, verificationCompleted: true, pass: true, outputText: out, ...extra }, src, out, { model: 'judge-a' });

test('canonical map: exact raw materialization incl. distinct 2-char prefixes, $$ math and $& code', () => {
  const { frozenSource, canonical } = canonicalFixture(RAW, LOCKED);
  assert.equal(canonical.ok, true, canonical.reason);
  assert.equal(canonical.canonicalSource, RAW);
  assert.match(frozenSource, /^ZXQLOCK0001QXZ 첫째/mu);
  const frozenCandidate = frozenSource.replace('본문 문장은 검사용 합성 설명입니다.', '본문은 검사를 위한 합성 설명입니다.');
  const prepared = canonicalAudit.prepareCandidate(canonical, frozenSource, frozenCandidate);
  assert.equal(prepared.ok, true, prepared.reason);
  assert.ok(prepared.canonicalCandidate.includes('## 개요\n1. 첫째') && prepared.canonicalCandidate.includes('$$x^2$$ 값과 `$&`'));
  assert.equal(/ZXQ|QXZ/u.test(prepared.canonicalCandidate), false);
  // A judged local repair elsewhere refreezes positionally and exactly.
  const repaired = prepared.canonicalCandidate.replace('첫째 항목은', '첫 항목은');
  const back = canonical.refreeze(repaired, frozenCandidate);
  assert.equal(back.ok, true, back.reason);
  assert.equal(back.text, frozenCandidate.replace('첫째 항목은', '첫 항목은'));
  assert.equal(canonical.materialize(back.text).text, repaired);
  assert.equal(canonical.refreeze(prepared.canonicalCandidate, frozenCandidate).text, frozenCandidate);
});

test('canonical refreeze fails closed on changed, added, moved or re-anchored literals', () => {
  const { frozenSource, canonical } = canonicalFixture(RAW, LOCKED);
  const { canonicalCandidate } = canonicalAudit.prepareCandidate(canonical, frozenSource, frozenSource);
  const reject = (text, reason) => {
    const result = canonical.refreeze(text, frozenSource);
    assert.equal(result.ok, false, text);
    assert.equal(result.reason, reason);
  };
  reject(canonicalCandidate.replace('## 개요', '## 요약'), 'canonical_literal_count_changed');
  reject(canonicalCandidate.replace('본문 문장은', '본문 1. 문장은'), 'canonical_literal_count_changed');
  reject(canonicalCandidate.replace('1. 첫째', '첫째'), 'canonical_literal_count_changed');
  // Same single occurrence and order, but the list prefix left its line start.
  reject(canonicalCandidate.replace('2. 둘째 항목은', '둘째 2. 항목은'), 'canonical_literal_anchor_changed');
  reject(canonicalCandidate.replace('2. 둘째', '둘째').replace('본문 문장은', '본문 2. 문장은'), 'canonical_literal_order_changed');
  reject(canonicalCandidate.replace('`code_a`', '`code_b`'), 'canonical_literal_count_changed');
  reject(canonicalCandidate.replace('본문', 'ZXQLOCK0009QXZ'), 'canonical_token_like_text');
});

test('canonical prepare refuses inexact candidates and unsafe sources (legacy frozen audit runs)', async () => {
  const { frozenSource, canonical } = canonicalFixture(RAW, LOCKED);
  const reason = candidate => canonicalAudit.prepareCandidate(canonical, frozenSource, candidate).reason;
  // 표식 번호는 요청마다 달라진다. 고정 번호 대신 이 원문에 실제로 들어간 표식을 쓴다.
  const mathToken = frozenSource.match(/ZXQMATH\d{4}QXZ/u)?.[0];
  const codeToken = frozenSource.match(/ZXQCODE\d{4}QXZ/u)?.[0];
  assert.ok(mathToken && codeToken);
  assert.equal(reason(frozenSource.replace(mathToken, '')), 'canonical_candidate_token_sequence');
  assert.equal(reason(`${frozenSource}${codeToken}`), 'canonical_candidate_token_sequence');
  const lines = frozenSource.split('\n');
  assert.equal(reason([lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n')), 'canonical_candidate_token_sequence');
  assert.equal(reason(frozenSource.replace('본문', 'ZXQ본문')), 'canonical_token_residue');
  assert.equal(canonicalFixture(`${RAW}ZXQ 표기\n`, LOCKED).canonical.ok, false);
  // Materialization round-trips exactly (the fast path would accept), but the
  // literals are not unique: identical prefixes, or a prefix also in prose.
  const identical = canonicalFixture(RAW.replace('1. 첫째', '- 첫째').replace('2. 둘째', '- 둘째'), ['## 개요', '- ', '- ']);
  assert.equal(identical.canonical.canonicalSource, '');
  assert.equal(identical.canonical.reason, 'canonical_literal_not_unique');
  assert.equal(canonicalFixture(RAW.replace('본문 문장은', '본문 1. 문장은'), LOCKED).canonical.reason, 'canonical_literal_count_changed');
  assert.equal(canonicalFixture(RAW.replace('`$&`', '`code_a`'), LOCKED).canonical.reason, 'canonical_literal_not_unique');
  assert.equal(canonicalFixture('평문만 있는 합성 문장입니다.', []).canonical.reason, 'canonical_no_frozen_literals');
  const seen = [];
  const legacy = await canonicalAudit.runCanonicalSemanticAudit({ canonical,
    options: { source: frozenSource, outputText: frozenSource.replace(mathToken, '') },
    runAudit: async options => { seen.push(options); return bound(options.source, options.outputText); } });
  assert.equal(seen[0].source, frozenSource);
  assert.equal(legacy.canonicalAudit.applied, false);
  assert.equal(legacy.validation.sourceDigest, provenance.textDigest(frozenSource));
});

test('canonical frozen view: judged raw pair, provenance parents, projection back to judged text', async () => {
  const { frozenSource, canonical } = canonicalFixture(RAW, LOCKED);
  const frozenCandidate = frozenSource.replace('본문 문장은', '본문은');
  const seen = [];
  const view = await canonicalAudit.runCanonicalSemanticAudit({ canonical,
    options: { source: frozenSource, outputText: frozenCandidate, mode: 'assignment' },
    runAudit: async options => { seen.push(options); return bound(options.source, options.outputText); } });
  assert.equal(seen[0].source, RAW);
  assert.equal(seen[0].mode, 'assignment');
  assert.ok(seen[0].outputText.startsWith('## 개요\n1. 첫째'));
  const judgedText = seen[0].outputText;
  assert.equal(view.outputText, frozenCandidate);
  assert.equal(view.pass, true);
  assert.equal(view.canonicalAudit.frozenViewExact, true);
  assert.equal(view.validation.phase, 'canonical_refreeze');
  assert.equal(view.validation.parentSourceDigest, provenance.textDigest(RAW));
  assert.equal(view.validation.parentCandidateDigest, provenance.textDigest(judgedText));
  assert.equal(provenance.verifySemanticValidation(view, { source: frozenSource, candidate: frozenCandidate, requireDigest: true }).status, 'pass');
  // index.js semanticReportForCandidate projection lands on the judged pair.
  const projected = provenance.projectSemanticValidation(view, { source: frozenSource, candidate: view.outputText,
    project: text => canonical.materialize(text).text });
  assert.equal(projected.validation.sourceDigest, provenance.textDigest(RAW));
  assert.equal(projected.validation.candidateDigest, provenance.textDigest(judgedText));
  // A repaired judged output elsewhere is refrozen exactly and stays a pass.
  const repairedView = await canonicalAudit.runCanonicalSemanticAudit({ canonical,
    options: { source: frozenSource, outputText: frozenCandidate },
    runAudit: async options => bound(options.source, options.outputText.replace('첫째 항목은', '첫 항목은'), { rounds: 1 }) });
  assert.equal(repairedView.outputText, frozenCandidate.replace('첫째 항목은', '첫 항목은'));
  assert.equal(repairedView.validation.status, 'validated_pass');
});

test('canonical frozen view fails closed on literal-touching repair or inexact provenance', async () => {
  const { frozenSource, canonical } = canonicalFixture(RAW, LOCKED);
  const finding = { type: 'distortion', origin: 'introduced', repairable: true, relationGrounded: true,
    grounding: 'unique_exact_span', spanVerified: true, sourceSpan: '본문 문장은 검사용 합성 설명입니다.',
    candidateSpan: '본문 문장은 검사와 무관한 설명입니다.', span: '검사와 무관한', relation: 'actor_action_target', detail: '합성 점검 항목입니다.' };
  const residual = { type: 'omission', origin: 'introduced', repairable: false, detail: '남은 합성 누락 후보입니다.' };
  const touched = await canonicalAudit.runCanonicalSemanticAudit({ canonical,
    options: { source: frozenSource, outputText: frozenSource },
    runAudit: async options => bound(options.source, options.outputText.replace('## 개요', '## 요약'),
      { rounds: 1, initialViolations: [finding], violations: [residual], uncertain: false,
        usage: { estimatedUsd: 0.02 } }) });
  assert.equal(touched.pass, false);
  assert.equal(touched.repairRejected, true);
  assert.ok(touched.repairRejectReasons.includes('canonical_refreeze_failed'));
  assert.equal(touched.outputText, frozenSource);
  assert.equal('validation' in touched, false);
  assert.deepEqual(touched.violations, [finding, residual]);
  assert.deepEqual(touched.initialViolations, [finding]);
  assert.equal(touched.usage.estimatedUsd, 0.02);
  assert.notEqual(provenance.verifySemanticValidation(touched, { source: frozenSource, candidate: frozenSource, requireDigest: true }).status, 'pass');
  // Raw findings keep their ids through the final projection (identity on raw).
  const projectedEvidence = obligationPolicy.projectEvidence(touched, text => canonical.materialize(text).ok ? canonical.materialize(text).text : text);
  assert.deepEqual(obligationPolicy.collectObligations(RAW, [projectedEvidence]).map(o => o.id), [obligationPolicy.obligationId(finding)]);
  const mismatch = await canonicalAudit.runCanonicalSemanticAudit({ canonical,
    options: { source: frozenSource, outputText: frozenSource },
    runAudit: async options => bound(frozenSource, options.outputText) });
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.reason, 'canonical_provenance_mismatch');
  assert.equal('validation' in mismatch, false);
});

test('canonical earlier audit uses heading sections and its receipts reach the raw final audit', async () => {
  await withAudit(async ({ run, calls }) => {
    const lock = lockFreeze(SOURCE, [1, 2, 3, 4].map(n => `## 절${n}`));
    const canonical = canonicalAudit.createCanonicalAudit({ rawSource: SOURCE, frozenSource: lock.text, lockedBlocks: lock.blocks });
    assert.equal(canonical.ok, true, canonical.reason);
    const runAudit = options => run(options.outputText, options);
    // Legacy frozen audit: no heading anchors, one whole-document request.
    const legacyStore = receipts.createReceiptStore();
    await runAudit({ source: lock.text, outputText: lock.text, receiptStore: legacyStore, discourseSignals: [] });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].text.includes('ZXQLOCK0000QXZ'));
    calls.length = 0;
    const store = receipts.createReceiptStore();
    const earlier = await canonicalAudit.runCanonicalSemanticAudit({ canonical, runAudit,
      options: { source: lock.text, outputText: lock.text, receiptStore: store, discourseSignals: [] } });
    assert.equal(calls.length, 4);
    assert.deepEqual(judged(calls), ['절1', '절2', '절3', '절4']);
    assert.equal(earlier.pass, true);
    assert.equal(earlier.outputText, lock.text);
    calls.length = 0;
    const late = doc({ 4: section(4, ' 늦은 단계에서 추가된 합성 문장입니다.') });
    const final = await run(late, { receiptStore: store, allowRepair: false, discourseSignals: ['final_semantic_revalidation'] });
    assert.deepEqual(judged(calls).sort(), ['절3', '절4']);
    assert.equal(final.progress.reusedSections, 2);
    assert.equal(final.pass, true);
    calls.length = 0;
    const legacyFinal = await run(late, { receiptStore: legacyStore, allowRepair: false, discourseSignals: ['final_semantic_revalidation'] });
    assert.equal(legacyFinal.progress.reusedSections, 0);
  });
});

// Scheduling diagnostics: numbers and fixed codes only; never text or verdict authority.
const FINAL_MARKERS = ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'];
const assertNoText = value => {
  const json = JSON.stringify(value);
  for (const fragment of ['절', '합성', '구역', '문장']) assert.equal(json.includes(fragment), false, fragment);
};

test('schedule diagnostics: confirming final windows record plan, route, receipt miss and timing', async () => {
  await withAudit(async ({ run, calls }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    calls.length = 0;
    const final = await run(SOURCE, { receiptStore: store, allowRepair: false,
      discourseSignals: FINAL_MARKERS, deadlineMs: Date.now() + 120000 });
    const d = final.scheduleDiagnostics;
    assert.equal(calls.length, 2);
    assert.equal(d.version, 'semantic-schedule-diagnostics-v1');
    assert.equal(d.planKind, 'balanced_heading');
    assert.deepEqual([d.basePairCount, d.plannedPairCount, d.finalPairCount], [4, 2, 2]);
    assert.equal(d.allowRepair, false);
    assert.equal(d.concurrency, 2);
    assert.ok(d.budgetMsAtStart > 0 && d.budgetMsAtStart <= 120000);
    assert.equal(d.aborted, false);
    assert.equal(d.windows.length, 2);
    for (const w of d.windows) {
      // Primary receipts cannot satisfy the confirming route: miss, not reuse.
      assert.equal(w.route, 'confirmation_first');
      assert.equal(w.receipt, 'miss');
      assert.equal(w.outcome, 'pass');
      assert.equal(w.judgeTier, 'confirmation_first');
      assert.equal(w.judgeModel, 'judge-b');
      assert.equal(w.alignment, 'shared_unique_heading');
      assert.ok(w.sourceChars > 0 && w.outputChars === w.sourceChars);
      assert.equal(w.obligationCount, 0);
      assert.ok(w.remainingMsAtStart > 0 && w.remainingMsAtStart <= 120000);
      assert.ok(w.queuedMs >= 0 && w.elapsedMs >= 0);
      assert.equal(w.inputTokens, 10);
    }
    assert.equal(d.windows.reduce((n, w) => n + w.sourceChars, 0), SOURCE.length);
    assertNoText(d);
    // Diagnostics never alter the verdict or its binding.
    assert.equal(final.pass, true);
    assert.equal(final.validation.status, 'validated_pass');
    calls.length = 0;
    const again = await run(SOURCE, { receiptStore: store, allowRepair: false, discourseSignals: FINAL_MARKERS });
    assert.equal(calls.length, 0);
    assert.deepEqual(again.scheduleDiagnostics.windows.map(w => [w.receipt, w.outcome, w.elapsedMs >= 0]),
      [['hit', 'receipt_reused', true], ['hit', 'receipt_reused', true]]);
    assert.equal(again.scheduleDiagnostics.budgetMsAtStart, null);
  });
});

test('schedule diagnostics: receipt-driven base plan and disabled store are named', async () => {
  await withAudit(async ({ run }) => {
    const store = receipts.createReceiptStore();
    await run(SOURCE, { receiptStore: store });
    const late = doc({ 4: section(4, ' 늦은 단계에서 추가된 합성 문장입니다.') });
    const final = await run(late, { receiptStore: store, allowRepair: false,
      discourseSignals: ['final_semantic_revalidation'] });
    const d = final.scheduleDiagnostics;
    assert.equal(d.planKind, 'receipt_base');
    assert.deepEqual([d.basePairCount, d.plannedPairCount, d.finalPairCount], [4, 2, 4]);
    assert.deepEqual(d.windows.map(w => w.receipt), ['hit', 'hit', 'miss', 'miss']);
    assert.deepEqual(d.windows.map(w => w.outcome), ['receipt_reused', 'receipt_reused', 'pass', 'pass']);
    assert.deepEqual(d.windows.map(w => w.route), Array(4).fill('primary_first'));
    assertNoText(d);
    const plain = await run(SOURCE);
    assert.equal(plain.scheduleDiagnostics.planKind, 'base_heading');
    assert.deepEqual(plain.scheduleDiagnostics.windows.map(w => [w.receipt, w.route, w.judgeTier]),
      Array(4).fill(['disabled', undefined, 'primary']));
  });
});

test('schedule diagnostics: shared deadline abort is a timeout of both concurrent windows, not a pass', async () => {
  await withAudit(async ({ run, state }) => {
    state.verdict = (_src, _text, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError',
        usage: { inputTokens: 7 } })), { once: true });
    });
    const final = await run(SOURCE, { allowRepair: false, discourseSignals: FINAL_MARKERS, deadlineMs: Date.now() + 60 });
    const d = final.scheduleDiagnostics;
    assert.equal(final.pass, false);
    assert.equal(final.verificationCompleted, false);
    assert.equal(d.aborted, true);
    assert.equal(d.deadlineExceeded, true);
    assert.equal(d.windows.length, 2);
    for (const w of d.windows) {
      assert.equal(w.outcome, 'deadline_timeout');
      assert.equal(w.errorCode, 'AbortError');
      assert.equal(w.inputTokens, 7);
      // Both windows started before the deadline: the budget was spent in
      // flight, not in a queue.
      assert.ok(w.queuedMs < 60 && w.remainingMsAtStart > 0);
    }
    assert.equal(d.admittedWindowCount, 2);
    assert.equal(d.outcomeCounts.deadline_timeout, 2);
    assert.equal(d.outcomeCounts.pass, 0);
    assert.ok(d.minRemainingMsAtStart > 0 && d.minRemainingMsAtStart <= 60);
    assert.equal(d.overflowWindowCount, 0);
    assertNoText(d);
  });
});

test('schedule diagnostics: sections queued behind a cancellation never start a model call and are counted', async () => {
  await withAudit(async ({ run, calls, state }) => {
    const controller = new AbortController();
    // Four heading sections under the repair path: concurrency 2, so two are queued.
    // Both workers reach their judge before the abort (it fires on the second
    // admitted call); the two queued sections must then never call a model.
    let seen = 0;
    state.verdict = async () => { if (++seen === 2) controller.abort(); return { pass: true }; };
    const result = await run(SOURCE, { signal: controller.signal });
    const d = result.scheduleDiagnostics;
    assert.equal(calls.length, 2);
    assert.equal(result.pass, false);
    assert.equal(d.planKind, 'base_heading');
    assert.equal(d.aborted, true);
    assert.equal(d.deadlineExceeded, false);
    assert.equal(d.outcomeCounts.pass, 2);
    assert.equal(d.outcomeCounts.cancelled_before_start, 2);
    assert.deepEqual(d.windows.map(w => w.outcome).sort(),
      ['cancelled_before_start', 'cancelled_before_start', 'pass', 'pass']);
    for (const w of d.windows.filter(x => x.outcome === 'cancelled_before_start')) {
      assert.equal(w.elapsedMs, 0);
      assert.equal(w.judgeTier, '');
      assert.equal(w.inputTokens, null);
    }
    assert.equal(d.budgetMsAtStart, null);
    assert.equal(d.minRemainingMsAtStart, null);
  });
});

test('schedule recorder is text-free and tolerant of unknown values', () => {
  const schedule = require('../engine-gpt-prod/semanticAuditSchedule');
  let t = 1000;
  const pairs = [{ sourceContext: '가'.repeat(5), output: '나'.repeat(4), alignment: 'bad value!' }];
  const r = schedule.createScheduleRecorder({ basePairs: pairs, plannedPairs: pairs, finalPairs: pairs,
    deadlineMs: 1500, now: () => t });
  r.describe(0, { pair: pairs[0], obligationCount: 3, signals: ['code_a', '{"x":1}'], route: 'primary' });
  r.receipt(0, 'miss');
  t = 1100; r.start(0);
  t = 1400; r.finish(0, { outcome: 'not-a-code', error: { code: 'contains text 가' } });
  const out = r.result({ signal: { aborted: false } });
  assert.equal(out.planKind, 'single');
  assert.equal(out.budgetMsAtStart, 500);
  assert.deepEqual(out.windows[0], { index: 0, order: 0, sourceChars: 5, outputChars: 4, alignment: 'other',
    obligationCount: 3, hintCount: 1, relationCandidateCount: 1, route: 'primary', receipt: 'miss',
    queuedMs: 100, remainingMsAtStart: 400, elapsedMs: 300, outcome: 'error', errorCode: 'other',
    judgeTier: '', judgeModel: '', verifyCount: 0, inputTokens: null, outputTokens: null, reasoningTokens: null });
  assert.equal(schedule.errorOutcome({ aborted: true, reason: { name: 'TimeoutError' } }), 'deadline_timeout');
  assert.equal(schedule.errorOutcome({ aborted: true, reason: { name: 'AbortError' } }), 'cancelled');
  assert.equal(schedule.errorOutcome(null), 'error');
  assert.equal(schedule.outcomeFor({ pass: true, uncertain: true }), 'uncertain');
  assert.equal(schedule.outcomeFor({ pass: false, verificationCompleted: true }), 'fail');
  // Bounded: rows stop at the cap, outcome counters still cover every window.
  const many = Array.from({ length: schedule.MAX_DIAGNOSTIC_WINDOWS + 5 }, () => pairs[0]);
  const big = schedule.createScheduleRecorder({ basePairs: many, plannedPairs: many, finalPairs: many });
  many.forEach((pair, i) => { big.describe(i, { pair }); big.start(i); big.finish(i, { outcome: 'pass' }); });
  const bounded = big.result({});
  assert.equal(bounded.windows.length, schedule.MAX_DIAGNOSTIC_WINDOWS);
  assert.equal(bounded.overflowWindowCount, 5);
  assert.equal(bounded.outcomeCounts.pass, many.length);
  assert.equal(bounded.admittedWindowCount, many.length);
  assert.equal(bounded.planKind, 'base_heading');
});
