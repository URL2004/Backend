'use strict';

// Administrator-only shadow audit. This module never contributes prompt text,
// candidate selection, delivery decisions, or billing decisions to the
// production humanizer.
function attachQualityPatternAudit(out, source, { mode = '', register = '' } = {}) {
  if (!out?.result?.outputText) return out;
  const qualityPattern = require('../engine/koreanQuality/qualityPatternLab');
  const protectedTerms = collectProtectedTerms(out.result.records);
  const audit = qualityPattern.buildAudit(source, out.result.outputText, {
    mode,
    register,
    protectedTerms,
    externalApiHintsUsed: false
  });
  const compact = qualityPattern.compactAudit(audit);
  out.result.qualityPatternLab = {
    enabled: true,
    auditOnly: true,
    version: compact?.version || qualityPattern.VERSION,
    action: compact?.auditTrail?.action || 'pass',
    externalApiHintsUsed: false
  };
  out.result.qualityProfileBefore = compact?.qualityProfileBefore || null;
  out.result.qualityProfileAfter = compact?.qualityProfileAfter || null;
  out.result.patternDelta = compact?.patternDelta || null;
  out.result.auditTrail = compact?.auditTrail || null;
  out.result.protectedTermReport = compact?.protectedTermReport || null;
  out.result.claimStrengthDrift = compact?.claimStrengthDrift || null;
  out.result.rhetoricalInsertion = compact?.rhetoricalInsertion || null;
  out.result.grammarHardError = compact?.grammarHardError || null;
  out.result.externalApiHintsUsed = false;
  return out;
}

function collectProtectedTerms(records = []) {
  const seen = new Set();
  const terms = [];
  for (const record of Array.isArray(records) ? records : []) {
    for (const raw of Array.isArray(record?.protectedTerms) ? record.protectedTerms : []) {
      const value = String(raw || '').trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      terms.push(value);
      if (terms.length >= 160) return terms;
    }
  }
  return terms;
}

module.exports = { attachQualityPatternAudit, collectProtectedTerms };
