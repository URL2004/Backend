'use strict';

const VERSION = 'candidate-ledger-v1';

// Priority 2 owns language, register and readability. Every other deterministic
// warning is conservatively treated as priority 1 until it is explicitly
// classified here. This makes newly-added safety audits fail closed instead of
// silently becoming a style preference.
const LANGUAGE_WARNING_CODES = new Set([
  'ending_style_mixed',
  'engine_phrase_fingerprint',
  'paragraph_readability',
  'paragraph_structure_changed',
  'register_shift',
  'repetition',
  'sentence_distribution_shift'
]);

function createCandidateLedger({ enabled = true, assess } = {}) {
  if (enabled && typeof assess !== 'function') {
    throw new TypeError('candidate ledger requires an assess function');
  }
  const entries = [];
  let sequence = 0;
  let selection = emptySelection(enabled);

  function record({
    stage,
    text,
    semanticReport = null,
    artifacts = null,
    baseline = false
  } = {}) {
    if (!enabled) return null;
    const value = String(text || '');
    const semantic = semanticStatus(semanticReport, { baseline });
    let assessment;
    let assessmentError = '';
    if (baseline) {
      assessment = normalizeAssessment({
        hardViolationCodes: [],
        languageViolationCodes: [],
        languageRisk: 0,
        minimumEffectPass: false,
        transformed: false,
        depthSnapshot: null
      });
    } else {
      try {
        assessment = normalizeAssessment(assess({
          stage,
          text: value,
          semanticReport
        }));
      } catch (error) {
        assessmentError = safeError(error);
        assessment = normalizeAssessment({
          hardViolationCodes: ['candidate_assessment_error'],
          languageViolationCodes: [],
          languageRisk: 0,
          minimumEffectPass: false,
          transformed: false,
          depthSnapshot: null
        });
      }
    }
    const hardViolationCodes = uniqueCodes(assessment.hardViolationCodes);
    const entry = {
      id: `${String(stage || 'candidate').slice(0, 48)}:${sequence + 1}`,
      sequence: ++sequence,
      stage: String(stage || 'candidate').slice(0, 48),
      text: value,
      semanticStatus: semantic.status,
      semanticRank: semantic.rank,
      semanticReport: cloneSerializable(semanticReport),
      hardViolationCodes,
      hardRisk: hardViolationCodes.length,
      languageViolationCodes: uniqueCodes(assessment.languageViolationCodes),
      languageRisk: round4(assessment.languageRisk),
      minimumEffectPass: assessment.minimumEffectPass === true,
      transformed: assessment.transformed === true,
      depthSnapshot: cloneSerializable(assessment.depthSnapshot),
      depthScore: round4(assessment.depthSnapshot?.score),
      depthPass: assessment.depthSnapshot?.pass === true,
      targetDepthMet: assessment.depthSnapshot?.targetDepthMet === true,
      substantiveEditRatio: round4(assessment.depthSnapshot?.substantiveEditRatio),
      eligible: false,
      assessmentError,
      artifacts: cloneSerializable(artifacts)
    };
    entry.eligible = entry.transformed
      && entry.minimumEffectPass
      && entry.hardRisk === 0
      && entry.semanticStatus === 'pass';
    entries.push(entry);
    return entry;
  }

  function chooseFinal(currentId) {
    if (!enabled) return { ...selection, entry: null };
    const current = entries.find(entry => entry.id === currentId) || entries[entries.length - 1] || null;
    if (!current) {
      selection = {
        ...emptySelection(true),
        reason: 'no_current_candidate'
      };
      return { ...selection, entry: null };
    }
    const eligible = entries.filter(entry => entry.eligible);
    const best = eligible.reduce((winner, candidate) => (
      !winner || compareCandidatePriority(candidate, winner) > 0 ? candidate : winner
    ), null);
    if (!best) {
      selection = {
        enabled: true,
        applied: false,
        currentStage: current.stage,
        selectedStage: current.stage,
        reason: 'no_safe_transformed_candidate',
        currentHardViolationCodes: [...current.hardViolationCodes],
        currentSemanticStatus: current.semanticStatus
      };
      return { ...selection, entry: current };
    }
    const improvement = compareCandidatePriority(best, current);
    const applied = best.id !== current.id && improvement > 0;
    const selected = applied ? best : current;
    selection = {
      enabled: true,
      applied,
      currentStage: current.stage,
      selectedStage: selected.stage,
      reason: applied
        ? selectionReason(best, current)
        : (current.eligible ? 'current_candidate_is_best' : 'no_strictly_better_candidate'),
      currentHardViolationCodes: [...current.hardViolationCodes],
      currentSemanticStatus: current.semanticStatus
    };
    return { ...selection, entry: selected };
  }

  function snapshot() {
    return {
      version: VERSION,
      enabled,
      checkpointCount: entries.length,
      eligibleCount: entries.filter(entry => entry.eligible).length,
      selection: { ...selection },
      checkpoints: entries.map(compactEntry)
    };
  }

  return {
    version: VERSION,
    enabled,
    record,
    chooseFinal,
    snapshot
  };
}

function buildCandidateAssessment({
  gate = null,
  deterministicAudit = null,
  structureAudit = null,
  quoteAudit = null,
  inlineCodeAudit = null,
  inlineMathAudit = null,
  fingerprintAudit = null,
  resumeAudit = null,
  koreanAudit = null,
  endingAudit = null,
  generatedDuplicateAudit = null,
  statisticalAtomAudit = null,
  depthSnapshot = null,
  transformed = false
} = {}) {
  const hard = [];
  const language = [];
  let languageRisk = 0;
  const addHard = code => addUnique(hard, code);
  const addLanguage = (code, weight = 1) => {
    addUnique(language, code);
    languageRisk += Math.max(0, finiteNumber(weight, 1));
  };

  for (const violation of gate?.violations || []) {
    addHard(violationCode(violation, 'whole_document_gate_failed'));
  }
  if (gate?.hardFail === true && !(gate?.violations || []).length) {
    addHard(String(gate.reason || 'whole_document_gate_failed'));
  }

  for (const warning of deterministicAudit?.warnings || []) {
    const code = warningCode(warning);
    if (!code) continue;
    if (LANGUAGE_WARNING_CODES.has(code)) {
      addLanguage(code, warning?.count || 1);
    } else {
      addHard(code);
    }
  }

  addStructureViolations(structureAudit, addHard);
  if (quoteAudit?.pass === false) addHard('direct_quote_integrity_failed');
  if (inlineCodeAudit?.pass === false || inlineCodeAudit?.orderPass === false) {
    addHard('inline_code_integrity_failed');
  }
  if (inlineMathAudit?.pass === false || inlineMathAudit?.orderPass === false) {
    addHard('inline_math_integrity_failed');
  }

  for (const violation of fingerprintAudit?.violations || []) {
    const code = violationCode(violation, 'fingerprint_violation');
    if (code === 'engine_phrase_fingerprint') {
      addLanguage(code, violation?.count || 1);
    } else {
      addHard(code);
    }
  }
  if (resumeAudit?.applicable === true && resumeAudit?.pass === false) {
    for (const code of resumeAudit.issueCodes || ['resume_coverage_failed']) addHard(code);
  }
  for (const issue of koreanAudit?.issues || []) {
    if (Number(issue?.introducedCount || 0) <= 0) continue;
    addLanguage(`korean_${String(issue.code || 'quality_issue')}`, (
      Number(issue.introducedCount || 0) * Number(issue.weight || 1)
    ));
  }
  if (Number(koreanAudit?.weightedRisk || 0) > languageRisk) {
    languageRisk = Number(koreanAudit.weightedRisk || 0);
  }
  if (endingAudit?.pass === false) {
    addLanguage('ending_style_mixed', (
      Number(endingAudit.introducedOtherCount || 0)
        || Number(endingAudit.issueCount || 0)
        || 1
    ));
  }
  if (generatedDuplicateAudit?.pass === false) {
    addHard('generated_duplicate_integrity_failed');
  }
  if (statisticalAtomAudit?.pass === false) {
    addHard('statistical_atom_integrity_failed');
  }

  return normalizeAssessment({
    hardViolationCodes: hard,
    languageViolationCodes: language,
    languageRisk,
    minimumEffectPass: depthSnapshot?.minimumEffectPass === true,
    transformed,
    depthSnapshot
  });
}

function addStructureViolations(audit, add) {
  if (!audit) {
    add('structure_audit_missing');
    return;
  }
  if (audit.pass === false) add('structure_audit_failed');
  const fields = [
    ['lostLockedCount', 'structure_lock_loss'],
    ['protectedBlockChangedCount', 'protected_block_changed'],
    ['tableColumnOwnershipLossCount', 'table_column_ownership_lost'],
    ['structuralRoleAdditionCount', 'structural_role_added'],
    ['lockedOutOfOrderCount', 'structure_lock_order'],
    ['unsafeBoundaryCount', 'unsafe_chunk_boundary'],
    ['sectionPathErrorCount', 'section_path_mismatch'],
    ['originalStructuralMarkerLossCount', 'original_structure_marker_loss'],
    ['sourceStructuralMarkerLossCount', 'source_structure_marker_loss'],
    ['sourceStructuralMarkerAdditionCount', 'source_structure_marker_added'],
    ['lineAnchorLossCount', 'line_anchor_loss'],
    ['lineAnchorBoundaryChangeCount', 'line_anchor_changed'],
    ['sourceLineAnchorLossCount', 'source_line_anchor_loss'],
    ['sourceLineAnchorAdditionCount', 'source_line_anchor_added'],
    ['sourceLineAnchorBoundaryChangeCount', 'source_line_anchor_changed'],
    ['inlineLabelBodySplitCount', 'inline_label_body_split'],
    ['introducedOrphanParticleBoundaryCount', 'orphan_particle_line_boundary']
  ];
  for (const [field, code] of fields) {
    if (Number(audit[field] || 0) > 0) add(code);
  }
  if (audit.tableColumnOwnershipPass === false) add('table_column_ownership_lost');
  if (audit.originalStructurePass === false) add('original_structure_changed');
  if (audit.lineAnchorLayoutPass === false) add('line_anchor_changed');
  if (audit.inlineLabelBodyLayoutPass === false) add('inline_label_body_split');
  if (audit.exactLineStructureApplicable === true && audit.exactLineStructurePass === false) {
    add('line_structure_changed');
  }
}

function compareCandidatePriority(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const checks = [
    [Number(left.eligible === true), Number(right.eligible === true), 'desc'],
    [Number(left.hardRisk || 0), Number(right.hardRisk || 0), 'asc'],
    [Number(left.semanticRank || 0), Number(right.semanticRank || 0), 'desc'],
    [Number(left.languageRisk || 0), Number(right.languageRisk || 0), 'asc'],
    [Number(left.depthPass === true), Number(right.depthPass === true), 'desc'],
    [Number(left.targetDepthMet === true), Number(right.targetDepthMet === true), 'desc'],
    [Number(left.depthScore || 0), Number(right.depthScore || 0), 'desc'],
    [Number(left.substantiveEditRatio || 0), Number(right.substantiveEditRatio || 0), 'desc'],
    [Number(left.sequence || 0), Number(right.sequence || 0), 'desc']
  ];
  for (const [a, b, direction] of checks) {
    if (a === b) continue;
    return direction === 'asc' ? (a < b ? 1 : -1) : (a > b ? 1 : -1);
  }
  return 0;
}

function selectionReason(selected, current) {
  if (Number(selected.hardRisk || 0) < Number(current.hardRisk || 0)) return 'priority_1_hard_safety';
  if (Number(selected.semanticRank || 0) > Number(current.semanticRank || 0)) return 'semantic_audit_pass';
  if (Number(selected.languageRisk || 0) < Number(current.languageRisk || 0)) return 'priority_2_language_non_regression';
  return 'priority_3_deepest_safe_candidate';
}

function semanticStatus(report, { baseline = false } = {}) {
  if (baseline) return { status: 'baseline', rank: 0 };
  if (!report || typeof report !== 'object') return { status: 'unknown', rank: 1 };
  if (report.pass === true && report.repairRejected !== true) return { status: 'pass', rank: 2 };
  if (report.pass === false || report.repairRejected === true) return { status: 'fail', rank: 0 };
  return { status: 'unknown', rank: 1 };
}

function normalizeAssessment(value = {}) {
  return {
    hardViolationCodes: uniqueCodes(value.hardViolationCodes),
    languageViolationCodes: uniqueCodes(value.languageViolationCodes),
    languageRisk: Math.max(0, finiteNumber(value.languageRisk, 0)),
    minimumEffectPass: value.minimumEffectPass === true,
    transformed: value.transformed === true,
    depthSnapshot: value.depthSnapshot || null
  };
}

function compactEntry(entry) {
  return {
    stage: entry.stage,
    semanticStatus: entry.semanticStatus,
    hardRisk: entry.hardRisk,
    hardViolationCodes: [...entry.hardViolationCodes],
    languageRisk: entry.languageRisk,
    languageViolationCodes: [...entry.languageViolationCodes],
    minimumEffectPass: entry.minimumEffectPass,
    transformed: entry.transformed,
    depthPass: entry.depthPass,
    targetDepthMet: entry.targetDepthMet,
    depthScore: entry.depthScore,
    substantiveEditRatio: entry.substantiveEditRatio,
    eligible: entry.eligible,
    assessmentError: entry.assessmentError
  };
}

function emptySelection(enabled) {
  return {
    enabled: enabled === true,
    applied: false,
    currentStage: '',
    selectedStage: '',
    reason: enabled ? 'not_selected' : 'disabled',
    currentHardViolationCodes: [],
    currentSemanticStatus: ''
  };
}

function warningCode(value) {
  return String(typeof value === 'string' ? value : (value?.code || value?.gate || value?.type || '')).trim();
}

function violationCode(value, fallback) {
  return String(value?.code || value?.gate || value?.type || fallback || 'violation').trim();
}

function uniqueCodes(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function addUnique(values, code) {
  const value = String(code || '').trim();
  if (value && !values.includes(value)) values.push(value);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round4(value) {
  return Math.round(finiteNumber(value, 0) * 10000) / 10000;
}

function cloneSerializable(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function safeError(error) {
  return String(error?.message || error || 'candidate assessment failed').slice(0, 180);
}

module.exports = {
  VERSION,
  LANGUAGE_WARNING_CODES,
  createCandidateLedger,
  buildCandidateAssessment,
  compareCandidatePriority,
  semanticStatus
};
