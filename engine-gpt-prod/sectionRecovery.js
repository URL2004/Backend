'use strict';

const humanizationDepth = require('./humanizationDepth');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');

const MIN_DOCUMENT_CHARS = 2000;
const MIN_SECTION_CHARS = 1200;
// 제목이 촘촘한 보고서·논문은 절마다 청크가 1,200자보다 짧아 기존 회복기가
// 한 번도 실행되지 않았다. 잠긴 제목은 그대로 두고, 의미 있는 산문 조각만
// 남은 슬롯에 보조 후보로 넣는다.
const MIN_FRAGMENT_CHARS = 180;
const MAX_SECTION_CHARS = 2500;
const MAX_MINI_ATTEMPTS = 8;
const MAX_ESCALATIONS = 2;
const RECOVERY_CONCURRENCY = 3;

function isEnabled() {
  return isV248FeatureEnabled('sectionRecovery');
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
      if (!report.applicable || report.pass === true) return null;
      return {
        index,
        source,
        output,
        chars,
        selectionKind: chars >= MIN_SECTION_CHARS ? 'section' : 'fragment',
        sectionPath: String(chunk?.sectionPath || ''),
        plan,
        report,
        priority: recoveryPriority(report)
      };
    })
    .filter(Boolean);
  const byPriority = (left, right) => right.priority - left.priority || left.index - right.index;
  const preferred = candidates.filter(item => item.selectionKind === 'section').sort(byPriority);
  const fragments = candidates.filter(item => item.selectionKind === 'fragment').sort(byPriority);
  return [
    ...preferred.slice(0, MAX_MINI_ATTEMPTS),
    ...fragments.slice(0, Math.max(0, MAX_MINI_ATTEMPTS - preferred.length))
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
  validateCandidate
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
    attempted: selected.length,
    applied: 0,
    escalated: 0,
    selectedSectionCount: selected.length,
    selectedPreferredSectionCount: selected.filter(item => item.selectionKind === 'section').length,
    selectedFragmentCount: selected.filter(item => item.selectionKind === 'fragment').length,
    miniAttemptCount: selected.length,
    escalationAttemptCount: 0,
    concurrency: RECOVERY_CONCURRENCY,
    sectionIndices: selected.map(item => item.index),
    appliedSectionIndices: [],
    rejectedAttemptCount: 0,
    rejectionCodes: [],
    rejectionCodeCounts: {},
    miniAppliedCount: 0,
    escalationAppliedCount: 0
  };
  if (!selected.length || typeof retrySection !== 'function') return { metrics, usages: [], selected };

  const usages = [];
  const afterMini = await mapWithConcurrency(selected, RECOVERY_CONCURRENCY, async entry => {
    const attempt = await safeRetry(retrySection, entry, 'mini');
    if (attempt?.usage) usages.push(attempt.usage);
    return applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics });
  });

  const escalationTargets = afterMini
    .filter(item => item.report?.pass !== true)
    .sort((left, right) => recoveryPriority(right.report) - recoveryPriority(left.report))
    .slice(0, MAX_ESCALATIONS);
  metrics.escalationAttemptCount = escalationTargets.length;
  metrics.escalated = escalationTargets.length;
  await mapWithConcurrency(escalationTargets, Math.min(RECOVERY_CONCURRENCY, MAX_ESCALATIONS), async entry => {
    const attempt = await safeRetry(retrySection, entry, 'escalation');
    if (attempt?.usage) usages.push(attempt.usage);
    return applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics });
  });

  return { metrics, usages, selected };
}

async function safeRetry(retrySection, entry, tier) {
  try {
    return { ...(await retrySection({ ...entry, tier })), recoveryTier: tier };
  } catch (error) {
    return {
      error: String(error?.code || error?.message || error).slice(0, 120),
      recoveryTier: tier
    };
  }
}

function applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics }) {
  const currentOutput = String(chunks?.[entry.index]?.outputText ?? entry.output ?? '').trim();
  const candidate = String(attempt?.outputText || '').trim();
  const currentReport = humanizationDepth.evaluateHumanizationDepth(entry.source, currentOutput, entry.plan);
  if (attempt?.error) {
    recordRejections(metrics, ['model_error']);
    return { ...entry, output: currentOutput, report: currentReport, rejectionCode: 'model_error' };
  }
  if (!candidate) {
    recordRejections(metrics, ['empty_candidate']);
    return { ...entry, output: currentOutput, report: currentReport, rejectionCode: 'empty_candidate' };
  }
  if (candidate === currentOutput) {
    recordRejections(metrics, [attempt?.safeChangeFound === false ? 'no_safe_change' : 'candidate_unchanged']);
    return {
      ...entry,
      output: currentOutput,
      report: currentReport,
      rejectionCode: attempt?.safeChangeFound === false ? 'no_safe_change' : 'candidate_unchanged'
    };
  }
  const candidateReport = humanizationDepth.evaluateHumanizationDepth(entry.source, candidate, entry.plan);
  const validation = typeof validateCandidate === 'function'
    ? validateCandidate({ entry, currentOutput, candidate, currentReport, candidateReport, attempt })
    : true;
  const safe = validation === true || validation?.pass === true;
  const better = candidateReport.pass === true
    || humanizationDepth.isBetterHumanizationCandidate(currentReport, candidateReport);
  if (safe && better && chunks?.[entry.index]) {
    chunks[entry.index].outputText = candidate;
    metrics.applied += 1;
    if (attempt?.recoveryTier === 'escalation') metrics.escalationAppliedCount += 1;
    else metrics.miniAppliedCount += 1;
    if (!metrics.appliedSectionIndices.includes(entry.index)) metrics.appliedSectionIndices.push(entry.index);
    return { ...entry, output: candidate, report: candidateReport, applied: true };
  }
  const rejectionCodes = !safe
    ? normalizeRejectionCodes(validation?.codes || validation?.reasons || ['safety_audit_failed'])
    : ['not_better'];
  recordRejections(metrics, rejectionCodes);
  return {
    ...entry,
    output: currentOutput,
    report: currentReport,
    rejectionCode: rejectionCodes[0] || 'safety_audit_failed'
  };
}

function normalizeRejectionCodes(values) {
  const allowed = new Set([
    'empty_candidate', 'candidate_unchanged', 'no_safe_change', 'model_error', 'not_better',
    'edit_range_exceeded', 'length_range_failed', 'number_changed', 'semantic_shift',
    'structure_loss', 'quote_loss', 'pov_shift', 'protected_term_loss', 'voice_shift',
    'safety_audit_failed'
  ]);
  const codes = [...new Set((Array.isArray(values) ? values : [values])
    .map(value => String(value || '').trim())
    .filter(value => allowed.has(value)))];
  return codes.length ? codes : ['safety_audit_failed'];
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
  return value;
}

async function mapWithConcurrency(items, limit, worker) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let cursor = 0;
  async function run() {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(source[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), source.length) }, run));
  return results;
}

module.exports = {
  MIN_DOCUMENT_CHARS,
  MIN_SECTION_CHARS,
  MIN_FRAGMENT_CHARS,
  MAX_SECTION_CHARS,
  MAX_MINI_ATTEMPTS,
  MAX_ESCALATIONS,
  RECOVERY_CONCURRENCY,
  isEnabled,
  selectRecoverySections,
  recoverSections,
  mapWithConcurrency
};
