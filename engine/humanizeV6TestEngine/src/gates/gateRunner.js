const { analyzeRisk, contentOverlap } = require('../analysis/riskScorer');
const { missingProtectedTerms } = require('../analysis/protectedTerms');
const { getBasicStats, splitLines, charCountNoSpace } = require('../analysis/textStats');
const { analyzeSpeakerProfile, speakerShift } = require('../analysis/speakerProfile');
const { analyzeEffectiveChange, thresholdsForRisk } = require('../analysis/effectiveChange');
const { findGrammarIssues } = require('../analysis/grammarQuality');
const { analyzeFactRoleDrift } = require('../analysis/factRole');

function runGates({ sourceText, outputText, sourceRisk, protectedTerms, policy, mode = 'full_single_call', blockIssues = [] }) {
  const afterRisk = analyzeRisk(outputText, policy);
  const gates = [];
  gates.push(protectedTermsGate(protectedTerms, outputText, policy));
  gates.push(structureGate(sourceText, outputText, policy));
  gates.push(lengthGate(sourceText, outputText, policy));
  gates.push(contentOverlapGate(sourceText, outputText, policy));
  gates.push(styleRegressionGate(sourceRisk, afterRisk, policy));
  gates.push(riskScoreGate(sourceRisk, afterRisk, policy, mode));
  gates.push(effectiveChangeGate(sourceText, outputText, sourceRisk, policy, mode));
  gates.push(speakerShiftGate(sourceText, outputText));
  gates.push(blockProtocolGate(blockIssues));
  gates.push(grammarQualityGate(outputText, policy));
  gates.push(factRoleDriftGate(sourceText, outputText, protectedTerms, sourceRisk, policy));

  const hardFailures = gates.filter(g => !g.pass && g.severity === 'hard');
  const softFailures = gates.filter(g => !g.pass && g.severity !== 'hard');
  const passed = hardFailures.length === 0 && softFailures.length === 0;
  return {
    passed,
    hardFailed: hardFailures.length > 0,
    limited: !passed && hardFailures.length === 0,
    gates,
    sourceRisk,
    afterRisk
  };
}

function protectedTermsGate(terms, outputText, policy) {
  const missing = missingProtectedTerms(terms, outputText);
  const severeMissing = missing.filter(t => isSevereTerm(t));
  const fail = policy.hardFailOnProtectedTermLoss ? severeMissing.length > 0 : missing.length > 3;
  return {
    name: 'protected_terms',
    pass: !fail,
    severity: 'hard',
    missing: missing.slice(0, 30),
    severeMissing: severeMissing.slice(0, 30),
    detail: fail ? 'protected_term_loss_detected' : 'ok'
  };
}

function isSevereTerm(t) {
  return /\d|[A-Za-z]|[·/()]|^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|^\d+\./.test(t) || t.length >= 8;
}

function structureGate(sourceText, outputText, policy) {
  const b = getBasicStats(sourceText);
  const a = getBasicStats(outputText);
  const reasons = [];
  if (b.headings.length >= 2 && a.headings.length < Math.ceil(b.headings.length * 0.75)) {
    reasons.push(`heading_count_dropped:${b.headings.length}->${a.headings.length}`);
  }
  if (b.listLineCount >= 2 && a.listLineCount < Math.ceil(b.listLineCount * 0.7)) {
    reasons.push(`list_lines_dropped:${b.listLineCount}->${a.listLineCount}`);
  }
  if (b.paragraphCount >= 6 && a.paragraphCount < Math.ceil(b.paragraphCount * (policy.maxParagraphShrinkRatio || 0.72))) {
    reasons.push(`paragraphs_merged:${b.paragraphCount}->${a.paragraphCount}`);
  }
  const merged = detectHeadingMerge(sourceText, outputText);
  if (merged.length) reasons.push(`heading_merged:${merged.slice(0, 3).join('|')}`);
  return {
    name: 'structure',
    pass: reasons.length === 0,
    severity: 'hard',
    reasons,
    detail: reasons.length ? 'structure_loss_detected' : 'ok'
  };
}

function detectHeadingMerge(sourceText, outputText) {
  const headings = splitLines(sourceText)
    .map(l => l.trim())
    .filter(l => l && l.length <= 48 && (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|^\d+\.\s*/.test(l) || (!/[.!?。！？]$/.test(l) && /[가-힣A-Za-z]/.test(l))));
  const out = String(outputText || '');
  const merged = [];
  for (const h of headings) {
    const idx = out.indexOf(h);
    if (idx < 0) {
      merged.push(`${h}:missing`);
      continue;
    }
    const prev = out[idx - 1] || '\n';
    const next = out[idx + h.length] || '\n';
    if (prev !== '\n' || (next !== '\n' && next !== '\r')) merged.push(h);
  }
  return merged;
}

function lengthGate(sourceText, outputText, policy) {
  const before = charCountNoSpace(sourceText);
  const after = charCountNoSpace(outputText);
  const ratio = before ? after / before : 1;
  const min = policy.minLengthRatio || 0.84;
  const max = policy.maxLengthRatio || 1.18;
  return {
    name: 'length',
    pass: ratio >= min && ratio <= max,
    severity: ratio < 0.72 || ratio > 1.35 ? 'hard' : 'soft',
    ratio: round(ratio),
    bounds: [min, max],
    detail: ratio < min ? 'too_short' : ratio > max ? 'too_long' : 'ok'
  };
}

function contentOverlapGate(sourceText, outputText, policy) {
  const overlap = contentOverlap(sourceText, outputText);
  const min = policy.minContentOverlap || 0.58;
  return {
    name: 'content_overlap',
    pass: overlap >= min,
    severity: overlap < min * 0.82 ? 'hard' : 'soft',
    overlap: round(overlap),
    min,
    detail: overlap >= min ? 'ok' : 'content_drift_risk'
  };
}

function styleRegressionGate(sourceRisk, afterRisk, policy) {
  const reasons = [];
  const b = sourceRisk.components;
  const a = afterRisk.components;
  if (a.formulaic > b.formulaic + (policy.maxFormulaicIncrease || 0.025)) reasons.push('formulaic_increased');
  if (a.repetition > b.repetition + (policy.maxRepetitionIncrease || 0.018)) reasons.push('repetition_increased');
  if (a.uniformity > b.uniformity + 0.05) reasons.push('uniformity_increased');
  if (a.abstractness > b.abstractness + 0.06 && a.anchorDensity <= b.anchorDensity) reasons.push('abstractness_increased_without_anchor');
  if (a.impersonal > b.impersonal + 0.05) reasons.push('impersonal_increased');
  return {
    name: 'style_regression',
    pass: reasons.length === 0,
    severity: reasons.length >= 2 ? 'hard' : 'soft',
    reasons,
    detail: reasons.length ? 'surface_risk_regression' : 'ok'
  };
}

function riskScoreGate(sourceRisk, afterRisk, policy, mode = 'full_single_call') {
  const before = sourceRisk.score;
  const after = afterRisk.score;
  const high = policy.highRiskThreshold || 0.62;
  const low = policy.lowRiskThreshold || 0.28;
  const targetDrop = mode === 'patch_single_call' ? (policy.patchModeTargetRiskDrop || 0.012) : (policy.targetRiskDrop || 0.035);
  let pass = true;
  let detail = 'ok';
  let severity = 'soft';
  if (before <= low) {
    if (after > before + 0.015) { pass = false; detail = 'low_risk_worsened'; severity = 'hard'; }
  } else if (before >= high) {
    if (after > before - targetDrop) { pass = false; detail = 'insufficient_risk_drop'; severity = after > before ? 'hard' : 'soft'; }
  } else {
    if (after > before - targetDrop * 0.5) { pass = false; detail = after > before ? 'risk_worsened' : 'limited_risk_drop'; severity = after > before ? 'hard' : 'soft'; }
  }
  return {
    name: 'surrogate_risk',
    pass,
    severity,
    before: round(before),
    after: round(after),
    delta: round(after - before),
    detail
  };
}



function effectiveChangeGate(sourceText, outputText, sourceRisk, policy, mode = 'full_single_call') {
  if (!policy.effectiveChange || policy.effectiveChange.enabled === false) {
    return { name: 'effective_change', pass: true, severity: 'soft', detail: 'disabled' };
  }
  const m = analyzeEffectiveChange(sourceText, outputText, policy);
  const t = thresholdsForRisk(sourceRisk, policy);

  // Patch mode only rewrites selected blocks, so whole-document change is expected to be lower.
  const patchFactor = mode === 'patch_single_call' ? 0.58 : 1;
  const minChar = t.minCharChange * patchFactor;
  const minSentence = t.minSentenceChangedRatio * patchFactor;
  const minParagraph = t.minParagraphChangedRatio * patchFactor;

  const reasons = [];
  if (m.charChange < minChar) reasons.push(`char_change_too_low:${m.charChange}<${round(minChar)}`);
  if (m.sentenceChangedRatio < minSentence) reasons.push(`sentence_change_too_low:${m.sentenceChangedRatio}<${round(minSentence)}`);
  if (m.paragraphChangedRatio < minParagraph && m.beforeParagraphCount >= 3) reasons.push(`paragraph_change_too_low:${m.paragraphChangedRatio}<${round(minParagraph)}`);

  // Too much change is a hard drift risk, because this engine is not allowed to expand or rewrite into a new text.
  if (m.charChange > t.maxCharChange) reasons.push(`char_change_too_high:${m.charChange}>${t.maxCharChange}`);
  if (m.sentenceChangedRatio > t.maxSentenceChangedRatio && m.beforeSentenceCount >= 8) reasons.push(`sentence_change_too_high:${m.sentenceChangedRatio}>${t.maxSentenceChangedRatio}`);

  const tooMuch = reasons.some(r => r.includes('too_high'));
  return {
    name: 'effective_change',
    pass: reasons.length === 0,
    severity: tooMuch ? 'hard' : 'soft',
    metrics: m,
    thresholds: { ...t, minCharChangeApplied: round(minChar), minSentenceChangedRatioApplied: round(minSentence), minParagraphChangedRatioApplied: round(minParagraph) },
    reasons,
    detail: reasons.length ? (tooMuch ? 'possible_drift_or_overwrite' : 'too_similar_to_source') : 'ok'
  };
}

function speakerShiftGate(sourceText, outputText) {
  const before = analyzeSpeakerProfile(sourceText);
  const after = analyzeSpeakerProfile(outputText);
  const reasons = speakerShift(before, after);
  return {
    name: 'speaker_shift',
    pass: reasons.length === 0,
    severity: reasons.length ? 'hard' : 'soft',
    before,
    after,
    reasons,
    detail: reasons.length ? 'speaker_or_ending_shift_detected' : 'ok'
  };
}

function blockProtocolGate(blockIssues) {
  const issues = Array.isArray(blockIssues) ? blockIssues.filter(Boolean) : [];
  return {
    name: 'longdoc_block_protocol',
    pass: issues.length === 0,
    severity: issues.length ? 'hard' : 'soft',
    issues: issues.slice(0, 20),
    detail: issues.length ? 'block_protocol_violation' : 'ok'
  };
}


function grammarQualityGate(outputText, policy) {
  const issues = findGrammarIssues(outputText);
  return {
    name: 'grammar_quality',
    pass: issues.length === 0,
    severity: issues.length ? 'hard' : 'soft',
    issues: issues.slice(0, 20),
    detail: issues.length ? 'orphan_connective_or_broken_sentence_detected' : 'ok'
  };
}

function factRoleDriftGate(sourceText, outputText, protectedTerms, sourceRisk, policy) {
  if (policy.semanticGuards && policy.semanticGuards.enabled === false) {
    return { name: 'fact_role_drift', pass: true, severity: 'soft', detail: 'disabled' };
  }
  const result = analyzeFactRoleDrift(sourceText, outputText, protectedTerms, {
    maxSafeSentenceDistance: policy.semanticGuards?.maxSafeSentenceDistance ?? 0
  });
  const issues = result.issues || [];
  const grade = sourceRisk && sourceRisk.grade;
  const hard = issues.some(i => i.severityHint === 'hard') && (grade === 'high' || grade === 'medium' || (policy.semanticGuards && policy.semanticGuards.hardFailOnRelationMix));
  return {
    name: 'fact_role_drift',
    pass: issues.length === 0,
    severity: hard ? 'hard' : 'soft',
    issues: issues.slice(0, policy.semanticGuards?.maxIssuesInDiagnostics || 20),
    detail: issues.length ? 'unverified_cross_sentence_relation_mix' : 'ok'
  };
}

function round(x) { return Math.round(Number(x || 0) * 1000) / 1000; }

module.exports = { runGates };
