'use strict';

const compat = require('../engine-gpt-prod/compat');
const judge = require('../engine-gpt-prod/judge');
const { publicGenreConfig, GENRES } = require('./genres');
const { normalizeInput, buildLedger, factsheet } = require('./ledger');
const { evaluatePolicy } = require('./policy');
const { assessSufficiency, scaleForMode } = require('./sufficiency');
const {
  WRITER_TOOL,
  buildClaimPlan,
  writerSystemPrompt,
  writerUserPrompt
} = require('./prompt');
const {
  assembleDraft,
  deterministicChecks,
  releaseReport
} = require('./checks');
const { buildDeterministicProjection } = require('./projection');

class WritingEngineError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'WritingEngineError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function config() {
  return {
    version: 'gp-writing-engine-v1',
    genres: publicGenreConfig(),
    statuses: ['READY', 'LIMITED', 'NEEDS_FACTS', 'POLICY_REVIEW', 'POLICY_BLOCKED'],
    choices: ['generate', 'add_facts', 'write_short', 'edit', 'cancel'],
    lengthContract: { minimumRatio: 0.88, maximumRatio: 1 }
  };
}

function prepare(body = {}) {
  const input = normalizeInput(body);
  const { ledger } = buildLedger(input);
  const policy = evaluatePolicy(input, ledger);
  const assessment = assessSufficiency(input, ledger, policy);
  return { engineVersion: 'gp-writing-engine-v1', input, ledger, policy, assessment };
}

async function generate(body = {}, options = {}) {
  const prepared = prepare(body);
  const shortMode = options.shortMode === true || body.shortMode === true;
  ensureGeneratable(prepared, shortMode);
  const targetChars = chooseTarget(prepared, shortMode);
  const claimPlan = buildClaimPlan(prepared.input, prepared.ledger);
  const deps = {
    callWriter: options.callWriter || defaultCallWriter,
    semanticVerify: options.semanticVerify || defaultSemanticVerify,
    semanticRepair: options.semanticRepair || (options.semanticVerify ? null : defaultSemanticRepair)
  };
  const attempts = [];
  const maximumAttempts = Math.max(1, Math.min(3, Number(options.maximumAttempts) || 2));
  let structured = null;
  let evaluated = null;
  let best = null;
  let repairContext = null;
  let writerError = null;
  for (let attemptIndex = 0; attemptIndex < maximumAttempts; attemptIndex += 1) {
    try {
      structured = await deps.callWriter({
        input: prepared.input,
        ledger: prepared.ledger,
        claimPlan,
        targetChars,
        repairContext,
        attemptIndex
      });
    } catch (error) {
      writerError = error;
      attempts.push({
        stage: attemptIndex === 0 ? 'writer_unavailable' : `repair_${attemptIndex}_unavailable`,
        pass: false,
        reasons: ['writer_unavailable'],
        errorCode: safeErrorCode(error)
      });
      break;
    }
    evaluated = await evaluateCandidate(structured, prepared, targetChars, deps.semanticVerify);
    evaluated = await confirmCandidatePass(evaluated, prepared, targetChars, deps.semanticVerify, 'draft');
    attempts.push(summarizeAttempt(attemptIndex === 0 ? 'draft' : `repair_${attemptIndex}`, evaluated));
    if (evaluated.release.pass) break;
    for (let semanticRound = 0; semanticRound < 2; semanticRound += 1) {
      const semanticRecovered = await maybeRepairSemantic(evaluated, prepared, targetChars, deps, attemptIndex, semanticRound);
      if (!semanticRecovered) break;
      evaluated = semanticRecovered;
      structured = semanticRecovered.structured;
      evaluated = await confirmCandidatePass(evaluated, prepared, targetChars, deps.semanticVerify, 'draft_repair');
      attempts.push(summarizeAttempt(`semantic_repair_${attemptIndex + 1}_${semanticRound + 1}`, evaluated));
      if (evaluated.release.pass) break;
    }
    if (evaluated.release.pass) break;
    if (!best || candidatePenalty(evaluated) < candidatePenalty(best)) best = evaluated;
    repairContext = buildRepairContext(best, attemptIndex + 1);
  }

  if ((!evaluated || !evaluated.release.pass) && options.deterministicProjection !== false) {
    const projected = buildDeterministicProjection(prepared, targetChars);
    if (projected) {
      const projectionEvaluation = evaluateProjection(projected, prepared, targetChars);
      attempts.push(summarizeAttempt('deterministic_projection', projectionEvaluation));
      if (projectionEvaluation.release.pass) {
        evaluated = projectionEvaluation;
        structured = projected.structured;
      }
    }
  }

  if (!evaluated) {
    throw new WritingEngineError(
      'WRITER_UNAVAILABLE',
      '문장 생성 엔진에 연결하지 못했어요. 입력 내용은 보존됐으며 크레딧과 생성 한도는 사용되지 않았어요.',
      502,
      { writerErrorCode: safeErrorCode(writerError), attempts }
    );
  }

  if (!evaluated.release.pass) {
    if (best && candidatePenalty(best) < candidatePenalty(evaluated)) evaluated = best;
    throw new WritingEngineError(
      'DRAFT_VERIFICATION_FAILED',
      '근거·분량 검수를 모두 통과한 글을 만들지 못했어요. 입력을 보완하면 크레딧 차감 없이 다시 시도할 수 있어요.',
      422,
      {
        assessment: prepared.assessment,
        checks: evaluated.checks,
        release: evaluated.release,
        semantic: {
          pass: evaluated.semantic?.pass === true,
          error: evaluated.semantic?.error || null,
          violations: (evaluated.semantic?.violations || []).slice(0, 12)
        },
        attempts
      }
    );
  }

  const usedFacts = prepared.ledger.facts
    .filter(fact => evaluated.checks.structure.referencedFactIds.includes(fact.id))
    .map(fact => ({ id: fact.id, label: fact.label, value: fact.value, categories: fact.categories }));
  return {
    ok: true,
    engineVersion: 'gp-writing-engine-v1',
    genre: prepared.input.genre,
    subtype: prepared.input.subtype,
    draft: evaluated.text,
    structured,
    claimPlan,
    usedFacts,
    usedFactIds: usedFacts.map(fact => fact.id),
    followupQuestions: prepared.assessment.suggestions,
    factsheet: factsheet(prepared.ledger),
    ledger: prepared.ledger,
    assessment: { ...prepared.assessment, effectiveTarget: targetChars, shortMode },
    policy: prepared.policy,
    checks: evaluated.checks,
    semantic: evaluated.semantic,
    release: evaluated.release,
    attempts,
    humanize: {
      documentProfile: GENRES[prepared.input.genre].documentProfile,
      basicStyle: GENRES[prepared.input.genre].basicStyle,
      sourceContract: 'preserve_verified_draft'
    }
  };
}

async function maybeRepairSemantic(evaluated, prepared, targetChars, deps, attemptIndex, semanticRound) {
  if (!deps.semanticRepair || evaluated?.release?.pass === true) return null;
  const violations = finalizationViolations(evaluated).filter(item => item?.spanVerified !== false);
  if (!violations.length) return null;
  const factIds = evaluated.checks.structure.referencedFactIds;
  const repairedText = await deps.semanticRepair({
    input: prepared.input,
    ledger: prepared.ledger,
    factIds,
    text: evaluated.text,
    violations,
    attemptIndex,
    semanticRound
  });
  if (!repairedText || String(repairedText).trim() === evaluated.text.trim()) return null;
  const repairedStructured = structuredFromText(repairedText, factIds, prepared.ledger);
  const repaired = await evaluateCandidate(repairedStructured, prepared, targetChars, deps.semanticVerify);
  return { ...repaired, structured: repairedStructured };
}

function structuredFromText(text, factIds, ledger) {
  const allowed = new Set((ledger?.facts || []).map(fact => fact.id));
  const refs = [...new Set((factIds || []).filter(id => allowed.has(id)))];
  const paragraphs = String(text || '').trim().split(/\n\s*\n/gu).filter(Boolean).map(value => ({
    sentences: [{ text: value.trim(), kind: 'fact', factRefs: refs }]
  }));
  return { paragraphs, omittedFactIds: [], followupQuestions: [] };
}

function buildRepairContext(evaluated, repairNumber) {
  const length = evaluated.checks?.length || {};
  const desired = length.applicable
    ? Math.max(length.minimum, Math.min(length.maximum, Math.floor(length.maximum * 0.96)))
    : null;
  return {
    repairNumber,
    previousDraft: evaluated.text,
    hardIssues: hardIssueSummary(evaluated.checks),
    lengthInstruction: length.applicable ? {
      current: length.used,
      minimum: length.minimum,
      maximum: length.maximum,
      desired,
      exactChangeNeeded: desired - length.used,
      message: `${length.used}자인 이전 후보 전체를 고쳐 ${length.minimum}~${length.maximum}자, 가능하면 ${desired}자 안팎으로 맞춘다.`
    } : null,
    semanticViolations: (evaluated.semantic?.violations || []).slice(0, 12),
    semanticError: evaluated.semantic?.error || null,
    releaseReasons: evaluated.release.reasons
  };
}

function candidatePenalty(evaluated) {
  const checks = evaluated?.checks || {};
  const lengthGap = (checks.length?.under || 0) + (checks.length?.over || 0);
  return (checks.structure?.issues?.length || 0) * 10_000
    + (checks.numbers?.added?.length || 0) * 8_000
    + (checks.meta?.found?.length || 0) * 8_000
    + (checks.policy?.violations?.length || 0) * 10_000
    + (evaluated?.semantic?.pass === true ? 0 : 5_000 + (evaluated?.semantic?.violations?.length || 0) * 1_000)
    + lengthGap;
}

async function verifyExisting(text, context, options = {}) {
  if (!context?.ledger || !context?.input) {
    throw new WritingEngineError('VERIFICATION_CONTEXT_REQUIRED', '검수 기준이 만료됐어요. 입력 화면에서 다시 만들어 주세요.', 400);
  }
  const value = String(text || '').trim().slice(0, 12000);
  if (!value) throw new WritingEngineError('TEXT_REQUIRED', '검사할 글을 입력해 주세요.', 400);
  const targetChars = Number(context.targetChars || context.input.targetChars || 0);
  const checks = deterministicChecks({
    text: value,
    structured: null,
    ledger: context.ledger,
    targetChars,
    charLimitMode: context.input.charLimitMode,
    policy: context.policy
  });
  const semanticVerify = options.semanticVerify || defaultSemanticVerify;
  const factIds = Array.isArray(context.usedFactIds) && context.usedFactIds.length
    ? context.usedFactIds
    : context.ledger.facts.map(fact => fact.id);
  const signedSafeDraft = ['semantic_consensus_v1', 'deterministic_projection_v1'].includes(context.safeDraftRelease)
    && value === String(context.safeDraft || '').trim();
  let semantic;
  if (!checks.hardPass) semantic = { pass: false, skipped: 'hard_checks_failed', violations: [] };
  else if (signedSafeDraft) semantic = { pass: true, signedSafeDraft: true, confirmations: 2, violations: [] };
  else {
    const first = await semanticVerify({ input: context.input, ledger: context.ledger, factIds, text: value, phase: 'final' });
    if (first.pass !== true || options.confirmSemantic === false) semantic = first;
    else {
      const confirmation = await semanticVerify({ input: context.input, ledger: context.ledger, factIds, text: value, phase: 'final_confirm' });
      semantic = confirmation.pass === true
        ? { ...first, pass: true, confirmations: 2, confirmation: semanticConfirmationSummary(confirmation) }
        : { ...confirmation, pass: false, confirmations: 2, initialPass: true };
    }
  }
  const release = releaseReport(checks, semantic);
  return { ok: true, checks, semantic, release };
}

async function confirmCandidatePass(evaluated, prepared, targetChars, semanticVerify, phase) {
  if (evaluated?.release?.pass !== true) return evaluated;
  const factIds = evaluated.checks.structure.referencedFactIds;
  const confirmation = await semanticVerify({
    input: prepared.input,
    ledger: prepared.ledger,
    factIds,
    text: evaluated.text,
    phase: `${phase}_confirm`
  });
  const semantic = confirmation.pass === true
    ? { ...evaluated.semantic, pass: true, confirmations: 2, confirmation: semanticConfirmationSummary(confirmation) }
    : { ...confirmation, pass: false, confirmations: 2, initialPass: true };
  return { ...evaluated, semantic, release: releaseReport(evaluated.checks, semantic) };
}

function semanticConfirmationSummary(report) {
  return {
    pass: report?.pass === true,
    violationCount: report?.violations?.length || 0,
    ...(report?.gptMeta ? { gptMeta: report.gptMeta } : {})
  };
}

async function finalizeExisting(text, context, options = {}) {
  const semanticVerify = options.semanticVerify || defaultSemanticVerify;
  const semanticRepair = options.semanticRepair || (options.semanticVerify ? null : defaultSemanticRepair);
  const maximumRepairRounds = Math.max(0, Math.min(2, Number(options.maximumRepairRounds ?? 2)));
  const attempts = [];
  let candidate = String(text || '').trim().slice(0, 12000);
  let report = await verifyExisting(candidate, context, { semanticVerify });
  attempts.push(finalizationAttempt('humanized', candidate, report));

  if (report.release.pass) {
    return finalizationResult(candidate, report, {
      source: 'humanized', repaired: false, fallbackUsed: false, repairRounds: 0
    }, attempts);
  }

  const factIds = Array.isArray(context?.usedFactIds) && context.usedFactIds.length
    ? context.usedFactIds
    : (context?.ledger?.facts || []).map(fact => fact.id);
  if (semanticRepair) {
    for (let round = 0; round < maximumRepairRounds; round += 1) {
      const violations = finalizationViolations(report);
      if (!violations.length) break;
      let repairedText;
      try {
        repairedText = await semanticRepair({
          input: context.input,
          ledger: context.ledger,
          factIds,
          text: candidate,
          violations,
          attemptIndex: 0,
          semanticRound: round
        });
      } catch (error) {
        attempts.push({
          stage: `repair_${round + 1}_unavailable`,
          pass: false,
          reasons: ['repair_unavailable'],
          length: Array.from(candidate).length,
          semanticViolationCount: report?.semantic?.violations?.length || 0,
          errorCode: safeErrorCode(error)
        });
        break;
      }
      const next = String(repairedText || '').trim().slice(0, 12000);
      if (!next || next === candidate) break;
      candidate = next;
      report = await verifyExisting(candidate, context, { semanticVerify });
      attempts.push(finalizationAttempt(`repair_${round + 1}`, candidate, report));
      if (report.release.pass) {
        return finalizationResult(candidate, report, {
          source: 'humanized_repaired', repaired: true, fallbackUsed: false, repairRounds: round + 1
        }, attempts);
      }
    }
  }

  const safeDraft = String(context?.safeDraft || '').trim().slice(0, 12000);
  if (safeDraft) {
    const fallbackReport = await verifyExisting(safeDraft, context, { semanticVerify });
    attempts.push(finalizationAttempt('verified_generation_fallback', safeDraft, fallbackReport));
    if (fallbackReport.release.pass) {
      return finalizationResult(safeDraft, fallbackReport, {
        source: 'verified_generation_fallback', repaired: false, fallbackUsed: true,
        repairRounds: Math.max(0, attempts.length - 2)
      }, attempts, report);
    }
  }

  return finalizationResult(candidate, report, {
    source: 'blocked', repaired: attempts.some(item => item.stage.startsWith('repair_')),
    fallbackUsed: false, repairRounds: Math.max(0, attempts.length - 1)
  }, attempts);
}

function finalizationViolations(report) {
  const violations = (report?.semantic?.violations || [])
    .filter(item => item?.spanVerified !== false)
    .map(item => ({ ...item }));
  const length = report?.checks?.length || {};
  if (length.applicable && !length.pass) {
    violations.push({
      type: length.status === 'under' ? 'length_under' : 'length_over',
      span: '',
      detail: length.status === 'under'
        ? `현재 ${length.used}자를 확인된 사실만으로 ${length.minimum}~${length.maximum}자에 맞추세요. 새 사실 없이 원문에 있는 빠진 내용을 복원하세요.`
        : `현재 ${length.used}자를 확인된 사실만 남겨 ${length.minimum}~${length.maximum}자로 줄이세요.`
    });
  }
  for (const token of report?.checks?.numbers?.addedTokens || []) {
    violations.push({ type: 'unsupported_number', span: token, detail: `SOURCE에 없는 수치 ${token}을 삭제하거나 SOURCE의 정확한 수치로 되돌리세요.` });
  }
  for (const phrase of report?.checks?.meta?.found || []) {
    violations.push({ type: 'meta_filler', span: phrase, detail: '정보 부족을 설명하는 문구를 삭제하고 확인된 사실만 남기세요.' });
  }
  for (const issue of report?.checks?.structure?.issues || []) {
    violations.push({ type: 'claim_structure', span: '', detail: JSON.stringify(issue) });
  }
  for (const item of report?.checks?.policy?.violations || []) {
    violations.push({ type: 'policy', span: item.phrase || '', detail: item.message || item.code || '정책 위반 표현을 제거하세요.' });
  }
  return violations.slice(0, 16);
}

function finalizationAttempt(stage, text, report) {
  return {
    stage,
    pass: report?.release?.pass === true,
    reasons: report?.release?.reasons || [],
    length: Array.from(String(text || '')).length,
    semanticViolationCount: report?.semantic?.violations?.length || 0
  };
}

function finalizationResult(text, report, delivery, attempts, rejectedReport = null) {
  return {
    ...report,
    text,
    delivery: { ...delivery, releasePass: report?.release?.pass === true },
    attempts,
    ...(rejectedReport ? { rejectedReport } : {})
  };
}

async function evaluateCandidate(structured, prepared, targetChars, semanticVerify) {
  const text = assembleDraft(structured);
  const checks = deterministicChecks({
    text,
    structured,
    ledger: prepared.ledger,
    targetChars,
    charLimitMode: prepared.input.charLimitMode,
    policy: prepared.policy
  });
  const semantic = checks.hardPass
    ? await semanticVerify({
      input: prepared.input,
      ledger: prepared.ledger,
      factIds: checks.structure.referencedFactIds,
      text,
      phase: 'draft'
    })
    : { pass: false, skipped: 'hard_checks_failed', violations: [] };
  const release = releaseReport(checks, semantic);
  return { text, checks, semantic, release };
}

function evaluateProjection(projected, prepared, targetChars) {
  const structured = projected.structured;
  const text = assembleDraft(structured);
  const checks = deterministicChecks({
    text,
    structured,
    ledger: prepared.ledger,
    targetChars,
    charLimitMode: prepared.input.charLimitMode,
    policy: prepared.policy
  });
  const semantic = checks.hardPass && projected.proof?.pass === true
    ? {
        pass: true,
        deterministicProjection: true,
        proof: projected.proof.proof,
        confirmations: 2,
        factIds: projected.proof.factIds,
        violations: []
      }
    : {
        pass: false,
        deterministicProjection: true,
        error: projected.proof?.code || 'projection_hard_check_failed',
        violations: []
      };
  return { text, checks, semantic, release: releaseReport(checks, semantic) };
}

function ensureGeneratable(prepared, shortMode) {
  const { status } = prepared.assessment;
  if (!prepared.policy.canGenerate) {
    throw new WritingEngineError(
      status === 'POLICY_BLOCKED' ? 'POLICY_BLOCKED' : 'POLICY_REVIEW_REQUIRED',
      prepared.assessment.summary,
      400,
      { assessment: prepared.assessment, policy: prepared.policy }
    );
  }
  if (status === 'NEEDS_FACTS') {
    throw new WritingEngineError('MORE_FACTS_REQUIRED', prepared.assessment.summary, 409, { assessment: prepared.assessment });
  }
  if (status === 'LIMITED' && !shortMode) {
    throw new WritingEngineError('SHORT_MODE_CONFIRMATION_REQUIRED', prepared.assessment.summary, 409, { assessment: prepared.assessment });
  }
}

function chooseTarget(prepared, shortMode) {
  const range = prepared.assessment.feasibleRange;
  if (shortMode) {
    const factCount = Math.max(1, prepared.assessment.confirmedFactCount || 1);
    // 희소 입력 두 항목에 60자를 강제하면 같은 장소·결제를 반복하게 된다.
    // 안전 범위 하단에서 사실 수만큼만 늘려 짧지만 자연스러운 문장을 우선한다.
    const baseShortTarget = 32 + Math.min(68, factCount * 9);
    const shortTarget = Math.max(
      range.min,
      Math.min(range.max, range.recommended, scaleForMode(baseShortTarget, prepared.input.charLimitMode))
    );
    return Math.round(shortTarget);
  }
  return prepared.assessment.requestedTarget;
}

async function defaultCallWriter({ input, ledger, claimPlan, targetChars, repairContext, attemptIndex = 0 }) {
  const data = await compat.callGpt({
    userText: writerUserPrompt(input, ledger, claimPlan, targetChars, repairContext),
    systemText: writerSystemPrompt(input, targetChars, { repair: !!repairContext }),
    tool: WRITER_TOOL,
    maxOutputTokens: 7000,
    task: 'humanize_writing_engine_generate',
    phase: repairContext ? `repair_${attemptIndex}` : 'main',
    mode: `wl_v2_${input.genre}`,
    verbosity: 'medium'
  });
  return compat.extractGptResult(data, WRITER_TOOL.name);
}

async function defaultSemanticVerify({ input, ledger, factIds, text, phase }) {
  const source = factsheet(ledger, factIds);
  if (!source) return { pass: false, violations: [{ type: 'added_claim', span: text.slice(0, 120), detail: '검수할 근거가 없습니다.' }] };
  const sourceLedger = {
    claims: (ledger.facts || [])
      .filter(fact => factIds.includes(fact.id))
      .map(fact => ({ claim: `${fact.label}: ${fact.value}`, evidence_text: `[${fact.id}][${fact.label}] ${fact.value}` }))
  };
  try {
    return await judge.semanticJudge(source, text, sourceLedger, {
      lang: 'ko',
      mode: `writing_${input.genre}`,
      phase: `writing_lab_${phase}`
    });
  } catch (error) {
    return { pass: false, error: error?.message || 'semantic_check_failed', violations: [] };
  }
}

async function defaultSemanticRepair({ input, ledger, factIds, text, violations, attemptIndex, semanticRound = 0 }) {
  const source = factsheet(ledger, factIds);
  const sourceLedger = {
    claims: (ledger.facts || [])
      .filter(fact => factIds.includes(fact.id))
      .map(fact => ({ claim: `${fact.label}: ${fact.value}`, evidence_text: `[${fact.id}][${fact.label}] ${fact.value}` }))
  };
  const repaired = await judge.repairViolations(source, text, sourceLedger, violations, {
    lang: 'ko',
    phase: `writing_lab_local_repair_${attemptIndex + 1}_${semanticRound + 1}`,
    mode: `writing_${input.genre}`
  });
  return String(repaired?.outputText || '').trim();
}

function hardIssueSummary(checks) {
  const issues = [];
  for (const item of checks?.structure?.issues || []) issues.push(item);
  if (!checks?.numbers?.pass) issues.push({ code: 'UNSUPPORTED_NUMBERS', tokens: checks.numbers.addedTokens });
  if (!checks?.meta?.pass) issues.push({ code: 'META_FILLER', phrases: checks.meta.found });
  if (!checks?.length?.pass) issues.push({ code: `LENGTH_${String(checks?.length?.status || 'FAILED').toUpperCase()}`, length: checks.length });
  if (!checks?.policy?.pass) issues.push({ code: 'POLICY', violations: checks.policy.violations });
  return issues.slice(0, 20);
}

function safeErrorCode(error) {
  const value = String(error?.code || error?.name || 'ENGINE_UNAVAILABLE').replace(/[^A-Z0-9_.-]/giu, '_');
  return value.slice(0, 80) || 'ENGINE_UNAVAILABLE';
}

function summarizeAttempt(stage, evaluated) {
  return {
    stage,
    pass: evaluated.release.pass,
    reasons: evaluated.release.reasons,
    length: evaluated.checks.length,
    unsupportedNumbers: evaluated.checks.numbers.addedTokens,
    metaPhrases: evaluated.checks.meta.found,
    semanticViolationCount: evaluated.semantic?.violations?.length || 0
  };
}

module.exports = {
  WritingEngineError,
  config,
  prepare,
  generate,
  verifyExisting,
  finalizeExisting,
  chooseTarget,
  defaultSemanticVerify,
  defaultSemanticRepair,
  defaultCallWriter,
  structuredFromText
};
