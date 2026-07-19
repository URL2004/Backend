'use strict';

const humanizationDepth = require('./humanizationDepth');

const MIN_DOCUMENT_CHARS = 2000;
const MIN_SECTION_CHARS = 1200;
const MAX_SECTION_CHARS = 2500;
const MAX_MINI_ATTEMPTS = 8;
const MAX_ESCALATIONS = 2;
const RECOVERY_CONCURRENCY = 3;

function isEnabled() {
  return String(process.env.HUMANIZE_SECTION_RECOVERY_ENABLED || '0').trim() === '1';
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

  return (chunks || [])
    .map((chunk, index) => {
      const source = String(chunk?.text || '').trim();
      const output = String(chunk?.outputText ?? chunk?.text ?? '').trim();
      const chars = source.length;
      if (chunk?.locked || chars < MIN_SECTION_CHARS || chars > MAX_SECTION_CHARS) return null;
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
        sectionPath: String(chunk?.sectionPath || ''),
        plan,
        report,
        priority: recoveryPriority(report)
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, MAX_MINI_ATTEMPTS);
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
    miniAttemptCount: selected.length,
    escalationAttemptCount: 0,
    concurrency: RECOVERY_CONCURRENCY,
    sectionIndices: selected.map(item => item.index),
    appliedSectionIndices: []
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
    return await retrySection({ ...entry, tier });
  } catch (error) {
    return { error: String(error?.code || error?.message || error).slice(0, 120) };
  }
}

function applyIfBetter({ entry, attempt, chunks, validateCandidate, metrics }) {
  const currentOutput = String(chunks?.[entry.index]?.outputText ?? entry.output ?? '').trim();
  const candidate = String(attempt?.outputText || '').trim();
  const currentReport = humanizationDepth.evaluateHumanizationDepth(entry.source, currentOutput, entry.plan);
  if (!candidate || candidate === currentOutput) return { ...entry, output: currentOutput, report: currentReport };
  const candidateReport = humanizationDepth.evaluateHumanizationDepth(entry.source, candidate, entry.plan);
  const safe = typeof validateCandidate === 'function'
    ? validateCandidate({ entry, currentOutput, candidate, currentReport, candidateReport, attempt }) === true
    : true;
  const better = candidateReport.pass === true
    || humanizationDepth.isBetterHumanizationCandidate(currentReport, candidateReport);
  if (safe && better && chunks?.[entry.index]) {
    chunks[entry.index].outputText = candidate;
    metrics.applied += 1;
    if (!metrics.appliedSectionIndices.includes(entry.index)) metrics.appliedSectionIndices.push(entry.index);
    return { ...entry, output: candidate, report: candidateReport, applied: true };
  }
  return { ...entry, output: currentOutput, report: currentReport };
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
  MAX_SECTION_CHARS,
  MAX_MINI_ATTEMPTS,
  MAX_ESCALATIONS,
  RECOVERY_CONCURRENCY,
  isEnabled,
  selectRecoverySections,
  recoverSections,
  mapWithConcurrency
};
