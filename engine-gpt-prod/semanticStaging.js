'use strict';

// Staged semantic confirmation (request-local, internal, opt-in).
//
// Once a document has a grounded semantic failure, the final re-validation is
// routed confirmation-first for EVERY section ('prior_failed_semantic_
// confirmation', index.js; judge.js). Before this module the first confirming
// verdict on a section that the primary judge passed therefore happened only
// in the verdict-only final, where no repair is possible and every window
// carries discovery, operator questions and obligations at once.
//
// This module moves that required confirming verdict into the earlier,
// REPAIR-CAPABLE document audit:
//   A. sections that start after a grounded failure is known are judged by the
//      configured confirming judge from their first call (judge.js
//      requireConfirmation: same model/effort/maxRounds/repair budget);
//   B. after all sections pass, sections still lacking an exact confirming
//      receipt for the ASSEMBLED document (primary-only peers, or confirming
//      passes minted against a sibling that was later repaired) receive one
//      confirming judge call in the final's exact receipt key shape.
// Receipts minted here are reused by the final only when source, candidate,
// segmentation, both whole neighbours, hints and obligations are identical.
// Nothing here lowers a tier, reuses a primary verdict as confirming, turns a
// failed, uncertain or cancelled confirmation into a pass, or changes the
// final gate. Diagnostics are counts and fixed codes only.
//
// A section report's `stagedConfirmation` status is NOT evidence. Only
// `diagnostics.complete`, computed by exact confirming receipt lookups in the
// final's key shape over the finished document, may let the caller treat the
// required confirmation as done; otherwise the caller must force the final
// confirming verdict (index.js). Every sweep call is optional work: admitted
// per call by the caller's recovery reservation and run under the optional
// call-ledger policy (cost + deadline caps), with the audit's shared repair
// budget. Denied, uncertain, truncated or interrupted confirmation keeps the
// completed first verdict and its exact text, and records no receipt.
//
// Job scope (index.js, createConfirmationRequirement): once any staged audit
// reports `required`, the requirement is sticky for the whole job and
// survives every later report replacement. It is satisfied only by
// confirmationProven(): a passed, completed report whose staged diagnostics
// are complete AND carry exact source/candidate digests of the text being
// delivered, with every section covered. A model name, a section status or a
// report-level flag is never proof. Candidate-ledger fallbacks are subject to
// the same proof, so a fallback can never lower the verdict tier.

const VERSION = 'semantic-staged-confirmation-v1';
// Eligibility is exactly stagingEligible(): a repair-capable audit with a
// receipt store, a distinct confirming model, and 2..4 base heading sections
// used unchanged as the audit plan. No character limit is applied here; any
// other shape (1 section, >4 sections, replanned pairs) keeps the old path.
const MAX_STAGED_SECTIONS = 4;
const SKIP_CODES = new Set(['', 'not_required', 'audit_not_passed', 'aborted', 'reserve_denied',
  'segmentation_changed', 'obligations_not_covered', 'sweep_error']);

function escalationDiffers(config) {
  const models = config?.models || {};
  const escalation = models.judgeEscalation || models.humanizeEscalation || models.judge;
  return Boolean(models.judge && escalation && escalation !== models.judge);
}

function stagingEligible({ stagedConfirmation, allowRepair, store, config, basePairs, pairs } = {}) {
  return stagedConfirmation === true && allowRepair !== false && Boolean(store) && escalationDiffers(config)
    && Array.isArray(basePairs) && basePairs.length >= 2 && basePairs.length <= MAX_STAGED_SECTIONS
    && pairs === basePairs;
}

// The exact evidence shape returned by runSemanticDocumentAudit. The final
// collects obligations from this shape, so staged obligations use it too.
function evidenceAggregate(reports) {
  const list = Array.isArray(reports) ? reports : [];
  return {
    violations: list.filter(r => r?.pass !== true).flatMap(r => r?.violations || []),
    initialViolations: list.flatMap(r => r?.initialViolations || []),
    reports: list,
    restorationNominationReports: list.flatMap(r => r?.restorationNominationReports || []).slice(-8)
  };
}

function documentObligations(source, priorReports, reports) {
  return require('./semanticObligations').collectObligations(source,
    [...(Array.isArray(priorReports) ? priorReports : []), evidenceAggregate(reports)]);
}

function sameSegmentation(expected, actual) {
  return Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length
    && actual.every((pair, index) => pair?.alignment === 'shared_unique_heading'
      && pair.sourceContext === expected[index]?.sourceContext && typeof pair.output === 'string');
}

const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

function mergeSweepReport(first, judged, pair, elapsedMs, addUsage) {
  const passed = judged.pass === true && judged.uncertain !== true && judged.skipped !== true
    && judged.verificationCompleted !== false;
  return {
    ...first,
    sourceStart: pair.sourceStart, sourceEnd: pair.sourceEnd,
    outputStart: pair.outputStart, outputEnd: pair.outputEnd,
    verificationCompleted: judged.skipped !== true && judged.verificationCompleted !== false,
    started: true,
    elapsedMs: (Number(first?.elapsedMs) || 0) + elapsedMs,
    pass: judged.pass === true,
    uncertain: judged.uncertain === true,
    skipped: judged.skipped === true,
    reason: judged.reason || '',
    rounds: (first?.rounds || 0) + (judged.rounds || 0),
    repairRejected: first?.repairRejected === true || judged.repairRejected === true,
    repairRejectReasons: union(first?.repairRejectReasons, judged.repairRejectReasons),
    repairStyleWarnings: union(first?.repairStyleWarnings, judged.repairStyleWarnings),
    unchangedRepairCount: (first?.unchangedRepairCount || 0) + (judged.unchangedRepairCount || 0),
    escalated: first?.escalated === true || judged.escalated === true,
    relationConfirmationFirst: judged.relationConfirmationFirst === true,
    // Earlier findings stay evidence; the confirming verdict is the verdict.
    initialViolations: [...(first?.initialViolations || []), ...(judged.initialViolations || [])],
    violations: judged.violations || [],
    sourceIssues: judged.sourceIssues || [],
    relationContract: judged.relationContract || first?.relationContract || '',
    obligationReviews: judged.obligationReviews || [],
    selectedJudgeModel: judged.selectedJudgeModel || '',
    usage: addUsage(first?.usage || null, judged.usage || null),
    stagedConfirmation: passed ? 'confirmed' : (judged.uncertain === true || judged.skipped === true
      || judged.verificationCompleted === false ? 'uncertain' : 'failed')
  };
}

function createStagingDiagnostics(eligible) {
  return {
    version: VERSION,
    eligible: eligible === true,
    required: false,
    skipReason: eligible === true ? '' : 'not_required',
    earlyConfirmedSections: 0,
    sweepSections: 0,
    sweepReused: 0,
    sweepJudged: 0,
    sweepConfirmed: 0,
    sweepFailed: 0,
    sweepUncertain: 0,
    sweepIncomplete: 0,
    sweepDenied: 0,
    preparedSections: 0,
    // True only when every section of the finished document has an exact
    // confirming receipt in the final's key shape.
    complete: false
  };
}

function skip(diagnostics, code) {
  diagnostics.skipReason = SKIP_CODES.has(code) ? code : 'sweep_error';
  return diagnostics;
}

// Completed findings from a verdict that did not finish (thrown, uncertain,
// truncated). They are appended ONLY to initialViolations (nomination and
// obligation evidence), never to `violations`. This bypasses the
// verificationCompleted filter in semanticObligations, whose only effect is
// MORE obligations for the confirming final; it can never produce a pass.
function unfinishedEvidence(report) {
  if (!report || typeof report !== 'object') return [];
  return [...(Array.isArray(report.initialViolations) ? report.initialViolations : []),
    ...(Array.isArray(report.violations) ? report.violations : [])];
}

// A completed confirming failure keeps the retained (unadopted) text. Only
// findings of a judge that saw that exact text, and whose quoted candidate
// span exists in it, are the verdict. Findings about a failed repair
// proposal (or spans absent from the retained text) stay evidence only.
function groundFailureOnRetained(judged, judgedInput, retained) {
  const sawRetained = judged?.outputText == null || judged.outputText === judgedInput
    ? (judged?.violations || []) : (judged?.initialViolations || []);
  const onRetained = v => typeof v?.candidateSpan !== 'string' || !v.candidateSpan
    || String(retained).includes(v.candidateSpan);
  const violations = sawRetained.filter(onRetained);
  const evidence = [...(judged?.violations || []), ...sawRetained]
    .filter((v, i, all) => !violations.includes(v) && all.indexOf(v) === i);
  return { ...judged, violations,
    initialViolations: [...(judged?.initialViolations || []), ...evidence.filter(v =>
      !(judged?.initialViolations || []).includes(v))] };
}

function digestOf(value) {
  return require('./semanticProvenance').textDigest(value);
}

// Bind a complete confirmation to the exact audited source and candidate.
function bindProof(diagnostics, { source, candidate, sections, report }) {
  if (!diagnostics) return diagnostics;
  delete diagnostics.provenSourceDigest;
  delete diagnostics.provenCandidateDigest;
  delete diagnostics.provenSections;
  if (diagnostics.required === true && diagnostics.complete === true && report?.pass === true
      && report.verificationCompleted === true && Number.isInteger(sections) && sections >= 2
      && typeof source === 'string' && typeof candidate === 'string') {
    diagnostics.provenSourceDigest = digestOf(source);
    diagnostics.provenCandidateDigest = digestOf(candidate);
    diagnostics.provenSections = sections;
  } else {
    diagnostics.complete = false;
  }
  return diagnostics;
}

// The ONLY staged proof the caller may accept for skipping the forced final
// or for a fallback candidate: exact digests of the text actually delivered.
function confirmationProven(report, { source, candidate } = {}) {
  try {
    const d = report?.stagedConfirmation;
    if (!d || typeof d !== 'object' || d.version !== VERSION) return false;
    if (d.required !== true || d.complete !== true) return false;
    if (report.pass !== true || report.verificationCompleted !== true || report.uncertain === true) return false;
    if (!Number.isInteger(d.provenSections) || d.provenSections < 2) return false;
    if (Array.isArray(report.reports) && report.reports.length !== d.provenSections) return false;
    if (typeof source !== 'string' || typeof candidate !== 'string') return false;
    return d.provenSourceDigest === digestOf(source) && d.provenCandidateDigest === digestOf(candidate);
  } catch {
    return false;
  }
}

// Job-scoped sticky requirement. Never cleared; satisfied per text by proof.
function createConfirmationRequirement() {
  let required = false;
  const requirement = {
    get required() { return required; },
    require() { required = true; },
    note(report) {
      if (report?.stagedConfirmation?.required === true) required = true;
      return required;
    },
    // True when the final confirming verdict must run for this exact text.
    pending(report, { source, candidate, preliminaryStatus } = {}) {
      requirement.note(report);
      return required && !(preliminaryStatus === 'pass' && confirmationProven(report, { source, candidate }));
    },
    // A fallback may never lower the tier: when required, only an entry whose
    // own report proves confirmation of that entry's exact text qualifies.
    allowsFallback(entry, { source } = {}) {
      if (!required) return true;
      return entry?.semanticStatus === 'pass'
        && confirmationProven(entry.semanticReport, { source, candidate: entry?.text });
    }
  };
  return requirement;
}

// B. Confirmation sweep over the assembled document. Every dependency is
// injected by runSemanticDocumentAudit so the key, signals, obligations and
// judge options are exactly those of that audit (and of the later final).
async function runConfirmationSweep({
  source, pairs, outputs, reports, obligations, diagnostics, priorReports = [],
  buildPairs, prepareCandidateText = null, signalsFor, keyFor, store, config,
  judge, judgeOptions = {}, pairMaxRounds, restoreBoundary, signal, addUsage,
  mapWithConcurrency, reserve = null, withOptionalPolicy = fn => fn(), now = Date.now
}) {
  const result = { outputs: [...outputs], reports: [...reports], diagnostics };
  // This function does not reject. Each section mapper handles its own
  // post-call failures (usage and completed findings kept, see below); this
  // outer catch covers only unexpected pre-call failures (segmentation,
  // formatting) and fails closed: complete stays false.
  try {
    await sweep();
  } catch {
    skip(diagnostics, 'sweep_error');
  }
  try { diagnostics.complete = diagnostics.skipReason === '' && confirmedAsFinal(); } catch { diagnostics.complete = false; }
  return result;

  function confirmedAsFinal() {
    const finished = buildPairs(source, result.outputs.join(''));
    if (!sameSegmentation(pairs, finished)) return false;
    const current = documentObligations(source, priorReports, result.reports);
    if (!current.every(o => finished.some(pair => pair.sourceContext.includes(o.finding.sourceSpan)))) return false;
    return finished.every((pair, index) => {
      const given = current.filter(o => finished.length === 1 || pair.sourceContext.includes(o.finding.sourceSpan))
        .map(o => o.finding);
      const key = keyFor(finished, index, signalsFor(pair, finished.length));
      return Boolean(key) && store.has(key, { route: 'confirmation_first', obligations: given });
    });
  }

  async function sweep() {
  let sweepPairs = buildPairs(source, outputs.join(''));
  if (!sameSegmentation(pairs, sweepPairs)) { skip(diagnostics, 'segmentation_changed'); return; }
  // Settle the existing semantic-audit formatting BEFORE any key is built, so
  // a receipt binds the text that will actually continue down the pipeline.
  if (typeof prepareCandidateText === 'function') {
    const prepared = [];
    for (const pair of sweepPairs) {
      let text = pair.output;
      try { text = await prepareCandidateText(pair.sourceContext, pair.output); } catch { text = pair.output; }
      prepared.push(typeof text === 'string' && text.trim() ? restoreBoundary(pair.output, text) : pair.output);
    }
    if (prepared.some((text, index) => text !== sweepPairs[index].output)) {
      const rebuilt = buildPairs(source, prepared.join(''));
      if (sameSegmentation(pairs, rebuilt) && rebuilt.every((pair, index) => pair.output === prepared[index])) {
        diagnostics.preparedSections = prepared.filter((text, index) => text !== sweepPairs[index].output).length;
        sweepPairs = rebuilt;
      }
    }
  }
  if (!obligations.every(o => sweepPairs.some(pair => pair.sourceContext.includes(o.finding.sourceSpan)))) {
    skip(diagnostics, 'obligations_not_covered');
    return;
  }
  diagnostics.sweepSections = sweepPairs.length;
  const givenFor = pair => obligations
    .filter(o => sweepPairs.length === 1 || pair.sourceContext.includes(o.finding.sourceSpan)).map(o => o.finding);
  const collect = require('./semanticObligations').collectObligations;
  await mapWithConcurrency(sweepPairs.map((pair, index) => ({ pair, index })), 2, async ({ pair, index }) => {
    const startedAt = now();
    const first = reports[index];
    const given = givenFor(pair);
    let signals = null, key = '', hit = null;
    try {
      signals = signalsFor(pair, sweepPairs.length);
      key = keyFor(sweepPairs, index, signals);
      hit = key ? store.lookup(key, { route: 'confirmation_first', obligations: given }) : null;
    } catch { signals = signals || null; hit = null; }
    if (hit) {
      // An exact confirming verdict already covers this text in this context.
      result.outputs[index] = pair.output;
      result.reports[index] = { ...first, obligationReviews: (hit.obligationReviews || []).map(r => ({ ...r })),
        selectedJudgeModel: hit.selectedJudgeModel, stagedConfirmation: 'receipt' };
      diagnostics.sweepReused += 1;
      return;
    }
    // No confirmation: the completed first-pass verdict and its exact text
    // stand unchanged; the final still requires its own confirming verdict.
    // Completed findings of an unfinished confirmation stay as evidence.
    const incomplete = (usage, findings = []) => {
      result.outputs[index] = outputs[index];
      result.reports[index] = { ...first, usage: addUsage(first?.usage || null, usage || null),
        initialViolations: [...(first?.initialViolations || []), ...findings],
        stagedConfirmation: 'incomplete' };
      diagnostics.sweepIncomplete += 1;
    };
    if (!signals || signal?.aborted) { incomplete(null); return; }
    if (typeof reserve === 'function' && reserve() !== true) {
      diagnostics.sweepDenied += 1;
      incomplete(null);
      return;
    }
    let judged;
    try {
      diagnostics.sweepJudged += 1;
      judged = await withOptionalPolicy(() => judge(pair.sourceContext, pair.output, {
        ...judgeOptions,
        priorReports: [{ violations: given }],
        signal,
        config,
        maxRounds: pairMaxRounds(pair),
        discourseSignals: signals,
        prepareCandidateText: null,
        requireConfirmation: true
      }));
    } catch (error) {
      // judge.js folds earlier usage of the same chain into error.usage.
      incomplete(error?.usage || error?.partialSemanticReport?.usage || null,
        unfinishedEvidence(error?.partialSemanticReport));
      return;
    }
    // Post-call handling must never lose the paid call: any throw below
    // becomes 'incomplete' with this call's usage and completed findings.
    let settled = false;
    try {
      const judgedText = judged?.outputText == null ? pair.output : judged.outputText;
      const passed = judged?.pass === true && judged.uncertain !== true && judged.skipped !== true
        && judged.verificationCompleted !== false;
      const completedFailure = !passed && judged?.pass === false && judged.uncertain !== true
        && judged.skipped !== true && judged.verificationCompleted !== false;
      if (!passed && !completedFailure) {
        // Uncertain, skipped or truncated: not a verdict. Keep the first one.
        settled = true;
        incomplete(judged?.usage || null, unfinishedEvidence(judged));
        diagnostics.sweepUncertain += 1;
        return;
      }
      let adopted = outputs[index];
      let verdict = judged;
      if (passed) {
        adopted = restoreBoundary(pair.output, judgedText);
        try {
          if (typeof judgedText === 'string' && adopted === judgedText) {
            const list = judgedText === pair.output ? sweepPairs
              : sweepPairs.map((p, i) => i === index ? { ...p, output: judgedText } : p);
            store.record(keyFor(list, index, signals), judged, { sourceContext: pair.sourceContext,
              candidate: judgedText, config,
              obligations: collect(pair.sourceContext, [{ violations: given },
                { initialViolations: judged.initialViolations || [] }]).map(o => o.finding) });
          }
        } catch { /* a receipt is optional; never affects the verdict */ }
      } else {
        // A completed confirming failure is the verdict, but only a passed
        // text replaces the candidate; a failed repair is never adopted and
        // its findings are evidence, not a verdict on the retained text.
        verdict = groundFailureOnRetained(judged, pair.output, adopted);
      }
      const merged = mergeSweepReport(first, verdict, passed ? pair : first,
        Math.max(0, now() - startedAt), addUsage);
      settled = true;
      result.outputs[index] = adopted;
      result.reports[index] = merged;
      if (passed) diagnostics.sweepConfirmed += 1;
      else diagnostics.sweepFailed += 1;
    } catch {
      if (!settled) {
        try { incomplete(judged?.usage || null, unfinishedEvidence(judged)); } catch { /* keep first */ }
      }
    }
  });
  }
}

module.exports = {
  VERSION,
  MAX_STAGED_SECTIONS,
  escalationDiffers,
  stagingEligible,
  evidenceAggregate,
  documentObligations,
  sameSegmentation,
  mergeSweepReport,
  createStagingDiagnostics,
  unfinishedEvidence,
  groundFailureOnRetained,
  bindProof,
  confirmationProven,
  createConfirmationRequirement,
  runConfirmationSweep
};
