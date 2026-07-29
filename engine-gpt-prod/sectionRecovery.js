'use strict';

const humanizationDepth = require('./humanizationDepth');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');
const {
  classifyModelFailure,
  isNonEscalatableModelFailureCode
} = require('./modelFailure');
const safeEditAccumulator = require('./safeEditAccumulator');
const { mapWithConcurrency } = require('./concurrency');

const MIN_DOCUMENT_CHARS = 2000;
const MIN_SECTION_CHARS = 1200;
// 제목이 촘촘한 보고서·논문은 절마다 청크가 1,200자보다 짧아 기존 회복기가
// 한 번도 실행되지 않았다. 잠긴 제목은 그대로 두고, 의미 있는 산문 조각만
// 남은 슬롯에 보조 후보로 넣는다.
const MIN_FRAGMENT_CHARS = 180;
const MAX_SECTION_CHARS = 2500;
const MAX_MINI_ATTEMPTS = 8;
const MAX_TARGET_ONLY_ATTEMPTS = 4;
// 절대 상한은 기존 계약대로 2개를 유지하되 운영 기본값은 1개다. mini에서
// 실질 이득이 확인되거나 충분히 긴 핵심 절이 완전 무변환인 경우만 승격한다.
const MAX_ESCALATIONS = 2;
const DEFAULT_MAX_ESCALATIONS = 1;
const RECOVERY_CONCURRENCY = 3;
const MIN_ESCALATION_CHARS = 600;
const MIN_ESCALATION_GAIN = 0.025;

function isEnabled() {
  return isV248FeatureEnabled('sectionRecovery');
}

function configuredMaxEscalations() {
  const raw = Number(process.env.HUMANIZE_SECTION_ESCALATION_MAX);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_ESCALATIONS;
  return Math.max(0, Math.min(MAX_ESCALATIONS, Math.floor(raw)));
}

function selectRecoverySections(chunks, {
  sourceLength = 0,
  mode = '',
  requestStrength = 'basic',
  documentProfile = null,
  inputRisk = null
} = {}) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  if (!isEnabled()
      || Number(sourceLength) < MIN_DOCUMENT_CHARS
      || mode === 'polish'
      || profile === 'creative') return [];

  const candidates = (chunks || [])
    .map((chunk, index) => {
      const source = String(chunk?.text || '').trim();
      const output = String(chunk?.outputText ?? chunk?.text ?? '').trim();
      const chars = source.length;
      if (chunk?.locked || chars < MIN_FRAGMENT_CHARS || chars > MAX_SECTION_CHARS) return null;
      const plan = humanizationDepth.buildHumanizationPlan(source, {
        requestStrength,
        documentProfile,
        inputRisk
      });
      const report = humanizationDepth.evaluateHumanizationDepth(source, output, plan);
      if (!humanizationDepth.needsHumanizationRecovery(report)) return null;
      const targetOnly = report.pass === true;
      return {
        index,
        source,
        output,
        chars,
        selectionKind: chars >= MIN_SECTION_CHARS ? 'section' : 'fragment',
        sectionPath: String(chunk?.sectionPath || ''),
        plan,
        report,
        targetOnly,
        targetGap: humanizationDepth.targetDepthGap(report),
        priority: recoveryPriority(report)
      };
    })
    .filter(Boolean);
  const byPriority = (left, right) => right.priority - left.priority || left.index - right.index;
  const required = candidates.filter(item => item.targetOnly !== true);
  const targetOnly = candidates.filter(item => item.targetOnly === true);
  const order = values => [
    ...values.filter(item => item.selectionKind === 'section').sort(byPriority),
    ...values.filter(item => item.selectionKind === 'fragment').sort(byPriority)
  ];
  const selectedRequired = order(required).slice(0, MAX_MINI_ATTEMPTS);
  const remaining = Math.max(0, MAX_MINI_ATTEMPTS - selectedRequired.length);
  const selectedTargetOnly = order(targetOnly).slice(
    0,
    Math.min(MAX_TARGET_ONLY_ATTEMPTS, remaining)
  );
  return [
    ...selectedRequired,
    ...selectedTargetOnly
  ];
}

async function recoverSections({
  chunks,
  sourceLength,
  mode,
  requestStrength,
  documentProfile,
  inputRisk,
  retrySection,
  validateCandidate,
  recoveryBudget = null,
  signal
} = {}) {
  const selected = selectRecoverySections(chunks, {
    sourceLength,
    mode,
    requestStrength,
    documentProfile,
    inputRisk
  });
  const metrics = {
    enabled: isEnabled(),
    // `selected`는 후보 수이고 `attempted`는 실제 mini 모델 호출 수다.
    // 비용 상한으로 wave 중 일부가 생략된 경우 두 값을 같게 기록하면
    // 회복 진입률과 비용 통계가 동시에 부풀려진다.
    attempted: 0,
    applied: 0,
    escalated: 0,
    selectedSectionCount: selected.length,
    selectedPreferredSectionCount: selected.filter(item => item.selectionKind === 'section').length,
    selectedFragmentCount: selected.filter(item => item.selectionKind === 'fragment').length,
    selectedTargetOnlyCount: selected.filter(item => item.targetOnly === true).length,
    miniAttemptCount: 0,
    escalationAttemptCount: 0,
    escalationEligibleCount: 0,
    escalationSkippedCount: 0,
    escalationSkipCodes: [],
    escalationSkipCodeCounts: {},
    escalationMaximum: configuredMaxEscalations(),
    concurrency: RECOVERY_CONCURRENCY,
    sectionIndices: selected.map(item => item.index),
    appliedSectionIndices: [],
    rejectedAttemptCount: 0,
    rejectionCodes: [],
    rejectionCodeCounts: {},
    modelFailureCount: 0,
    modelFailureCodes: [],
    modelFailureCodeCounts: {},
    miniAppliedCount: 0,
    escalationAppliedCount: 0,
    partialAppliedCount: 0,
    partialAppliedSentenceCount: 0,
    partialRejectedSentenceCount: 0,
    partialRejectionCodes: [],
    budgetSkippedCount: 0,
    budgetSkippedCodes: []
  };
  if (!selected.length || typeof retrySection !== 'function') return { metrics, usages: [], selected };

  const usages = [];
  const afterMini = await mapWithConcurrency(selected, RECOVERY_CONCURRENCY, async entry => {
    if (recoveryBudget && !recoveryBudget.canStart()) {
      recoveryBudget.recordSkip('section_depth_recovery');
      metrics.budgetSkippedCount += 1;
      if (!metrics.budgetSkippedCodes.includes('section_depth_recovery')) {
        metrics.budgetSkippedCodes.push('section_depth_recovery');
      }
      return {
        ...entry,
        output: String(chunks?.[entry.index]?.outputText ?? entry.output ?? ''),
        report: entry.report,
        rejectionCode: 'recovery_budget_exhausted',
        budgetSkipped: true,
        marginalGain: 0
      };
    }
    recoveryBudget?.recordAttempt();
    metrics.attempted += 1;
    metrics.miniAttemptCount += 1;
    const attempt = await safeRetry(retrySection, entry, 'mini', signal);
    if (attempt?.usage) {
      usages.push(attempt.usage);
      recoveryBudget?.recordUsage(attempt.usage, 'section_depth_recovery');
    }
    return applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics });
  }, signal);

  const escalationDecisions = afterMini.map(item => ({
    item,
    decision: shouldEscalateRecovery(item)
  }));
  for (const { decision } of escalationDecisions) {
    if (decision.eligible) continue;
    recordEscalationSkip(metrics, decision.code);
  }
  const escalationTargets = escalationDecisions
    .filter(({ decision }) => decision.eligible)
    .map(({ item }) => item)
    .sort((left, right) => recoveryPriority(right.report) - recoveryPriority(left.report))
    .slice(0, metrics.escalationMaximum);
  metrics.escalationEligibleCount = escalationDecisions
    .filter(({ decision }) => decision.eligible).length;
  const eligibleNotSelected = Math.max(0, metrics.escalationEligibleCount - escalationTargets.length);
  for (let index = 0; index < eligibleNotSelected; index += 1) {
    recordEscalationSkip(metrics, 'escalation_budget_exhausted');
  }
  metrics.escalationAttemptCount = 0;
  metrics.escalated = 0;
  await mapWithConcurrency(escalationTargets, Math.min(RECOVERY_CONCURRENCY, metrics.escalationMaximum || 1), async entry => {
    if (recoveryBudget && !recoveryBudget.canStart()) {
      recoveryBudget.recordSkip('section_depth_escalation');
      metrics.budgetSkippedCount += 1;
      if (!metrics.budgetSkippedCodes.includes('section_depth_escalation')) {
        metrics.budgetSkippedCodes.push('section_depth_escalation');
      }
      recordEscalationSkip(metrics, 'recovery_budget_exhausted');
      return entry;
    }
    recoveryBudget?.recordAttempt();
    metrics.escalationAttemptCount += 1;
    metrics.escalated += 1;
    const attempt = await safeRetry(retrySection, entry, 'escalation', signal);
    if (attempt?.usage) {
      usages.push(attempt.usage);
      recoveryBudget?.recordUsage(attempt.usage, 'section_depth_escalation');
    }
    return applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics });
  }, signal);

  return { metrics, usages, selected };
}

async function safeRetry(retrySection, entry, tier, signal) {
  try {
    return { ...(await retrySection({ ...entry, tier })), recoveryTier: tier };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw error;
    }
    const failureCode = classifyModelFailure(error);
    return {
      error: failureCode,
      failureCode,
      nonEscalatableFailure: isNonEscalatableModelFailureCode(failureCode),
      recoveryTier: tier
    };
  }
}

function applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics }) {
  const currentOutput = String(chunks?.[entry.index]?.outputText ?? entry.output ?? '').trim();
  const candidate = String(attempt?.outputText || '').trim();
  const currentReport = humanizationDepth.evaluateHumanizationDepth(entry.source, currentOutput, entry.plan);
  const currentScore = humanizationDepth.humanizationCandidateScore(currentReport);
  if (attempt?.error) {
    const failureCode = String(attempt.failureCode || classifyModelFailure(attempt.error));
    recordRejections(metrics, [failureCode]);
    recordModelFailure(metrics, failureCode);
    return {
      ...entry,
      output: currentOutput,
      report: currentReport,
      rejectionCode: failureCode,
      failureCode,
      marginalGain: 0,
      nonEscalatableFailure: attempt.nonEscalatableFailure === true
        || isNonEscalatableModelFailureCode(failureCode)
    };
  }
  if (!candidate) {
    recordRejections(metrics, ['empty_candidate']);
    return {
      ...entry,
      output: currentOutput,
      report: currentReport,
      rejectionCode: 'empty_candidate',
      marginalGain: 0
    };
  }
  if (candidate === currentOutput) {
    recordRejections(metrics, [attempt?.safeChangeFound === false ? 'no_safe_change' : 'candidate_unchanged']);
    return {
      ...entry,
      output: currentOutput,
      report: currentReport,
      rejectionCode: attempt?.safeChangeFound === false ? 'no_safe_change' : 'candidate_unchanged',
      marginalGain: 0
    };
  }
  const candidateReport = humanizationDepth.evaluateHumanizationDepth(entry.source, candidate, entry.plan);
  const candidateGain = humanizationDepth.humanizationCandidateScore(candidateReport) - currentScore;
  const validation = typeof validateCandidate === 'function'
    ? validateCandidate({ entry, currentOutput, candidate, currentReport, candidateReport, attempt })
    : true;
  const safe = validation === true || validation?.pass === true;
  const better = humanizationDepth.isBetterHumanizationCandidate(currentReport, candidateReport);
  if (safe && better && chunks?.[entry.index]) {
    chunks[entry.index].outputText = candidate;
    metrics.applied += 1;
    if (attempt?.recoveryTier === 'escalation') metrics.escalationAppliedCount += 1;
    else metrics.miniAppliedCount += 1;
    if (!metrics.appliedSectionIndices.includes(entry.index)) metrics.appliedSectionIndices.push(entry.index);
    return {
      ...entry,
      output: candidate,
      report: candidateReport,
      applied: true,
      marginalGain: candidateGain
    };
  }
  const partial = safeEditAccumulator.accumulateSafeEdits({
    source: entry.source,
    current: currentOutput,
    candidate,
    plan: entry.plan,
    currentReport,
    evaluateDepth: value => humanizationDepth.evaluateHumanizationDepth(entry.source, value, entry.plan),
    validateCandidate: trial => (
      typeof validateCandidate === 'function'
        ? validateCandidate({
            entry,
            currentOutput,
            candidate: trial,
            currentReport,
            candidateReport: humanizationDepth.evaluateHumanizationDepth(entry.source, trial, entry.plan),
            attempt,
            partial: true
          })
        : true
    )
  });
  if (partial.applied && chunks?.[entry.index]) {
    chunks[entry.index].outputText = partial.outputText;
    metrics.applied += 1;
    metrics.partialAppliedCount += 1;
    metrics.partialAppliedSentenceCount += Number(partial.appliedCount || 0);
    metrics.partialRejectedSentenceCount += Number(partial.rejectedCount || 0);
    for (const code of partial.rejectedCodes || []) {
      if (!metrics.partialRejectionCodes.includes(code)) metrics.partialRejectionCodes.push(code);
    }
    if (attempt?.recoveryTier === 'escalation') metrics.escalationAppliedCount += 1;
    else metrics.miniAppliedCount += 1;
    if (!metrics.appliedSectionIndices.includes(entry.index)) metrics.appliedSectionIndices.push(entry.index);
    return {
      ...entry,
      output: partial.outputText,
      report: partial.report,
      applied: true,
      partialApplied: true,
      partialAppliedSentenceCount: partial.appliedCount,
      marginalGain: humanizationDepth.humanizationCandidateScore(partial.report) - currentScore
    };
  }
  metrics.partialRejectedSentenceCount += Number(partial.rejectedCount || 0);
  for (const code of partial.rejectedCodes || []) {
    if (!metrics.partialRejectionCodes.includes(code)) metrics.partialRejectionCodes.push(code);
  }
  const rejectionCodes = !safe
    ? normalizeRejectionCodes(validation?.codes || validation?.reasons || ['safety_audit_failed'])
    : ['not_better'];
  recordRejections(metrics, rejectionCodes);
  return {
    ...entry,
    output: currentOutput,
    report: currentReport,
    rejectionCode: rejectionCodes[0] || 'safety_audit_failed',
    rejectionCodes,
    safetyRejected: !safe,
    marginalGain: 0
  };
}

function shouldEscalateRecovery(entry) {
  if (!entry || entry.report?.pass === true) return { eligible: false, code: 'already_passed' };
  if (entry.budgetSkipped === true) return { eligible: false, code: 'recovery_budget_exhausted' };
  if (entry.nonEscalatableFailure === true) return { eligible: false, code: 'non_escalatable_failure' };
  if (Number(entry.chars || entry.source?.length || 0) < MIN_ESCALATION_CHARS) {
    return { eligible: false, code: 'section_too_small' };
  }
  if (entry.safetyRejected === true || isSafetyRejectionCode(entry.rejectionCode)) {
    return { eligible: false, code: 'unsafe_mini_candidate' };
  }
  const reasons = new Set(entry.report?.reasons || []);
  const severe = [
    'rhetorical_remediation_low',
    'substantive_carryover_high',
    'risk_target_coverage_low',
    'structural_rewrite_coverage_low',
    'paragraph_rewrite_coverage_low',
    'resume_semantic_repetition_low',
    'source_semantic_redundancy_low'
  ].some(code => reasons.has(code))
    || entry.report?.minimumEffectPass === false;
  if (!severe) return { eligible: false, code: 'non_critical_shortfall' };
  if (entry.applied === true) {
    return Number(entry.marginalGain || 0) >= MIN_ESCALATION_GAIN
      ? { eligible: true, code: 'mini_gain_remaining_shortfall' }
      : { eligible: false, code: 'mini_gain_too_small' };
  }
  if (['candidate_unchanged', 'no_safe_change', 'not_better'].includes(entry.rejectionCode)
      && Number(entry.chars || entry.source?.length || 0) >= MIN_SECTION_CHARS) {
    return { eligible: true, code: 'long_section_no_effect' };
  }
  return { eligible: false, code: 'mini_not_escalation_worthy' };
}

function isSafetyRejectionCode(code) {
  return [
    'number_changed',
    'semantic_shift',
    'structure_loss',
    'quote_loss',
    'pov_shift',
    'protected_term_loss',
    'voice_shift',
    'safety_audit_failed',
    'korean_integrity',
    'semantic_relation_shift',
    'ending_style_shift',
    'partial_safety_audit_failed'
  ].includes(String(code || ''));
}

function recordEscalationSkip(metrics, code) {
  const safeCode = String(code || 'not_eligible');
  metrics.escalationSkippedCount = Number(metrics.escalationSkippedCount || 0) + 1;
  metrics.escalationSkipCodes = Array.isArray(metrics.escalationSkipCodes)
    ? metrics.escalationSkipCodes
    : [];
  metrics.escalationSkipCodeCounts = metrics.escalationSkipCodeCounts || {};
  metrics.escalationSkipCodeCounts[safeCode] = Number(metrics.escalationSkipCodeCounts[safeCode] || 0) + 1;
  if (!metrics.escalationSkipCodes.includes(safeCode)) metrics.escalationSkipCodes.push(safeCode);
}

function normalizeRejectionCodes(values) {
  const allowed = new Set([
    'empty_candidate', 'candidate_unchanged', 'no_safe_change', 'model_error', 'not_better',
    'edit_range_exceeded', 'length_range_failed', 'number_changed', 'semantic_shift',
    'structure_loss', 'quote_loss', 'pov_shift', 'protected_term_loss', 'voice_shift',
    'safety_audit_failed', 'gpt_call_failed', 'request_aborted',
    'openai_rate_limited', 'openai_server_error', 'openai_timeout',
    'openai_network_error', 'openai_schema_error', 'openai_refusal',
    'openai_truncated_output', 'openai_incomplete_output', 'openai_empty_output',
    'korean_integrity', 'semantic_relation_shift', 'ending_style_shift',
    'partial_safety_audit_failed', 'partial_depth_not_improved'
  ]);
  const codes = [...new Set((Array.isArray(values) ? values : [values])
    .map(value => String(value || '').trim())
    .filter(value => allowed.has(value)))];
  return codes.length ? codes : ['safety_audit_failed'];
}

function recordModelFailure(metrics, code) {
  const safeCode = normalizeRejectionCodes([code])[0];
  metrics.modelFailureCount = Number(metrics.modelFailureCount || 0) + 1;
  metrics.modelFailureCodes = Array.isArray(metrics.modelFailureCodes) ? metrics.modelFailureCodes : [];
  metrics.modelFailureCodeCounts = metrics.modelFailureCodeCounts || {};
  metrics.modelFailureCodeCounts[safeCode] = Number(metrics.modelFailureCodeCounts[safeCode] || 0) + 1;
  if (!metrics.modelFailureCodes.includes(safeCode)) metrics.modelFailureCodes.push(safeCode);
}

function recordRejections(metrics, codes) {
  const safeCodes = normalizeRejectionCodes(codes);
  metrics.rejectedAttemptCount = Number(metrics.rejectedAttemptCount || 0) + 1;
  metrics.rejectionCodeCounts = metrics.rejectionCodeCounts || {};
  metrics.rejectionCodes = Array.isArray(metrics.rejectionCodes) ? metrics.rejectionCodes : [];
  for (const safeCode of safeCodes) {
    metrics.rejectionCodeCounts[safeCode] = Number(metrics.rejectionCodeCounts[safeCode] || 0) + 1;
    if (!metrics.rejectionCodes.includes(safeCode)) metrics.rejectionCodes.push(safeCode);
  }
}

function recoveryPriority(report) {
  const reasons = new Set(report?.reasons || []);
  let value = 1 - humanizationDepth.humanizationCandidateScore(report);
  if (reasons.has('rhetorical_remediation_low')) value += 0.5;
  if (reasons.has('substantive_carryover_high')) value += 0.4;
  if (reasons.has('risk_target_coverage_low')) value += 0.25;
  if (reasons.has('structural_rewrite_coverage_low')) value += 0.2;
  if (reasons.has('source_semantic_redundancy_low')) value += 0.35;
  return value;
}

module.exports = {
  MIN_DOCUMENT_CHARS,
  MIN_SECTION_CHARS,
  MIN_FRAGMENT_CHARS,
  MAX_SECTION_CHARS,
  MAX_MINI_ATTEMPTS,
  MAX_TARGET_ONLY_ATTEMPTS,
  MAX_ESCALATIONS,
  DEFAULT_MAX_ESCALATIONS,
  RECOVERY_CONCURRENCY,
  MIN_ESCALATION_CHARS,
  MIN_ESCALATION_GAIN,
  isEnabled,
  configuredMaxEscalations,
  selectRecoverySections,
  recoverSections,
  mapWithConcurrency,
  shouldEscalateRecovery
};
