'use strict';

const { DEFAULT_THRESHOLDS } = require('./patterns');
const { analyzeText } = require('./detector');
const { compareStyle } = require('./styleConsistency');
const { compactForLog } = require('./promptBlock');

function evaluateKoreanQuality(source, output, opts = {}) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(opts.thresholds || {})
  };
  const before = opts.beforeAnalysis || analyzeText(source, opts);
  const after = opts.afterAnalysis || analyzeText(output, opts);
  const riskDelta = round3((after.koreanSkillRisk || 0) - (before.koreanSkillRisk || 0));
  const grammarHardDelta = Math.max(0, (after.hardGrammarCount || 0) - (before.hardGrammarCount || 0));
  const styleDrift = compareStyle(before.style, after.style);
  const violations = [];
  let action = 'pass';
  let reason = '';
  let blocking = false;

  if (grammarHardDelta > 0) {
    action = 'escalation_candidate';
    reason = 'korean_quality_grammar_regression';
    blocking = true;
    violations.push({
      gate: reason,
      beforeHardGrammar: before.hardGrammarCount || 0,
      afterHardGrammar: after.hardGrammarCount || 0
    });
  } else if (styleDrift.povIntroduced || styleDrift.firstPersonDropped) {
    action = 'escalation_candidate';
    reason = styleDrift.povIntroduced ? 'korean_quality_pov_introduced' : 'korean_quality_pov_dropped';
    blocking = true;
    violations.push({
      gate: reason,
      sourceFirstPerson: before.style?.firstPersonCount || 0,
      outputFirstPerson: after.style?.firstPersonCount || 0
    });
  } else if (styleDrift.registerShiftSevere) {
    action = 'repair_candidate';
    reason = 'korean_quality_register_shift';
    violations.push({
      gate: reason,
      sourceRegister: styleDrift.sourceRegister,
      outputRegister: styleDrift.outputRegister
    });
  } else if (riskDelta >= thresholds.repairDelta) {
    action = 'repair_candidate';
    reason = 'korean_quality_risk_regression';
    violations.push({
      gate: reason,
      riskDelta,
      beforeRisk: round3(before.koreanSkillRisk),
      afterRisk: round3(after.koreanSkillRisk)
    });
  } else if (riskDelta >= thresholds.warningDelta) {
    action = 'warn';
    reason = 'korean_quality_risk_warning';
  }

  return {
    action,
    reason,
    blocking,
    riskDelta,
    grammarHardDelta,
    styleDrift,
    thresholds,
    source: compactForLog(before),
    output: compactForLog(after),
    topKoreanPatterns: after.topPatterns || [],
    violations,
    warnings: buildWarnings(action, reason, riskDelta, after)
  };
}

function buildWarnings(action, reason, riskDelta, after) {
  if (action === 'pass') return [];
  const warnings = [];
  if (action !== 'pass') warnings.push(`korean_quality:${action}`);
  if (reason) warnings.push(reason);
  if (riskDelta > 0) warnings.push(`korean_quality_delta:${riskDelta.toFixed(3)}`);
  for (const p of (after.topPatterns || []).slice(0, 5)) {
    warnings.push(`korean_pattern:${p.id}`);
  }
  return warnings;
}

function round3(v) {
  return Number(Number(v || 0).toFixed(3));
}

module.exports = {
  evaluateKoreanQuality
};
