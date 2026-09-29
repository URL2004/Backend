'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Synthetic, generated fixtures only. The judge and heading alignment are
// stubbed: no model call, no network, no user text.
const judge = require('../engine-gpt-prod/judge');
const alignment = require('../engine-gpt-prod/reviewAlignment');
const receipts = require('../engine-gpt-prod/semanticSegmentReceipts');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const obligationPolicy = require('../engine-gpt-prod/semanticObligations');
const staging = require('../engine-gpt-prod/semanticStaging');
const callLedger = require('../engine-gpt-prod/callLedger');
const qualityPath = require.resolve('../engine-gpt-prod/finalQualityV2');

const config = { models: { judge: 'judge-a', judgeEscalation: 'judge-b', repair: 'repair-a' },
  reasoning: { judge: 'low', escalation: 'high', repair: 'medium' } };
const CONTROL = ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'];
const body = n => Array.from({ length: 70 }, (_, i) => `구역 ${n}의 합성 문장 ${i + 1}번은 검사용으로 만든 설명입니다.`).join(' ');
const section = (n, extra = '') => `## 절${n}\n${body(n)}${extra}\n\n`;
const repaired = n => section(n, ' 수리된 합성 문장입니다.');
const docOf = (count, edits = {}) => Array.from({ length: count }, (_, i) => edits[i + 1] ?? section(i + 1)).join('');
const finding = n => ({ type: 'distortion', origin: 'introduced', repairable: true, relationGrounded: true,
  grounding: 'unique_exact_span', spanVerified: true, relation: 'actor_action_target', span: '합성 문장 7번',
  sourceSpan: `구역 ${n}의 합성 문장 7번은 검사용으로 만든 설명입니다.`, candidateSpan: `구역 ${n}의 합성 문장 7번은`,
  detail: 'synthetic finding' });

const splitSections = text => String(text).split(/(?=^## )/mu).filter(Boolean);
const sectionNo = text => Number((String(text).match(/^## 절(\d+)/u) || [])[1] || 0);
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

async function withAudit(count, fn) {
  const originalJudge = judge.judgeAndRepair, originalAlign = alignment.alignedReviewPairs;
  const calls = [];
  const state = { verdict: () => ({}), delay: () => 0 };
  judge.judgeAndRepair = async (src, text, options) => {
    const signals = options.discourseSignals || [];
    const strong = options.requireConfirmation === true || (options.maxRounds === 0
      && signals.includes(CONTROL[0]) && signals.includes(CONTROL[1]));
    const call = { src, text, options, strong, section: sectionNo(text), sections: splitSections(text).map(sectionNo),
      policy: callLedger.current()?.policy || null };
    calls.push(call);
    const wait = state.delay(call);
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const v = await state.verdict(call);
    const given = obligationPolicy.collectObligations(src, options.priorReports || []);
    const out = { outputText: text, pass: true, rounds: 0, violations: [], usage: { estimatedUsd: strong ? 0.1 : 0.01, inputTokens: 10 },
      selectedJudgeModel: strong ? 'judge-b' : 'judge-a',
      obligationReviews: given.map(o => ({ id: o.id, status: 'resolved', sourceSpan: o.finding.sourceSpan, candidateSpan: '', detail: '' })),
      ...(strong ? { relationConfirmationFirst: true } : {}), ...v };
    if (!Object.hasOwn(v, 'validation')) {
      out.validation = provenance.bindSemanticValidation({ ran: true, pass: out.pass, uncertain: out.uncertain,
        verificationCompleted: out.verificationCompleted }, src, out.outputText).validation;
    }
    return out;
  };
  alignment.alignedReviewPairs = headingPairs;
  delete require.cache[qualityPath];
  const SOURCE = docOf(count);
  try {
    const audit = require(qualityPath).runSemanticDocumentAudit;
    const run = (outputText, extra = {}) => audit({ source: SOURCE, outputText, config, mode: 'assignment',
      reserveConfirmation: () => true, ...extra });
    const final = (outputText, store, earlier, extra = {}) => run(outputText, { receiptStore: store, allowRepair: false,
      discourseSignals: CONTROL, priorReports: [earlier], ...extra });
    await fn({ SOURCE, run, final, calls, state });
  } finally {
    judge.judgeAndRepair = originalJudge;
    alignment.alignedReviewPairs = originalAlign;
    delete require.cache[qualityPath];
  }
}

// Section n fails the primary judge, is repaired, and the primary re-judge
// passes (the H0378 shape): never seen by the confirming judge.
const primaryRepairOf = n => call => (!call.strong && call.section === n && call.text === section(n)
  ? { outputText: repaired(n), rounds: 1, initialViolations: [finding(n)] } : {});

test('route mirror: requireConfirmation selects confirmation_first only with a distinct confirming model', () => {
  assert.equal(receipts.expectedRoute([], 1, config, { requireConfirmation: true }), 'confirmation_first');
  assert.equal(receipts.expectedRoute([], 1, config), 'primary_first');
  const same = { models: { judge: 'j', judgeEscalation: 'j' } };
  assert.equal(receipts.expectedRoute([], 1, same, { requireConfirmation: true }), 'primary_first');
  assert.equal(staging.escalationDiffers(same), false);
  assert.equal(staging.stagingEligible({ stagedConfirmation: true, allowRepair: true, store: {}, config,
    basePairs: [1, 2], pairs: [1, 2] }), false, 'pairs must be the base plan object');
});

test('index wiring: default OFF flag, per-call admission, job-scoped requirement used by final and fallback (source check)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod/index.js'), 'utf8');
  assert.equal((src.match(/stagedConfirmation: process\.env\.HUMANIZE_STAGED_CONFIRMATION_ENABLED === '1'/gu) || []).length, 1);
  assert.match(src, /reserveConfirmation: \(\) => \{\s*if \(recoveryBudget\.tryStart\(\{\}\)\) return true;/u);
  assert.match(src, /onConfirmationRequired: \(\) => stagedConfirmationRequirement\.require\(\)/u);
  assert.match(src, /stagedConfirmationRequirement\.note\(semanticReport\);/u);
  assert.match(src, /stagedConfirmationPending = stagedConfirmationRequirement\.pending\(semanticReport, \{\s*source: rawSource, candidate: outputText, preliminaryStatus: preliminary\.status \}\)/u);
  assert.match(src, /\|\| stagedConfirmationPending\);/u);
  assert.match(src, /\|\| needsObligationReview \|\| stagedConfirmationPending\s*\? \['prior_failed_semantic_confirmation'\]/u);
  assert.match(src, /fallbackProven = stagedConfirmationRequirement\.allowsFallback\(choice\.entry, \{ source: rawSource \}\)/u);
  assert.match(src, /choice\.entry\?\.semanticStatus === 'pass' && !fallbackProven\)/u);
  // The requirement is created once per job, never reset.
  assert.equal((src.match(/createConfirmationRequirement\(\)/gu) || []).length, 1);
  assert.equal((src.match(/stagedConfirmationRequirement = /gu) || []).length, 1);
});

test('clean document: staging adds no call and changes nothing', async () => {
  await withAudit(4, async ({ SOURCE, run, calls }) => {
    const report = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true });
    assert.equal(report.pass, true);
    assert.equal(calls.length, 4);
    assert.equal(calls.some(c => c.strong), false);
    assert.equal(report.stagedConfirmation.required, false);
    assert.equal(report.stagedConfirmation.skipReason, 'not_required');
  });
});

test('sequencing: later sections go strong once a failure is known; sweep confirms earlier peers; final reuses all', async () => {
  await withAudit(4, async ({ SOURCE, run, final, calls, state }) => {
    state.verdict = primaryRepairOf(1);
    // Section 2 is slower, so it is still primary when section 1's failure lands.
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const store = receipts.createReceiptStore();
    const earlier = await callLedger.run(() => run(SOURCE, { receiptStore: store, stagedConfirmation: true }));
    assert.equal(earlier.pass, true);
    const first = calls.slice(0, 4);
    assert.deepEqual(first.map(c => [c.section, c.strong]).sort(), [[1, false], [2, false], [3, true], [4, true]]);
    assert.ok(first.every(c => c.options.stagedConfirmation === true), 'judge defers failed primary repair');
    assert.ok(first.every(c => c.policy?.optional !== true), 'first-pass calls stay the mandatory audit');
    // Sweep: 1 (primary-only after repair) and 2 (clean primary peer, neighbour
    // repaired). 3 and 4 kept exact confirming receipts: not re-asked.
    const sweep = calls.slice(4);
    assert.deepEqual(sweep.map(c => c.section).sort(), [1, 2]);
    assert.ok(sweep.every(c => c.strong && c.options.requireConfirmation === true));
    assert.ok(sweep.every(c => c.policy?.optional === true && c.policy.stage === 'staged_semantic_confirmation'));
    assert.ok(sweep.every(c => !c.options.discourseSignals.some(s => CONTROL.includes(s))));
    const s1 = sweep.find(c => c.section === 1);
    assert.equal(s1.text, repaired(1));
    assert.deepEqual(obligationPolicy.collectObligations(s1.src, s1.options.priorReports).map(o => o.id),
      [obligationPolicy.obligationId(finding(1))]);
    const d = earlier.stagedConfirmation;
    assert.equal(d.required, true);
    assert.equal(d.earlyConfirmedSections, 2);
    assert.equal(d.sweepReused, 2);
    assert.equal(d.sweepConfirmed, 2);
    assert.equal(d.complete, true);
    assert.equal(earlier.reports[0].stagedConfirmation, 'confirmed');
    assert.deepEqual(earlier.reports[0].initialViolations.map(v => v.sourceSpan), [finding(1).sourceSpan]);
    const text = docOf(4, { 1: repaired(1) });
    assert.equal(earlier.outputText, text);
    // Proof is bound to the exact audited source and candidate digests.
    assert.equal(d.provenSections, 4);
    assert.equal(staging.confirmationProven(earlier, { source: SOURCE, candidate: text }), true);
    assert.equal(staging.confirmationProven(earlier, { source: SOURCE, candidate: text + ' ' }), false);
    assert.equal(staging.confirmationProven(earlier, { source: SOURCE + ' ', candidate: text }), false);
    // The final gate is unchanged (confirmation_first) and needs no call.
    calls.length = 0;
    const late = await final(text, store, earlier);
    assert.equal(calls.length, 0);
    assert.equal(late.pass, true);
    assert.equal(late.progress.reusedSections, 4);
    assert.equal(obligationPolicy.allExplicitlyReviewed(
      obligationPolicy.collectObligations(SOURCE, [earlier]), earlier), true);
  });
});

test('without staging the same run leaves the confirming look to the final', async () => {
  await withAudit(4, async ({ SOURCE, run, final, calls, state }) => {
    state.verdict = primaryRepairOf(1);
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store });
    assert.equal(calls.some(c => c.strong), false);
    assert.equal(earlier.stagedConfirmation, undefined);
    calls.length = 0;
    const late = await final(docOf(4, { 1: repaired(1) }), store, earlier);
    assert.ok(calls.length >= 2 && calls.every(c => c.strong), 'primary receipts never satisfy the final');
    assert.equal(late.progress.reusedSections, 0);
  });
});

test('a later edit invalidates the edited section and its whole neighbour only', async () => {
  await withAudit(4, async ({ SOURCE, run, final, calls, state }) => {
    state.verdict = primaryRepairOf(1);
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, stagedConfirmation: true });
    calls.length = 0;
    const edited = docOf(4, { 1: repaired(1), 4: section(4, ' 늦게 바뀐 합성 문장입니다.') });
    const late = await final(edited, store, earlier);
    // Section 3 text is unchanged, but its whole neighbour changed.
    assert.deepEqual(calls.flatMap(c => c.sections).sort(), [3, 4]);
    assert.ok(calls.every(c => c.strong));
    assert.equal(late.progress.reusedSections, 2);
    // A middle edit leaves three fresh sections: the final keeps its existing
    // two-window plan and reuses nothing stale.
    calls.length = 0;
    const middle = await final(docOf(4, { 1: repaired(1), 3: section(3, ' 늦게 바뀐 합성 문장입니다.') }), store, earlier);
    assert.deepEqual(calls.flatMap(c => c.sections).sort(), [1, 2, 3, 4]);
    assert.equal(middle.progress.reusedSections, 0);
  });
});

test('completed confirming failure is the verdict; the failed repair text is never adopted', async () => {
  await withAudit(4, async ({ run, final, calls, state, SOURCE }) => {
    const primary = primaryRepairOf(1);
    // The confirming judge saw section 2 (initialViolations), then accepted a
    // repair that still failed: its findings quote the REPAIRED text only.
    const onRepair = { ...finding(2), candidateSpan: '실패한 수리 문장입니다', span: '실패한 수리 문장입니다' };
    state.verdict = call => (call.strong && call.section === 2
      ? { pass: false, outputText: section(2, ' 실패한 수리 문장입니다.'), rounds: 1,
        initialViolations: [finding(2)], violations: [onRepair] } : primary(call));
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, stagedConfirmation: true });
    assert.equal(earlier.pass, false);
    assert.equal(earlier.reports[1].stagedConfirmation, 'failed');
    assert.deepEqual(earlier.violations.map(v => v.sourceSpan), [finding(2).sourceSpan]);
    assert.equal(earlier.outputText, docOf(4, { 1: repaired(1) }), 'primary candidate retained');
    // L8: every verdict finding grounds on the retained text; the failed
    // repair's finding is nomination evidence only.
    assert.ok(earlier.violations.every(v => earlier.outputText.includes(v.candidateSpan)));
    assert.equal(earlier.violations.includes(onRepair), false);
    assert.ok(earlier.reports[1].initialViolations.some(v => v.candidateSpan === onRepair.candidateSpan));
    assert.equal(earlier.stagedConfirmation.complete, false);
    assert.equal(staging.confirmationProven(earlier, { source: SOURCE, candidate: earlier.outputText }), false);
    calls.length = 0;
    await final(earlier.outputText, store, earlier);
    assert.ok(calls.some(c => c.sections.includes(2)), 'section 2 is judged again at the final');
  });
});

test('uncertain or truncated confirmation is incomplete: first verdict, text and findings kept, final forced', async () => {
  await withAudit(4, async ({ run, final, calls, state, SOURCE }) => {
    const primary = primaryRepairOf(1);
    state.verdict = call => (call.strong && call.section === 2 && call.options.requireConfirmation === true
      ? { pass: false, uncertain: true, verificationCompleted: false, violations: [finding(2)] } : primary(call));
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, stagedConfirmation: true });
    assert.equal(earlier.reports[1].stagedConfirmation, 'incomplete');
    assert.equal(earlier.reports[1].selectedJudgeModel, 'judge-a');
    assert.deepEqual(earlier.reports[1].initialViolations.map(v => v.sourceSpan), [finding(2).sourceSpan]);
    assert.equal(earlier.stagedConfirmation.sweepUncertain, 1);
    assert.equal(earlier.stagedConfirmation.complete, false, 'caller must force the confirming final');
    assert.equal(earlier.outputText, docOf(4, { 1: repaired(1) }));
    calls.length = 0;
    await final(earlier.outputText, store, earlier);
    assert.ok(calls.some(c => c.strong && c.sections.includes(2)));
  });
});

test('a sweep repair of one section leaves its peers unproven: complete=false, final re-judges them', async () => {
  await withAudit(4, async ({ run, final, calls, state, SOURCE }) => {
    const primary = primaryRepairOf(1);
    state.verdict = call => (call.strong && call.section === 2 && call.text === section(2)
      && call.options.requireConfirmation === true && !call.policy
      ? {} : call.strong && call.section === 2 && call.text === section(2)
        ? { outputText: repaired(2), rounds: 1, initialViolations: [finding(2)] } : primary(call));
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const store = receipts.createReceiptStore();
    const earlier = await callLedger.run(() => run(SOURCE, { receiptStore: store, stagedConfirmation: true }));
    assert.equal(earlier.pass, true);
    assert.equal(earlier.reports[0].stagedConfirmation, 'confirmed', 'status alone is not evidence');
    assert.equal(earlier.stagedConfirmation.complete, false);
    calls.length = 0;
    await final(earlier.outputText, store, earlier);
    assert.ok(calls.some(c => c.sections.includes(1)), 'section 1 was confirmed next to the old section 2');
  });
});

test('cancelled or timed-out confirmation keeps the completed first verdict and exact text; final re-judges', async () => {
  await withAudit(4, async ({ SOURCE, run, final, calls, state }) => {
    const primary = primaryRepairOf(1);
    let interrupted = 0;
    state.verdict = call => {
      if (call.strong && call.section === 2 && interrupted++ === 0) {
        const error = new Error('synthetic timeout'); error.name = 'TimeoutError'; error.usage = { estimatedUsd: 0.05 };
        throw error;
      }
      return primary(call);
    };
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, stagedConfirmation: true });
    assert.equal(earlier.pass, true, 'the completed primary verdict stands at this stage');
    assert.equal(earlier.reports[1].stagedConfirmation, 'incomplete');
    assert.equal(earlier.reports[1].selectedJudgeModel, 'judge-a');
    assert.equal(earlier.stagedConfirmation.sweepIncomplete, 1);
    assert.equal(earlier.stagedConfirmation.complete, false);
    assert.equal(earlier.usage.estimatedUsd > 0.05, true, 'interrupted call usage is kept');
    assert.equal(earlier.outputText, docOf(4, { 1: repaired(1) }));
    calls.length = 0;
    const late = await final(earlier.outputText, store, earlier);
    assert.ok(calls.some(c => c.strong && c.sections.includes(2)), 'no confirming receipt, so the final judges it');
    assert.equal(late.pass, true);
  });
});

test('admission denied per call, missing gate, failing audit or no store: no sweep call', async () => {
  await withAudit(4, async ({ SOURCE, run, calls, state }) => {
    state.verdict = primaryRepairOf(1);
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    let asked = 0;
    const denied = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true,
      reserveConfirmation: () => { asked += 1; return false; } });
    assert.equal(asked, 2, 'asked once per needed call; receipt hits consume nothing');
    assert.equal(denied.stagedConfirmation.sweepDenied, 2);
    assert.equal(denied.stagedConfirmation.complete, false);
    assert.equal(denied.pass, true);
    assert.equal(calls.length, 4);
    calls.length = 0;
    const ungated = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true,
      reserveConfirmation: undefined });
    assert.equal(ungated.stagedConfirmation.sweepDenied, 2);
    assert.equal(calls.length, 4);
    calls.length = 0;
    state.verdict = call => (call.section === 1 ? { pass: false, violations: [finding(1)] } : {});
    const failing = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true });
    assert.equal(failing.stagedConfirmation.skipReason, 'audit_not_passed');
    assert.equal(calls.length, 4);
    calls.length = 0;
    const noStore = await run(SOURCE, { stagedConfirmation: true });
    assert.equal(noStore.stagedConfirmation, undefined, 'no receipt store: nothing can be reused, stay unchanged');
  });
});

test('verdict-only audits never stage', async () => {
  await withAudit(4, async ({ SOURCE, run, calls }) => {
    const report = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true,
      allowRepair: false, priorReports: [{ violations: [finding(1)] }], discourseSignals: CONTROL });
    assert.equal(report.stagedConfirmation, undefined);
    assert.ok(calls.every(c => c.options.requireConfirmation !== true));
  });
});

test('format is settled before minting: the sweep judges and keeps the prepared text', async () => {
  await withAudit(4, async ({ SOURCE, run, final, calls, state }) => {
    state.verdict = primaryRepairOf(1);
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    // Formatting the first pass did not apply to the repaired sentence.
    const tidy = text => text.replace('수리된 합성 문장입니다.', '수리된 합성 문장입니다!');
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, stagedConfirmation: true,
      prepareCandidateText: async (src, text) => tidy(text) });
    const s1 = calls.slice(4).find(c => c.section === 1);
    assert.equal(s1.text, tidy(repaired(1)));
    assert.equal(s1.options.prepareCandidateText, null);
    assert.equal(earlier.stagedConfirmation.preparedSections, 1);
    assert.equal(earlier.outputText, docOf(4, { 1: tidy(repaired(1)) }));
    calls.length = 0;
    await final(earlier.outputText, store, earlier);
    assert.equal(calls.length, 0);
  });
});

test('long three-section sequence (H0378 shape): strong look happens while repair is possible', async () => {
  await withAudit(3, async ({ SOURCE, run, final, calls, state }) => {
    const primary1 = primaryRepairOf(1), primary2 = primaryRepairOf(2);
    state.verdict = call => {
      // Section 3: the confirming judge finds and repairs a real problem.
      if (call.strong && call.section === 3 && call.text === section(3))
        return { outputText: repaired(3), rounds: 1, initialViolations: [finding(3)] };
      return call.section === 1 ? primary1(call) : primary2(call);
    };
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const store = receipts.createReceiptStore();
    const earlier = await run(SOURCE, { receiptStore: store, stagedConfirmation: true });
    assert.ok(SOURCE.length > 6000);
    assert.equal(earlier.pass, true);
    const first = calls.slice(0, 3);
    assert.deepEqual(first.map(c => [c.section, c.strong]).sort(), [[1, false], [2, false], [3, true]]);
    // Section 3's strong pass was minted next to the pre-repair section 2, so
    // the neighbour edit forces one more confirming look: nothing stale reused.
    const sweep = calls.slice(3);
    assert.deepEqual(sweep.map(c => c.section).sort(), [1, 2, 3]);
    assert.ok(sweep.every(c => c.strong));
    const text = docOf(3, { 1: repaired(1), 2: repaired(2), 3: repaired(3) });
    assert.equal(earlier.outputText, text);
    calls.length = 0;
    const late = await final(text, store, earlier);
    assert.equal(calls.length, 0, 'final gate satisfied by exact confirming receipts');
    assert.equal(late.pass, true);
    assert.equal(late.scheduleDiagnostics.planKind, 'receipt_base');
  });
});

// ---- r3: job-scoped requirement, fallback tier, fail-closed, partial work ----

const ledgerFor = source => require('../engine-gpt-prod/candidateLedger').createCandidateLedger({
  source,
  assess: () => ({ hardViolationCodes: [], languageViolationCodes: [], languageRisk: 0,
    minimumEffectPass: true, transformed: true, depthSnapshot: null })
});
const failedFinal = (source, text) => provenance.bindSemanticValidation({ ran: true, pass: false,
  verificationCompleted: true, uncertain: false, violations: [] }, source, text);

test('H1: an unproven primary-pass checkpoint cannot be the fallback once confirmation is required', async () => {
  await withAudit(4, async ({ SOURCE, run, calls, state }) => {
    state.verdict = primaryRepairOf(1);
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const requirement = staging.createConfirmationRequirement();
    let notifiedAtCall = -1;
    // Flag ON, sweep denied: primary pass, required, not complete.
    const denied = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true,
      reserveConfirmation: () => false,
      onConfirmationRequired: () => { notifiedAtCall = calls.length; requirement.require(); } });
    assert.equal(denied.pass, true);
    assert.equal(denied.stagedConfirmation.required, true);
    assert.equal(denied.stagedConfirmation.complete, false);
    assert.ok(notifiedAtCall >= 1 && notifiedAtCall <= 4, 'requirement established during the first pass');
    requirement.note(denied);
    const text = denied.outputText;
    assert.equal(requirement.pending(denied, { source: SOURCE, candidate: text, preliminaryStatus: 'pass' }), true,
      'the final confirming verdict is forced');
    // The forced final fails; the ledger now holds the old primary pass and
    // the failed current entry for the same text.
    const ledger = ledgerFor(SOURCE);
    ledger.record({ stage: 'semantic_main', text, semanticReport: denied });
    const current = ledger.record({ stage: 'final_revalidation_not_passed', text, semanticReport: failedFinal(SOURCE, text) });
    const choice = ledger.chooseFinal(current.id, { reviewObligations: [], knownViolations: [] });
    assert.equal(choice.applied, true, 'without the rule the ledger would resurrect the primary pass');
    assert.equal(choice.entry.semanticStatus, 'pass');
    assert.equal(requirement.allowsFallback(choice.entry, { source: SOURCE }), false);
    // Flag OFF (no requirement): the existing fallback behaviour is unchanged.
    assert.equal(staging.createConfirmationRequirement().allowsFallback(choice.entry, { source: SOURCE }), true);
  });
});

test('H1: a fallback entry with exact complete proof for its own text remains eligible', async () => {
  await withAudit(4, async ({ SOURCE, run, state }) => {
    state.verdict = primaryRepairOf(1);
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const proven = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true });
    assert.equal(proven.stagedConfirmation.complete, true);
    const requirement = staging.createConfirmationRequirement();
    requirement.note(proven);
    const ledger = ledgerFor(SOURCE);
    ledger.record({ stage: 'semantic_main', text: proven.outputText, semanticReport: proven });
    const later = proven.outputText.replace('## 절4', '## 절4 ');
    const current = ledger.record({ stage: 'final_revalidation_not_passed', text: later,
      semanticReport: failedFinal(SOURCE, later) });
    const choice = ledger.chooseFinal(current.id);
    assert.equal(choice.applied, true);
    assert.equal(requirement.allowsFallback(choice.entry, { source: SOURCE }), true);
    // The same proof does not transfer to a different text or source.
    assert.equal(requirement.allowsFallback({ ...choice.entry, text: later }, { source: SOURCE }), false);
    assert.equal(requirement.allowsFallback(choice.entry, { source: SOURCE + ' ' }), false);
  });
});

test('H2: the requirement is job-scoped and survives report replacement; status or model name is no proof', async () => {
  await withAudit(4, async ({ SOURCE, run, state }) => {
    state.verdict = primaryRepairOf(1);
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const proven = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true });
    const text = proven.outputText;
    const requirement = staging.createConfirmationRequirement();
    assert.equal(requirement.pending(proven, { source: SOURCE, candidate: text, preliminaryStatus: 'pass' }), false,
      'exact proof for this text satisfies it');
    assert.equal(requirement.required, true);
    // A later recovery replaces the report with a non-staged audit of the
    // same text (index post_semantic_noop_recovery): marker gone, still required.
    const replacement = { ...(await run(text, { receiptStore: receipts.createReceiptStore() })),
      decisionReason: 'post_semantic_noop_recovery' };
    assert.equal(replacement.stagedConfirmation, undefined);
    assert.equal(requirement.pending(replacement, { source: SOURCE, candidate: text, preliminaryStatus: 'pass' }), true);
    assert.equal(requirement.required, true, 'never cleared');
    // A spread that keeps the marker but changed text, a stale status, or
    // a forged marker with only a confirming model name: all pending.
    assert.equal(requirement.pending(proven, { source: SOURCE, candidate: text + 'x', preliminaryStatus: 'pass' }), true);
    assert.equal(requirement.pending(proven, { source: SOURCE, candidate: text, preliminaryStatus: 'stale' }), true);
    const forged = { ...replacement, selectedJudgeModel: 'judge-b',
      reports: replacement.reports.map(r => ({ ...r, selectedJudgeModel: 'judge-b', stagedConfirmation: 'confirmed' })),
      stagedConfirmation: { version: staging.VERSION, required: true, complete: true } };
    assert.equal(requirement.pending(forged, { source: SOURCE, candidate: text, preliminaryStatus: 'pass' }), true);
    const partial = { ...proven, stagedConfirmation: { ...proven.stagedConfirmation, provenSections: 1 } };
    assert.equal(staging.confirmationProven(partial, { source: SOURCE, candidate: text }), false, 'all sections');
    const failed = { ...proven, pass: false };
    assert.equal(staging.confirmationProven(failed, { source: SOURCE, candidate: text }), false);
    // A job that never staged (flag OFF) is never pending through this rule.
    assert.equal(staging.createConfirmationRequirement().pending(replacement,
      { source: SOURCE, candidate: text, preliminaryStatus: 'pass' }), false);
  });
});

test('M3: an exception around the sweep trigger fails closed (required, not complete)', async () => {
  await withAudit(4, async ({ SOURCE, run, calls }) => {
    const original = staging.documentObligations;
    let notified = 0;
    staging.documentObligations = () => { throw new Error('synthetic obligation failure'); };
    try {
      const report = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true,
        onConfirmationRequired: () => { notified += 1; } });
      assert.equal(report.stagedConfirmation.required, true);
      assert.equal(report.stagedConfirmation.complete, false);
      assert.equal(report.stagedConfirmation.skipReason, 'sweep_error');
      assert.equal(report.stagedConfirmation.provenCandidateDigest, undefined);
      assert.equal(notified, 1);
      assert.equal(calls.length, 4, 'no added call');
      const requirement = staging.createConfirmationRequirement();
      assert.equal(requirement.pending(report, { source: SOURCE, candidate: report.outputText,
        preliminaryStatus: 'pass' }), true);
    } finally {
      staging.documentObligations = original;
    }
  });
});

test('L6: a thrown confirming call keeps its usage and the completed partial findings as evidence only', async () => {
  await withAudit(4, async ({ SOURCE, run, state }) => {
    const primary = primaryRepairOf(1);
    let thrown = 0;
    state.verdict = call => {
      if (call.strong && call.section === 2 && thrown++ === 0) {
        const error = new Error('synthetic abort after repair');
        error.name = 'AbortError';
        error.usage = { estimatedUsd: 0.07 };
        error.partialSemanticReport = { outputText: call.text, pass: false, uncertain: true,
          verificationCompleted: false, violations: [finding(2)], initialViolations: [finding(2)], usage: error.usage };
        throw error;
      }
      return primary(call);
    };
    state.delay = call => (!call.strong && call.section === 2 ? 20 : 0);
    const earlier = await run(SOURCE, { receiptStore: receipts.createReceiptStore(), stagedConfirmation: true });
    assert.equal(earlier.reports[1].stagedConfirmation, 'incomplete');
    assert.equal(earlier.reports[1].pass, true, 'first completed verdict stands');
    assert.deepEqual(earlier.reports[1].violations, []);
    assert.ok(earlier.reports[1].initialViolations.some(v => v.sourceSpan === finding(2).sourceSpan));
    assert.ok(earlier.usage.estimatedUsd >= 0.07 + 4 * 0.01 - 1e-9, 'interrupted usage kept');
    assert.equal(earlier.outputText, docOf(4, { 1: repaired(1) }));
    assert.equal(earlier.stagedConfirmation.complete, false);
  });
});

test('L6: a throw after a paid sweep call keeps usage, first verdict, retained text; no receipt', async () => {
  const src = docOf(2);
  const pairs = headingPairs(src, src, 0);
  const first = pairs.map((p, i) => ({ index: i, pass: true, verificationCompleted: true,
    usage: { estimatedUsd: 0.01 }, initialViolations: [], violations: [] }));
  const diagnostics = staging.createStagingDiagnostics(true);
  diagnostics.required = true;
  let recorded = 0;
  const result = await staging.runConfirmationSweep({
    source: src, pairs, outputs: pairs.map(p => p.output), reports: first, obligations: [], diagnostics,
    buildPairs: (s, o) => headingPairs(s, o, 0), signalsFor: () => [], keyFor: (l, i) => `k${i}`,
    store: { lookup: () => null, has: () => false, record: () => { recorded += 1; } }, config,
    judge: async (s, text) => ({ pass: true, outputText: `${text}추가 문장.\n`, usage: { estimatedUsd: 0.2 },
      initialViolations: [finding(1)] }),
    pairMaxRounds: () => 1,
    restoreBoundary: (before, after) => { if (after !== before) throw new Error('synthetic post-call failure'); return after; },
    addUsage: (a, b) => ({ estimatedUsd: (a?.estimatedUsd || 0) + (b?.estimatedUsd || 0) }),
    mapWithConcurrency: async (items, n, fn) => { for (const item of items) await fn(item); },
    reserve: () => true
  });
  assert.deepEqual(result.outputs, pairs.map(p => p.output));
  assert.ok(result.reports.every(r => r.stagedConfirmation === 'incomplete' && r.pass === true));
  assert.ok(result.reports.every(r => Math.abs(r.usage.estimatedUsd - 0.21) < 1e-9));
  assert.ok(result.reports.every(r => r.initialViolations.length === 1 && r.violations.length === 0));
  assert.equal(recorded, 0);
  assert.equal(diagnostics.sweepIncomplete, 2);
  assert.equal(diagnostics.complete, false);
});

test('L8: grounding keeps only findings on the retained text; repair findings are evidence', () => {
  const retained = '가 나 다 원래 문장.';
  const onInput = { type: 'distortion', candidateSpan: '원래 문장' };
  const onRepair = { type: 'distortion', candidateSpan: '수리 문장' };
  const omission = { type: 'omission', sourceSpan: '원문 구절' };
  const accepted = staging.groundFailureOnRetained({ pass: false, outputText: '가 나 다 수리 문장.',
    initialViolations: [onInput, omission], violations: [onRepair] }, retained, retained);
  assert.deepEqual(accepted.violations, [onInput, omission]);
  assert.ok(accepted.initialViolations.includes(onRepair));
  const same = staging.groundFailureOnRetained({ pass: false, outputText: retained,
    initialViolations: [onInput], violations: [onInput, onRepair] }, retained, retained);
  assert.deepEqual(same.violations, [onInput]);
  assert.ok(same.initialViolations.includes(onRepair));
});
