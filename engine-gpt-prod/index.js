'use strict';

const net = require('net');
const dns = require('dns').promises;
const { completeJson, webSearchTool, safetyIdentifierForUid } = require('./openaiClient');
const { HUMANIZE_SCHEMA, DETECT_SCHEMA, REWRITE_SCHEMA, EVIDENCE_SCHEMA } = require('./schemas');
const prompts = require('./prompts');
const { addUsage, emptyUsage } = require('./usageCost');
const local = require('./local');
const { buildContract } = local.contract;
const structureChunk = require('./structureChunk');
const floor = local.floor;
const surfaceguard = local.surfaceguard;
const koreanQuality = local.koreanQuality;
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { logger } = require('../lib/logger');
const layoutNormalizer = require('../engine/layout');
const inputRouting = require('../engine/inputrouting');
const { computeEditMetrics, splitSentences } = require('../engine/koreanText');
const { detectDocumentProfile, applyDocumentProfileOverride, applyTargetRegister } = require('./documentProfile');
const {
  buildVoiceProfile,
  auditDirectQuoteIntegrity,
  restoreDirectQuoteContents,
  sentenceDistributionShift
} = require('./voiceProfile');
const qualityV2 = require('./finalQualityV2');
const { compareNumberMultiset } = require('./factAudit');
const humanizationDepth = require('./humanizationDepth');
const sectionRecovery = require('./sectionRecovery');
const discourseAudit = require('./discourseAudit');
const koreanRefinement = require('./koreanRefinement');
const fingerprint = require('./fingerprintAudit');
const endingStyle = require('./endingStyleAudit');
const resumeCoverage = require('./resumeCoverage');
const experienceAudit = require('./experienceAudit');
const sourcePreflight = require('./sourcePreflight');
const { shouldPassThrough, shouldPreserveVoiceSentenceBoundaries } = require('./chunkPolicy');

const VERSION = 'gpt-prod-v2.4.17';
const LEGACY_VERSION = 'gpt-prod-operating-engine-v1';
const PROFILE = 'engine-gpt-prod';
const NO_DELIVERY_GATES = new Set([
  'gpt_all_chunks_fallback',
  'gpt_noop_unchanged',
  'noop_unchanged',
  'humanization_depth_no_effect'
]);
const STRICT_DELIVERY_GATES = new Set([
  ...NO_DELIVERY_GATES,
  'empty_or_meta_output',
  'prompt_instruction_leak',
  'encoding_corruption',
  'sentence_truncated',
  'refusal',
  'polish_unchanged',
  'polish_excessive_change',
  'polish_evaluative_padding_added',
  'humanization_depth_no_effect'
]);
const V2_SAFE_LOW_BENEFIT_GATES = new Set([
  'humanization_depth_no_effect'
]);
const REVIEW_WARNING_GATES = new Set([
  'section_anchor_loss',
  'length_collapse',
  'protected_term_loss',
  'structure_lock_loss',
  'structure_lock_order',
  'questionnaire_structure_changed',
  'unsafe_chunk_boundary',
  'grammar_hard_error',
  'speaker_drift',
  'register_shift',
  'paragraph_collapse',
  'number_multiset_changed',
  'humanization_depth_below_minimum'
]);

function normalizeMode(mode, { allowPolish = false } = {}) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === 'blog' || v === 'basic') return 'blog';
  if ((v === 'polish' || v === 'preserve') && allowPolish) return 'polish';
  return 'assignment';
}

async function loadConfig(config) {
  return config ? gptRuntimeConfig.publicConfig(config, config.source || 'inline') : gptRuntimeConfig.getRuntimeConfig({ force: false });
}

function allowPolishMode({ styleProfile = '', config } = {}) {
  if (config && (config.allowPolishMode === true || config.allowPolish === true)) return true;
  const profile = String(styleProfile || '').toLowerCase();
  return profile.includes('admin') || profile.includes('lab');
}

function isAdminNiklProfile(styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  return profile.includes('admin') || profile.includes('lab') || profile.includes('test');
}

function isNiklQualityEnabled(value, styleProfile = '') {
  if (process.env.GPT_NIKL_QUALITY_ENABLED === '0') return false;
  if (isAdminNiklProfile(styleProfile)) return value === true;
  return true;
}

function isQualityPatternLabEnabled(value, styleProfile = '') {
  if (process.env.GPT_QUALITY_PATTERN_ENABLED === '0' || process.env.GPT_QUALITY_PATTERN_LAB_ENABLED === '0') return false;
  if (value === true) return true;
  if (value === false) return false;
  return !isAdminNiklProfile(styleProfile);
}

function isLayoutNlpEnabled(value) {
  if (process.env.GPT_LAYOUT_NLP_ENABLED === '0' || process.env.LAYOUT_NLP_PRODUCTION_ENABLED === '0') return false;
  if (value === true) return true;
  if (value === false) return false;
  return true;
}

function isEngineV2Enabled() {
  return String(process.env.HUMANIZE_ENGINE_V2_ENABLED || '').trim() === '1';
}

function isHumanizationDepthEnabled() {
  return String(process.env.HUMANIZATION_DEPTH_GATE_ENABLED || '1').trim() !== '0';
}

function normalizeRequestedMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'blog' || value === 'basic') return 'blog';
  if (value === 'polish' || value === 'preserve') return 'polish';
  return 'formal';
}

function requestStrengthForMode(requestedMode) {
  if (requestedMode === 'polish') return 'polish';
  if (requestedMode === 'blog') return 'basic';
  return 'advanced';
}

function effectiveModeForProfile(requestedMode, normalizedMode, documentProfile) {
  if (normalizedMode === 'polish') return 'polish';
  if (requestedMode !== 'blog') return 'assignment';
  const profile = documentProfile?.profile || 'unknown';
  const confidence = Number(documentProfile?.confidence) || 0;
  const trustedOverride = documentProfile?.profileDecisionSource === 'user_override'
    && documentProfile?.profileOverrideApplied === true;
  const reportTieBreak = confidence >= 0.55
    && confidence < 0.75
    && documentProfile?.basicStyle === 'report'
    && ['academic_paper', 'report_assignment'].includes(profile);
  if ((confidence >= 0.75 || trustedOverride) && [
    'academic_paper',
    'report_assignment',
    'student_record_teacher',
    'student_self_assessment',
    'resume_application',
    'mail_notice',
    'creative'
  ].includes(profile)) return 'assignment';
  if (reportTieBreak) return 'assignment';
  return 'blog';
}

async function run(options = {}) {
  return runEngine(options, { v2Enabled: isEngineV2Enabled() });
}

async function runEngine({
  text,
  mode = 'assignment',
  lang = 'ko',
  userNotes = '',
  evidence = '',
  signal,
  config,
  styleProfile = '',
  basicStyle = '',
  documentProfileOverride = '',
  allowPolish = false,
  safetyIdentifier = '',
  uid = '',
  niklQualityTest = false,
  qualityPatternLab,
  layoutNlp = null
} = {}, { v2Enabled = true } = {}) {
  const submittedSource = String(text || '').trim();
  if (!submittedSource) throw new Error('engine-gpt-prod: empty text');
  const sourcePreflightAudit = v2Enabled
    ? sourcePreflight.auditAndSanitizeSource(submittedSource)
    : null;
  const rawSource = sourcePreflightAudit?.text || submittedSource;
  if (v2Enabled && inputRouting.isEnglishInput(rawSource)) {
    const error = new Error('현재 휴머나이징 엔진은 한국어 글만 지원해요. 영어 입력은 원문 보존을 위해 변환하지 않습니다.');
    error.code = 'HUMANIZE_KOREAN_ONLY';
    error.noCharge = true;
    throw error;
  }
  const cfg = await loadConfig(config);
  const humanizationDepthEnabled = v2Enabled && isHumanizationDepthEnabled();
  const requestedMode = normalizeRequestedMode(mode);
  const requestStrength = requestStrengthForMode(requestedMode);
  const polishAllowed = v2Enabled ? allowPolish === true : allowPolishMode({ styleProfile, config });
  const normalizedMode = normalizeMode(mode, { allowPolish: polishAllowed });
  const detectedDocumentProfile = v2Enabled
    ? detectDocumentProfile(rawSource, { basicStyle })
    : {
        profile: 'unknown',
        contentGenre: 'unknown',
        confidence: 0,
        group: 'unknown',
        source: 'legacy',
        profileDecisionSource: 'legacy',
        basicStyle: String(basicStyle || ''),
        tonePolicy: 'source_preserve',
        candidateProfiles: [],
        safetyProfiles: [],
        profileMargin: 0,
        formatProfile: { length: 'standard', primary: 'plain', flags: [] },
        riskFlags: []
      };
  const documentProfile = v2Enabled
    ? applyTargetRegister(
        applyDocumentProfileOverride(detectedDocumentProfile, documentProfileOverride),
        { requestStrength, basicStyle }
      )
    : detectedDocumentProfile;
  const selectedMode = v2Enabled ? effectiveModeForProfile(requestedMode, normalizedMode, documentProfile) : normalizedMode;
  const voiceProfile = v2Enabled ? buildVoiceProfile(rawSource, { documentProfile, mode: selectedMode }) : null;
  // v2에서만 UID를 비가역 safety_identifier로 바꾼다. 플래그를 0으로 내려
  // 레거시 경로로 즉시 복귀할 때 OPENAI_SAFETY_SALT가 롤백을 막아서는 안 된다.
  const safetyId = v2Enabled
    ? (safetyIdentifier || (uid ? safetyIdentifierForUid(uid) : ''))
    : (safetyIdentifier || '');
  const lineBoundaryPolicy = v2Enabled ? String(voiceProfile?.lineBoundaryPolicy || 'none') : 'none';
  const layoutStructureLocked = v2Enabled && lineBoundaryPolicy !== 'none';
  const layoutNlpEnabled = isLayoutNlpEnabled(layoutNlp) && !layoutStructureLocked;
  const preLayout = !v2Enabled && layoutNlpEnabled
    ? await safeFormatLayout(rawSource, { mode: selectedMode, phase: 'pre' })
    : null;
  const source = preLayout?.text || rawSource;
  const qualityPatternLabEnabled = v2Enabled ? false : isQualityPatternLabEnabled(qualityPatternLab, styleProfile);
  const niklQualityEnabled = qualityPatternLabEnabled || isNiklQualityEnabled(niklQualityTest, styleProfile);
  const contract = buildContract(source, { mode: selectedMode, lang, optIn: !!String(userNotes || '').trim() });
  const inputRisk = safeInputRisk(source);
  const sourceSurface = safeSurface(source);
  const chunkPlan = structureChunk.splitChunksForGpt(source, {
    coalesceEditable: v2Enabled,
    preserveSentenceBoundaries: v2Enabled && shouldPreserveVoiceSentenceBoundaries(source, voiceProfile, selectedMode),
    sentenceBoundaryMinimum: selectedMode === 'polish' ? 3 : 4,
    preserveLineBoundaries: lineBoundaryPolicy,
    formatProfile: documentProfile.formatProfile
  });
  const chunks = chunkPlan.chunks;
  const records = [];

  for (let i = 0; i < chunks.length; i++) {
    const record = await processChunk({
      chunk: chunks[i],
      chunks,
      index: i,
      source,
      contract,
      inputRisk,
      sourceSurface,
      mode: selectedMode,
      requestStrength,
      lang,
      userNotes,
      evidence,
      cfg,
      styleProfile,
      documentProfile,
      voiceProfile,
      niklQualityTest: niklQualityEnabled,
      qualityPatternLab: qualityPatternLabEnabled,
      safetyIdentifier: safetyId,
      v2Enabled,
      signal
    });
    records.push(record);
  }

  let sectionRecoveryReport = {
    metrics: {
      enabled: sectionRecovery.isEnabled(),
      attempted: 0,
      applied: 0,
      escalated: 0,
      selectedSectionCount: 0,
      miniAttemptCount: 0,
      escalationAttemptCount: 0,
      concurrency: sectionRecovery.RECOVERY_CONCURRENCY,
      sectionIndices: [],
      appliedSectionIndices: [],
      rejectedAttemptCount: 0,
      rejectionCodes: [],
      rejectionCodeCounts: {},
      miniAppliedCount: 0,
      escalationAppliedCount: 0
    },
    usages: []
  };
  if (v2Enabled && humanizationDepthEnabled && rawSource.length >= sectionRecovery.MIN_DOCUMENT_CHARS) {
    sectionRecoveryReport = await sectionRecovery.recoverSections({
      chunks,
      sourceLength: rawSource.length,
      mode: selectedMode,
      requestStrength,
      documentProfile,
      inputRisk,
      retrySection: async entry => qualityV2.retryGeneralSurface({
        source: entry.source,
        currentOutput: String(chunks[entry.index]?.outputText ?? entry.output),
        humanizationPlan: entry.plan,
        humanizationDepthReport: entry.report,
        config: cfg,
        signal,
        safetyIdentifier: safetyId,
        model: entry.tier === 'escalation' ? cfg.models.humanizeEscalation : cfg.models.repair,
        reasoningEffort: entry.tier === 'escalation' ? cfg.reasoning.escalation : cfg.reasoning.repair,
        phase: entry.tier === 'escalation' ? 'section_depth_escalation' : 'section_depth_recovery'
      }),
      validateCandidate: ({ entry, candidate }) => auditGeneralSurfaceCandidate(
        entry.source,
        candidate,
        contract,
        documentProfile,
        selectedMode
      )
    });
    if (sectionRecoveryReport.metrics.applied > 0) {
      const appliedIndices = new Set(sectionRecoveryReport.metrics.appliedSectionIndices || []);
      for (const index of appliedIndices) {
        if (records[index] && chunks[index]) records[index].outputText = chunks[index].outputText;
      }
      acceptGeneralSurfaceRecovery(records, appliedIndices);
    }
  }

  const boundaryRepair = structureChunk.repairUnsafeChunkBoundaries(chunks);
  let outputText = structureChunk.mergeChunks(chunks);
  const frozen = v2Enabled ? freezeLockedBlocks(source, outputText, chunks) : null;
  const auditSource = frozen?.source || source;
  outputText = frozen?.output || outputText;
  const postprocessMeta = {};
  outputText = finalPostprocess(outputText, auditSource, selectedMode, contract, postprocessMeta, {
    preserveLineBreaks: layoutStructureLocked
  });

  let supplementalUsage = (sectionRecoveryReport.usages || [])
    .reduce((acc, usage) => addUsage(acc, usage), emptyUsage());
  let polishReport = null;
  let polishRetryCount = 0;
  let generalSurfaceRetryCount = 0;
  let polishRetryAttemptCount = 0;
  let generalSurfaceRetryAttemptCount = 0;
  let polishSpeakerRestoreCount = 0;
  let polishSpeakerRestoredSentenceCount = 0;
  let finalNoopRecoveryCount = 0;
  let finalNoopRecovery = { attempted: false, applied: false, method: '', reason: '' };
  let humanizationDepthRetryCount = Number(sectionRecoveryReport.metrics?.miniAttemptCount || 0)
    + Number(sectionRecoveryReport.metrics?.escalationAttemptCount || 0);
  let humanizationDepthEscalationAttemptCount = Number(sectionRecoveryReport.metrics?.escalationAttemptCount || 0);
  let humanizationNoEffectRetryAttemptCount = 0;
  let humanizationRoleRecoveryAttemptCount = 0;
  let humanizationDepthRetryApplied = Number(sectionRecoveryReport.metrics?.applied || 0) > 0;
  let humanizationDepthRetryRejectedCount = Number(sectionRecoveryReport.metrics?.rejectedAttemptCount || 0);
  const humanizationDepthRetryRejectionCodes = safeFailureCodeList(sectionRecoveryReport.metrics?.rejectionCodes);
  let humanizationDepthRetryTargetSentenceCount = (sectionRecoveryReport.selected || [])
    .reduce((sum, entry) => sum + Number(entry?.plan?.targetSentenceCount || 0), 0);
  let polishStrictFailure = '';
  let polishRetryReason = '';
  let polishPaddingReport = null;
  let polishEvaluativePaddingCodes = [];
  let polishDeterministicPaddingRestoreCount = 0;
  let koreanRefinementAudit = null;
  let koreanDeterministicRepairCount = 0;
  let koreanRefinementRetryAttemptCount = 0;
  let koreanRefinementRetryCount = 0;
  let koreanRefinementRetryApplied = false;
  let quoteIntegrityAudit = null;
  let quoteIntegrityRestoreCount = 0;
  let finalQuoteIntegrityRestoreCount = 0;
  let fingerprintAudit = null;
  let fingerprintRetryAttemptCount = 0;
  let fingerprintRepairCount = 0;
  let fingerprintRetryApplied = false;
  let endingStyleAudit = null;
  let endingStyleRetryAttemptCount = 0;
  let endingStyleRepairCount = 0;
  let endingStyleRetryApplied = false;
  let resumeCoverageAudit = null;
  let resumeCoverageRetryAttemptCount = 0;
  let resumeCoverageRepairCount = 0;
  let resumeCoverageRetryApplied = false;
  let experienceCandidateAudit = null;
  let finalFormattingRepair = {
    version: 1,
    applied: false,
    changeCount: 0,
    changeCodes: [],
    brokenLineBreakRepairCount: 0,
    brokenParagraphBreakRepairCount: 0,
    excessiveBlankLineRepairCount: 0,
    missingSentenceSpaceRepairCount: 0,
    contextualSpacingRepairCount: 0
  };
  const sourceReviewWarnings = v2Enabled
    ? [
        ...(sourcePreflightAudit?.warnings || []),
        ...koreanRefinement.buildSourceReviewWarnings(rawSource, documentProfile)
      ]
    : [];
  if (v2Enabled && selectedMode === 'polish') {
    polishReport = qualityV2.polishEditPolicy(auditSource, outputText);
    polishPaddingReport = qualityV2.comparePolishEvaluativePadding(auditSource, outputText);
    polishEvaluativePaddingCodes = safeFailureCodeList(polishPaddingReport.introducedCodes);
    if (!polishReport.noSafeChange && polishPaddingReport.increased) {
      const restored = qualityV2.restorePolishEvaluativePaddingSentences(auditSource, outputText);
      if (restored.applied) {
        outputText = restored.text;
        polishRetryReason = 'evaluative_padding';
        polishRetryCount = 1;
        polishDeterministicPaddingRestoreCount = restored.restoredSentenceCount || 1;
        polishReport = qualityV2.polishEditPolicy(auditSource, outputText);
        polishPaddingReport = qualityV2.comparePolishEvaluativePadding(auditSource, outputText);
      }
    }
    if (polishReport.noSafeChange || polishPaddingReport.increased) {
      try {
        polishRetryReason ||= polishReport.noSafeChange ? 'unchanged' : 'evaluative_padding';
        polishRetryAttemptCount = 1;
        const retried = await qualityV2.retryPolishSurface({
          source: auditSource,
          currentOutput: outputText,
          policy: polishReport,
          reason: polishRetryReason,
          config: cfg,
          signal,
          safetyIdentifier: safetyId
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        polishRetryCount = 1;
        outputText = retried.outputText || outputText;
        polishReport = qualityV2.polishEditPolicy(auditSource, outputText);
        polishPaddingReport = qualityV2.comparePolishEvaluativePadding(auditSource, outputText);
        polishEvaluativePaddingCodes = safeFailureCodeList([
          ...polishEvaluativePaddingCodes,
          ...polishPaddingReport.introducedCodes
        ]);
        if (!retried.safeChangeFound || polishReport.noSafeChange) {
          polishStrictFailure = 'polish_unchanged';
        } else if (polishReport.excessiveChange) {
          polishStrictFailure = 'polish_excessive_change';
        } else if (polishPaddingReport.increased) {
          polishStrictFailure = 'polish_evaluative_padding_added';
        } else {
          for (const record of records) {
            if ((record.warnings || []).includes('polish_surface_boundary_pending')) {
              record.warnings = (record.warnings || []).filter(warning => ![
                'polish_surface_boundary_pending',
                'v2_residual:structure_boundary_marker_failed'
              ].includes(warning));
            }
          }
        }
      } catch (error) {
        polishStrictFailure = 'polish_unchanged';
        polishReport = { ...(polishReport || {}), retryError: String(error?.message || error).slice(0, 180) };
      }
    } else if (polishReport.excessiveChange) {
      // 과도한 결과를 두 번째 모델이 임의로 다시 쓰게 하지 않는다. 문서 전체가
      // 동일한 경우에만 수리 호출을 허용하고, 상한 초과는 안전 오류로 차단한다.
      polishStrictFailure = 'polish_excessive_change';
    }
  }
  const humanizationPlan = humanizationDepthEnabled ? humanizationDepth.buildHumanizationPlan(auditSource, {
    requestStrength,
    documentProfile,
    inputRisk
  }) : null;
  let humanizationDepthReport = humanizationDepthEnabled
    ? humanizationDepth.evaluateHumanizationDepth(auditSource, outputText, humanizationPlan)
    : null;
  const generalSurfaceRetryPending = records.some(record => (record.warnings || []).includes('general_surface_retry_pending'))
    && records.every(record => record.fallback !== true || (record.warnings || []).includes('general_surface_retry_safe_fallback'));
  if (v2Enabled
      && selectedMode !== 'polish'
      && (rawSource.length < sectionRecovery.MIN_DOCUMENT_CHARS || !sectionRecovery.isEnabled())
      && (generalSurfaceRetryPending || humanizationDepthReport?.pass === false)) {
    const wasEquivalent = normalizeBare(auditSource) === normalizeBare(outputText);
    // 기본도 첫 회복 뒤 결과가 여전히 문단 재배치·구두점 수준에 머물면 mini로
    // 한 번 더 회복한다. 최소 효과는 넘었지만 목표 깊이만 부족한 결과에는 추가
    // 호출하지 않으며, 고급의 두 번째 시도만 상위 모델로 승격한다.
    const maxDepthAttempts = 2;
    if (wasEquivalent) finalNoopRecovery.attempted = true;
    let lastRetryError = null;
    for (let attempt = 0; attempt < maxDepthAttempts; attempt += 1) {
      const roleRecoveryPending = (humanizationDepthReport?.reasons || []).some(reason => [
        'resume_semantic_repetition_low',
        'paragraph_rewrite_coverage_low'
      ].includes(reason));
      if (attempt > 0
          && (humanizationDepthReport?.pass === true
            || (requestStrength !== 'advanced'
              && humanizationDepthReport?.minimumEffectPass !== false
              && !roleRecoveryPending))) break;
      try {
        generalSurfaceRetryAttemptCount += 1;
        humanizationDepthRetryCount += 1;
        // 원문과 완전히 같은 결과는 일반적인 "깊이 부족"보다 강한 기술 실패다.
        // 기본 피하기도 첫 회복이 실패하면 상위 모델로 한 번 승격해, 원문 그대로
        // 전달·과금되는 경우를 최대한 줄인다.
        const escalation = attempt > 0 && (requestStrength === 'advanced' || wasEquivalent);
        const roleRecovery = attempt > 0
          && !escalation
          && roleRecoveryPending
          && humanizationDepthReport?.minimumEffectPass !== false;
        const noEffectRetry = attempt > 0 && !escalation && !roleRecovery;
        if (escalation) humanizationDepthEscalationAttemptCount += 1;
        if (noEffectRetry) humanizationNoEffectRetryAttemptCount += 1;
        if (roleRecovery) humanizationRoleRecoveryAttemptCount += 1;
        const retried = await qualityV2.retryGeneralSurface({
          source: auditSource,
          currentOutput: outputText,
          humanizationPlan,
          humanizationDepthReport,
          config: cfg,
          signal,
          safetyIdentifier: safetyId,
          model: escalation ? cfg.models.humanizeEscalation : '',
          reasoningEffort: escalation ? cfg.reasoning.escalation : '',
          phase: escalation
            ? 'humanization_depth_escalation'
            : roleRecovery
              ? 'humanization_role_recovery'
            : noEffectRetry
              ? 'humanization_no_effect_retry'
              : 'humanization_depth_retry'
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        humanizationDepthRetryTargetSentenceCount += retried.targetSentenceCount || 0;
        const retryOutput = retried.outputText;
        const retryDepth = humanizationDepthEnabled
          ? humanizationDepth.evaluateHumanizationDepth(auditSource, retryOutput, humanizationPlan)
          : { pass: true };
        const safeRetryCandidate = isSafeGeneralSurfaceCandidate(auditSource, retryOutput, contract, documentProfile, selectedMode)
          && preservesFinalStructure(auditSource, retryOutput, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
        // 고급은 mini가 조금만 개선한 후보를 냈다고 멈추지 않는다. 안전한 개선은
        // 중간 후보로 유지하되 최소선에 못 미치면 상위 모델이 남은 문장·문단만 한 번
        // 더 회복한다. 결과를 막거나 무차감하는 대신 실제 체감 강도를 만드는 경로다.
        const retryWorthUsing = retryDepth.pass === true
          || humanizationDepth.isBetterHumanizationCandidate(humanizationDepthReport, retryDepth);
        if (safeRetryCandidate && retryWorthUsing) {
          outputText = retryOutput;
          generalSurfaceRetryCount += 1;
          humanizationDepthRetryApplied = true;
          humanizationDepthReport = retryDepth;
          acceptGeneralSurfaceRecovery(records);
          if (wasEquivalent) {
            finalNoopRecoveryCount = 1;
            finalNoopRecovery = { attempted: true, applied: true, method: 'model', reason: 'substantive_humanization' };
          }
        } else if (humanizationDepthEnabled) {
          humanizationDepthRetryRejectedCount += 1;
          if (!retried.safeChangeFound || !retryOutput || normalizeBare(outputText) === normalizeBare(retryOutput)) {
            addUniqueCode(humanizationDepthRetryRejectionCodes, 'candidate_unchanged');
          }
          if (!safeRetryCandidate) addUniqueCode(humanizationDepthRetryRejectionCodes, 'safety_audit_failed');
          if (safeRetryCandidate && !retryWorthUsing) {
            addUniqueCode(humanizationDepthRetryRejectionCodes, 'depth_not_improved');
          }
          humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(auditSource, outputText, humanizationPlan);
        }
      } catch (error) {
        lastRetryError = error;
        humanizationDepthRetryRejectedCount += 1;
        addUniqueCode(humanizationDepthRetryRejectionCodes, 'retry_error');
      }
    }
    if (wasEquivalent && finalNoopRecovery.applied !== true) {
      finalNoopRecovery = {
        attempted: true,
        applied: false,
        method: 'model',
        reason: lastRetryError
          ? `retry_error:${String(lastRetryError?.code || lastRetryError?.message || 'unknown').slice(0, 80)}`
          : 'no_substantive_change'
      };
    }
  }

  if (v2Enabled && !polishStrictFailure) {
    quoteIntegrityAudit = auditDirectQuoteIntegrity(auditSource, outputText);
    const restored = restoreDirectQuoteContents(auditSource, outputText);
    if (restored.applied
        && preservesFinalStructure(auditSource, restored.text, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair)) {
      outputText = restored.text;
      quoteIntegrityAudit = restored.auditAfter;
      quoteIntegrityRestoreCount = restored.restoredCount || 1;
      if (humanizationDepthEnabled && selectedMode !== 'polish') {
        humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(
          auditSource,
          outputText,
          humanizationPlan
        );
      }
    }
  }

  if (v2Enabled && !polishStrictFailure) {
    koreanRefinementAudit = koreanRefinement.analyzeKoreanRefinement({
      source: auditSource,
      outputText,
      documentProfile,
      mode: selectedMode
    });
    const deterministicRepair = koreanRefinement.applySafeDeterministicRepairs({
      source: auditSource,
      outputText,
      documentProfile
    });
    if (deterministicRepair.applied) {
      const candidate = deterministicRepair.text;
      const candidateDepth = humanizationDepthEnabled && selectedMode !== 'polish'
        ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
        : null;
      const candidateAudit = koreanRefinement.analyzeKoreanRefinement({
        source: auditSource,
        outputText: candidate,
        documentProfile,
        mode: selectedMode
      });
      const safeCandidate = isSafeLocalizedLanguageCandidate({
        source: auditSource,
        before: outputText,
        candidate,
        contract,
        documentProfile,
        mode: selectedMode,
        protectedTerms: collectRecordProtectedTerms(records),
        currentDepth: humanizationDepthReport,
        candidateDepth
      }) && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
      if (safeCandidate && koreanRefinement.isImprovedAudit(koreanRefinementAudit, candidateAudit)) {
        outputText = candidate;
        koreanRefinementAudit = candidateAudit;
        koreanDeterministicRepairCount = deterministicRepair.changeCount || 1;
        if (candidateDepth) humanizationDepthReport = candidateDepth;
      }
    }

    const needsModelRefinement = (koreanRefinementAudit?.repairableIssues || [])
      .some(item => item.afterCount > 0 && item.deterministicSafe !== true);
    if (needsModelRefinement) {
      try {
        koreanRefinementRetryAttemptCount = 1;
        const retried = await qualityV2.retryKoreanRefinement({
          source: auditSource,
          currentOutput: outputText,
          refinementAudit: koreanRefinementAudit,
          documentProfile,
          mode: selectedMode,
          config: cfg,
          signal,
          safetyIdentifier: safetyId
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        const candidate = retried.outputText || outputText;
        const candidateDepth = humanizationDepthEnabled && selectedMode !== 'polish'
          ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
          : null;
        const candidateAudit = koreanRefinement.analyzeKoreanRefinement({
          source: auditSource,
          outputText: candidate,
          documentProfile,
          mode: selectedMode
        });
        const safeCandidate = retried.safeChangeFound === true
          && isSafeLocalizedLanguageCandidate({
            source: auditSource,
            before: outputText,
            candidate,
            contract,
            documentProfile,
            mode: selectedMode,
            protectedTerms: collectRecordProtectedTerms(records),
            currentDepth: humanizationDepthReport,
            candidateDepth
          })
          && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
        if (safeCandidate && koreanRefinement.isImprovedAudit(koreanRefinementAudit, candidateAudit)) {
          outputText = candidate;
          koreanRefinementAudit = candidateAudit;
          koreanRefinementRetryCount = 1;
          koreanRefinementRetryApplied = true;
          if (candidateDepth) humanizationDepthReport = candidateDepth;
        }
      } catch (error) {
        koreanRefinementAudit = {
          ...(koreanRefinementAudit || {}),
          retryError: String(error?.code || error?.message || error).slice(0, 180)
        };
      }
    }
  }

  if (v2Enabled && !polishStrictFailure && selectedMode !== 'polish' && fingerprint.isEnabled()) {
    fingerprintAudit = fingerprint.auditFingerprint(auditSource, outputText);
    if (!fingerprintAudit.pass) {
      try {
        fingerprintRetryAttemptCount = 1;
        const retried = await qualityV2.retryFingerprintAudit({
          source: auditSource,
          currentOutput: outputText,
          fingerprintAudit,
          documentProfile,
          config: cfg,
          signal,
          safetyIdentifier: safetyId
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        const candidate = retried.outputText || outputText;
        const candidateFingerprint = fingerprint.auditFingerprint(auditSource, candidate);
        const candidateDepth = humanizationDepthEnabled
          ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
          : null;
        const safeCandidate = retried.safeChangeFound === true
          && fingerprint.isImproved(fingerprintAudit, candidateFingerprint)
          && isSafeLocalizedLanguageCandidate({
            source: auditSource,
            before: outputText,
            candidate,
            contract,
            documentProfile,
            mode: selectedMode,
            protectedTerms: collectRecordProtectedTerms(records),
            currentDepth: humanizationDepthReport,
            candidateDepth
          })
          && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
        if (safeCandidate) {
          outputText = candidate;
          fingerprintAudit = candidateFingerprint;
          fingerprintRepairCount = 1;
          fingerprintRetryApplied = true;
          if (candidateDepth) humanizationDepthReport = candidateDepth;
        }
      } catch (error) {
        fingerprintAudit = {
          ...(fingerprintAudit || {}),
          retryError: String(error?.code || error?.message || error).slice(0, 180)
        };
      }
    }
  }

  if (v2Enabled && !polishStrictFailure) {
    endingStyleAudit = endingStyle.auditEndingStyle(auditSource, outputText);
    if (!endingStyleAudit.pass) {
      try {
        endingStyleRetryAttemptCount = 1;
        const retried = await qualityV2.retryEndingStyleAudit({
          source: auditSource,
          currentOutput: outputText,
          endingAudit: endingStyleAudit,
          documentProfile,
          config: cfg,
          signal,
          safetyIdentifier: safetyId
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        const candidate = retried.outputText || outputText;
        const candidateEndingAudit = endingStyle.auditEndingStyle(auditSource, candidate);
        const candidateDepth = humanizationDepthEnabled && selectedMode !== 'polish'
          ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
          : null;
        const safeCandidate = retried.safeChangeFound === true
          && endingStyle.isImproved(endingStyleAudit, candidateEndingAudit)
          && isSafeLocalizedLanguageCandidate({
            source: auditSource,
            before: outputText,
            candidate,
            contract,
            documentProfile,
            mode: selectedMode,
            protectedTerms: collectRecordProtectedTerms(records),
            currentDepth: humanizationDepthReport,
            candidateDepth
          })
          && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
        if (safeCandidate) {
          outputText = candidate;
          endingStyleAudit = candidateEndingAudit;
          endingStyleRepairCount = 1;
          endingStyleRetryApplied = true;
          if (candidateDepth) humanizationDepthReport = candidateDepth;
        }
      } catch (error) {
        endingStyleAudit = {
          ...(endingStyleAudit || {}),
          retryError: String(error?.code || error?.message || error).slice(0, 180)
        };
      }
    }
  }

  if (v2Enabled && !polishStrictFailure) {
    resumeCoverageAudit = resumeCoverage.auditResumeCoverage(auditSource, outputText, documentProfile);
    if (resumeCoverageAudit.applicable && !resumeCoverageAudit.pass) {
      try {
        resumeCoverageRetryAttemptCount = 1;
        const retried = await qualityV2.retryResumeCoverage({
          source: auditSource,
          currentOutput: outputText,
          coverageAudit: resumeCoverageAudit,
          config: cfg,
          signal,
          safetyIdentifier: safetyId
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        const candidate = retried.outputText || outputText;
        const candidateCoverage = resumeCoverage.auditResumeCoverage(auditSource, candidate, documentProfile);
        const candidateDepth = humanizationDepthEnabled && selectedMode !== 'polish'
          ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
          : null;
        const safeCandidate = retried.safeChangeFound === true
          && resumeCoverage.isImproved(resumeCoverageAudit, candidateCoverage)
          && resumeCoverage.isSafeRestorationShape(
            auditSource,
            outputText,
            candidate,
            resumeCoverageAudit.omissions?.length || 1
          )
          && isSafeLocalizedLanguageCandidate({
            source: auditSource,
            before: outputText,
            candidate,
            contract,
            documentProfile,
            mode: selectedMode,
            protectedTerms: collectRecordProtectedTerms(records),
            currentDepth: humanizationDepthReport,
            candidateDepth,
            maxLocalEditRatio: 0.55,
            maxLocalLengthRatio: 1.70,
            allowDepthRegression: true
          })
          && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
        if (safeCandidate) {
          outputText = candidate;
          resumeCoverageAudit = candidateCoverage;
          resumeCoverageRepairCount = 1;
          resumeCoverageRetryApplied = true;
          if (candidateDepth) humanizationDepthReport = candidateDepth;
        }
      } catch (error) {
        resumeCoverageAudit = {
          ...(resumeCoverageAudit || {}),
          retryError: String(error?.code || error?.message || error).slice(0, 180)
        };
      }
    }
  }

  if (v2Enabled && !polishStrictFailure) {
    experienceCandidateAudit = experienceAudit.detectExperienceCandidate(
      auditSource,
      outputText,
      evidence || userNotes || ''
    );
  }

  let preSemanticStructureAudit = structureChunk.buildStructureAudit({
    source: auditSource,
    outputText,
    chunks: frozen ? frozen.auditChunks : chunks,
    plan: chunkPlan,
    boundaryRepair
  });
  const auditVoiceProfile = v2Enabled
    ? buildVoiceProfile(auditSource, { documentProfile, mode: selectedMode })
    : voiceProfile;
  let deterministicAudit = v2Enabled ? qualityV2.buildDeterministicAudit({
    source: auditSource,
    outputText,
    mode: selectedMode,
    contract,
    voiceProfile: auditVoiceProfile,
    documentProfile,
    structureAudit: preSemanticStructureAudit,
    protectedTerms: collectRecordProtectedTerms(records),
    allowedExtra: evidence || userNotes || ''
  }) : null;
  let semanticReport = { ran: false, pass: true, repairCount: 0, sectionCount: 0 };
  if (v2Enabled && !polishStrictFailure) {
    const semanticDecision = experienceCandidateAudit?.candidate === true
      ? { run: true, reason: 'experience_novelty_candidate' }
      : resumeCoverageRetryApplied || (resumeCoverageAudit?.applicable && resumeCoverageAudit?.pass === false)
      ? { run: true, reason: resumeCoverageRetryApplied ? 'resume_coverage_retry' : 'resume_coverage_residual' }
      : endingStyleRetryApplied || endingStyleAudit?.pass === false
      ? { run: true, reason: endingStyleRetryApplied ? 'ending_style_retry' : 'ending_style_residual' }
      : fingerprintRetryApplied || fingerprintAudit?.pass === false
      ? { run: true, reason: fingerprintRetryApplied ? 'fingerprint_retry' : 'fingerprint_residual' }
      : koreanRefinementRetryApplied
      ? { run: true, reason: 'korean_refinement_retry' }
      : humanizationDepthRetryApplied
        ? { run: true, reason: 'humanization_depth_retry' }
        : (humanizationDepthReport?.applicable
            && humanizationDepthReport.pass === false
            && humanizationDepthReport.minimumEffectPass === true)
          ? { run: true, reason: 'humanization_depth_soft_delivery' }
          : qualityV2.shouldRunSemanticJudge({
            requestedMode,
            effectiveMode: selectedMode,
            source: auditSource,
            documentProfile,
            audit: deterministicAudit
          });
    semanticReport.decisionReason = semanticDecision.reason;
    if (semanticDecision.run) {
      semanticReport = await qualityV2.runSemanticDocumentAudit({
        source: auditSource,
        outputText,
        lang,
        signal,
        config: cfg,
        allowedExtra: evidence || userNotes || '',
        mode: selectedMode,
        discourseSignals: [
          ...(deterministicAudit?.discourseAudit?.codes || []),
          ...(fingerprintAudit?.issueCodes || []),
          ...((fingerprintAudit?.semanticRelations?.shifts || [])
            .map(item => `semantic_relation_shift:${item.family}`)),
          ...(experienceCandidateAudit?.candidate ? ['experience_novelty_candidate'] : [])
        ],
        safetyIdentifier: safetyId
      });
      supplementalUsage = addUsage(supplementalUsage, semanticReport.usage);
      outputText = semanticReport.outputText || outputText;
      preSemanticStructureAudit = structureChunk.buildStructureAudit({
        source: auditSource,
        outputText,
        chunks: frozen ? frozen.auditChunks : chunks,
        plan: chunkPlan,
        boundaryRepair
      });
      deterministicAudit = qualityV2.buildDeterministicAudit({
        source: auditSource,
        outputText,
        mode: selectedMode,
        contract,
        voiceProfile: auditVoiceProfile,
        documentProfile,
        structureAudit: preSemanticStructureAudit,
        protectedTerms: collectRecordProtectedTerms(records),
        allowedExtra: evidence || userNotes || ''
      });
    }
  }

  // 의미 수리가 추가 주장 등을 제거하는 과정에서 결과 전체가 원문으로 돌아갈
  // 수 있다. 앞 단계에서 무변환이 아니었다면 기존 회복 루프가 이를 볼 수 없으므로,
  // 최종 레이아웃 전에 한 번 더 재작성하고 의미 심사까지 다시 통과한 후보만 쓴다.
  if (v2Enabled
      && selectedMode !== 'polish'
      && finalNoopRecovery.attempted !== true
      && normalizeBare(auditSource) === normalizeBare(outputText)) {
    finalNoopRecovery.attempted = true;
    const postNoopPlan = humanizationPlan || humanizationDepth.buildHumanizationPlan(auditSource, {
      requestStrength,
      documentProfile,
      inputRisk
    });
    let postNoopDepthReport = humanizationDepth.evaluateHumanizationDepth(
      auditSource,
      outputText,
      postNoopPlan
    );
    let lastRecoveryReason = 'no_substantive_change';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const escalation = attempt > 0;
      try {
        generalSurfaceRetryAttemptCount += 1;
        humanizationDepthRetryCount += 1;
        if (escalation) humanizationDepthEscalationAttemptCount += 1;
        const retried = await qualityV2.retryGeneralSurface({
          source: auditSource,
          currentOutput: outputText,
          humanizationPlan: postNoopPlan,
          humanizationDepthReport: postNoopDepthReport,
          config: cfg,
          signal,
          safetyIdentifier: safetyId,
          model: escalation ? cfg.models.humanizeEscalation : '',
          reasoningEffort: escalation ? cfg.reasoning.escalation : '',
          phase: escalation ? 'post_semantic_noop_escalation' : 'post_semantic_noop_recovery'
        });
        supplementalUsage = addUsage(supplementalUsage, retried.usage);
        humanizationDepthRetryTargetSentenceCount += retried.targetSentenceCount || 0;
        const candidate = String(retried.outputText || '').trim();
        const candidateDepth = humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, postNoopPlan);
        const safeCandidate = isSafeGeneralSurfaceCandidate(
          auditSource,
          candidate,
          contract,
          documentProfile,
          selectedMode
        ) && preservesFinalStructure(
          auditSource,
          candidate,
          frozen ? frozen.auditChunks : chunks,
          chunkPlan,
          boundaryRepair
        );
        if (!safeCandidate || candidateDepth.minimumEffectPass !== true) {
          lastRecoveryReason = !candidate || normalizeBare(candidate) === normalizeBare(auditSource)
            ? 'candidate_unchanged'
            : (!safeCandidate ? 'safety_audit_failed' : 'minimum_effect_failed');
          humanizationDepthRetryRejectedCount += 1;
          addUniqueCode(humanizationDepthRetryRejectionCodes, lastRecoveryReason);
          continue;
        }
        const candidateSemantic = await qualityV2.runSemanticDocumentAudit({
          source: auditSource,
          outputText: candidate,
          lang,
          signal,
          config: cfg,
          allowedExtra: evidence || userNotes || '',
          mode: selectedMode,
          discourseSignals: ['post_semantic_noop_recovery'],
          safetyIdentifier: safetyId
        });
        supplementalUsage = addUsage(supplementalUsage, candidateSemantic.usage);
        const auditedCandidate = String(candidateSemantic.outputText || candidate).trim();
        const auditedDepth = humanizationDepth.evaluateHumanizationDepth(auditSource, auditedCandidate, postNoopPlan);
        const safeAuditedCandidate = candidateSemantic.pass === true
          && auditedDepth.minimumEffectPass === true
          && isSafeGeneralSurfaceCandidate(auditSource, auditedCandidate, contract, documentProfile, selectedMode)
          && preservesFinalStructure(
            auditSource,
            auditedCandidate,
            frozen ? frozen.auditChunks : chunks,
            chunkPlan,
            boundaryRepair
          );
        if (!safeAuditedCandidate) {
          lastRecoveryReason = candidateSemantic.pass === true ? 'post_semantic_safety_failed' : 'semantic_audit_failed';
          humanizationDepthRetryRejectedCount += 1;
          addUniqueCode(humanizationDepthRetryRejectionCodes, lastRecoveryReason);
          continue;
        }
        outputText = auditedCandidate;
        postNoopDepthReport = auditedDepth;
        if (humanizationDepthEnabled) humanizationDepthReport = auditedDepth;
        semanticReport = { ...candidateSemantic, decisionReason: 'post_semantic_noop_recovery' };
        preSemanticStructureAudit = structureChunk.buildStructureAudit({
          source: auditSource,
          outputText,
          chunks: frozen ? frozen.auditChunks : chunks,
          plan: chunkPlan,
          boundaryRepair
        });
        deterministicAudit = qualityV2.buildDeterministicAudit({
          source: auditSource,
          outputText,
          mode: selectedMode,
          contract,
          voiceProfile: auditVoiceProfile,
          documentProfile,
          structureAudit: preSemanticStructureAudit,
          protectedTerms: collectRecordProtectedTerms(records),
          allowedExtra: evidence || userNotes || ''
        });
        generalSurfaceRetryCount += 1;
        humanizationDepthRetryApplied = true;
        finalNoopRecoveryCount = 1;
        finalNoopRecovery = {
          attempted: true,
          applied: true,
          method: escalation ? 'post_semantic_escalation' : 'post_semantic_model',
          reason: 'substantive_humanization'
        };
        acceptGeneralSurfaceRecovery(records);
        break;
      } catch (error) {
        lastRecoveryReason = `retry_error:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`;
        humanizationDepthRetryRejectedCount += 1;
        addUniqueCode(humanizationDepthRetryRejectionCodes, 'retry_error');
      }
    }
    if (finalNoopRecovery.applied !== true) {
      finalNoopRecovery = {
        attempted: true,
        applied: false,
        method: 'post_semantic_model',
        reason: lastRecoveryReason
      };
    }
  }

  const postLayout = layoutNlpEnabled
    ? await safeFormatLayout(outputText, { mode: selectedMode, phase: 'post' })
    : null;
  if (postLayout?.text) outputText = postLayout.text;
  if (frozen) outputText = restoreLockedBlocks(outputText, frozen.blocks);
  const layoutRepair = v2Enabled
    ? structureChunk.restorePostSemanticLayout({
        source: rawSource,
        outputText,
        chunks,
        mode: selectedMode,
        requestStrength,
        documentProfile,
        profileConfidence: documentProfile.confidence
      })
    : { text: outputText, applied: false, pass: true };
  outputText = layoutRepair.text || outputText;
  // 직접 인용은 의미 심사 이후의 일반 어휘 후처리가 아니라 동결 구조다.
  // 의미 수리나 레이아웃 복원에서 내부 내용이 달라졌다면 같은 위치의
  // 원문 인용만 재조립한다.
  if (v2Enabled) {
    const restored = restoreDirectQuoteContents(rawSource, outputText);
    if (restored.applied) {
      outputText = restored.text;
      quoteIntegrityRestoreCount += restored.restoredCount || 1;
      finalQuoteIntegrityRestoreCount = restored.restoredCount || 1;
    }
    quoteIntegrityAudit = auditDirectQuoteIntegrity(rawSource, outputText);
  }
  let polishSpeakerRestore = { applied: false, restoredSentenceCount: 0, restoredKinds: [], reason: 'not_applicable' };
  if (v2Enabled && selectedMode === 'polish') {
    polishSpeakerRestore = qualityV2.restoreMissingPolishSpeaker({
      source: rawSource,
      outputText,
      documentProfile,
      allowLayoutOnlyParagraphChange: layoutRepair?.paragraphs?.policy === 'readable_polish'
    });
    if (polishSpeakerRestore.applied) {
      outputText = polishSpeakerRestore.text;
      polishSpeakerRestoreCount = 1;
      polishSpeakerRestoredSentenceCount = polishSpeakerRestore.restoredSentenceCount || 1;
    }
    layoutRepair.speakerRestore = {
      applied: polishSpeakerRestore.applied === true,
      restoredSentenceCount: polishSpeakerRestore.restoredSentenceCount || 0,
      restoredKinds: polishSpeakerRestore.restoredKinds || [],
      reason: polishSpeakerRestore.reason || ''
    };
  }

  // 의미 심사·동결 블록 재조립·문단 복원이 끝난 뒤에 공백만 바꾼다.
  // 원문에 이미 있던 문장 중간 잘못된 줄바꿈도 이 단계에서 합친다.
  // 논문명·인용·참고문헌·표·창작문 행갈이는 koreanRefinement 내부에서 보호한다.
  if (v2Enabled) {
    finalFormattingRepair = koreanRefinement.applySafeFormattingRepairs({
      source: rawSource,
      outputText,
      documentProfile
    });
    if (finalFormattingRepair.applied) outputText = finalFormattingRepair.text;
    layoutRepair.formatting = {
      version: finalFormattingRepair.version || 1,
      applied: finalFormattingRepair.applied === true,
      changeCount: finalFormattingRepair.changeCount || 0,
      changeCodes: finalFormattingRepair.changeCodes || [],
      brokenLineBreakRepairCount: finalFormattingRepair.brokenLineBreakRepairCount || 0,
      brokenParagraphBreakRepairCount: finalFormattingRepair.brokenParagraphBreakRepairCount || 0,
      excessiveBlankLineRepairCount: finalFormattingRepair.excessiveBlankLineRepairCount || 0,
      missingSentenceSpaceRepairCount: Number(finalFormattingRepair.changeCounts?.missing_sentence_space || 0),
      contextualSpacingRepairCount: finalFormattingRepair.contextualSpacingRepairCount || 0,
      skipped: finalFormattingRepair.skipped === true,
      reason: finalFormattingRepair.reason || ''
    };
  }

  // 의미 감사 이후에는 어휘를 다시 바꾸지 않는다. 수리·동결 블록 재조립·레이아웃
  // 복원으로 실질 변화가 사라지면 아래 최종 깊이 감사가 검토 필요 상태를 기록한다.
  if (v2Enabled && selectedMode === 'polish') {
    polishReport = qualityV2.polishEditPolicy(rawSource, outputText);
    polishPaddingReport = qualityV2.comparePolishEvaluativePadding(rawSource, outputText);
    polishEvaluativePaddingCodes = safeFailureCodeList([
      ...polishEvaluativePaddingCodes,
      ...polishPaddingReport.introducedCodes
    ]);
    if (!polishStrictFailure && polishReport.noSafeChange) polishStrictFailure = 'polish_unchanged';
    if (!polishStrictFailure && polishReport.excessiveChange) polishStrictFailure = 'polish_excessive_change';
    if (!polishStrictFailure && polishPaddingReport.increased) polishStrictFailure = 'polish_evaluative_padding_added';
  }
  if (humanizationDepthEnabled && selectedMode !== 'polish') {
    const finalDepthFrozen = freezeLockedBlocks(rawSource, outputText, chunks);
    const finalDepthSource = finalDepthFrozen?.source || rawSource;
    const finalDepthOutput = finalDepthFrozen?.output || outputText;
    humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(
      finalDepthSource,
      finalDepthOutput,
      humanizationPlan
    );
  }
  if (v2Enabled && selectedMode !== 'polish' && fingerprint.isEnabled()) {
    fingerprintAudit = fingerprint.auditFingerprint(rawSource, outputText);
  }
  if (v2Enabled) endingStyleAudit = endingStyle.auditEndingStyle(rawSource, outputText);
  if (v2Enabled) resumeCoverageAudit = resumeCoverage.auditResumeCoverage(rawSource, outputText, documentProfile);
  if (v2Enabled) quoteIntegrityAudit = auditDirectQuoteIntegrity(rawSource, outputText);
  if (v2Enabled) {
    koreanRefinementAudit = koreanRefinement.analyzeKoreanRefinement({
      source: rawSource,
      outputText,
      documentProfile,
      mode: selectedMode
    });
  }
  const structureAudit = structureChunk.buildStructureAudit({
    source: rawSource,
    outputText,
    chunks,
    plan: chunkPlan,
    boundaryRepair,
    layoutRepair
  });
  const deliveryAudit = v2Enabled ? qualityV2.buildDeterministicAudit({
    source: rawSource,
    outputText,
    mode: selectedMode,
    contract,
    voiceProfile,
    documentProfile,
    structureAudit,
    protectedTerms: extractProtectedTerms(rawSource, documentProfile),
    allowedExtra: evidence || userNotes || ''
  }) : null;
  const result = buildResult({ source: rawSource, outputText, contract, mode: selectedMode, records, inputRisk, niklQualityTest: niklQualityEnabled, qualityPatternLab: qualityPatternLabEnabled, structureAudit });
  if (v2Enabled) calibrateV2RepetitionReport(result, rawSource, outputText);
  if (layoutNlpEnabled) {
    result.layoutFormat = buildLayoutFormatMeta(preLayout, postLayout, rawSource, outputText);
  }
  if (structureAudit && (!structureAudit.pass || structureAudit.boundaryRepair?.applied)) {
    addStructureWarnings(result.floorReport, structureAudit);
  }
  const finalGate = evaluateWholeDocumentGate({
    outputText,
    source: rawSource,
    contract,
    mode: selectedMode,
    sourceSurface,
    allowedExtra: evidence || userNotes || ''
  });
  if (polishStrictFailure) {
    const detail = polishStrictFailure === 'polish_excessive_change'
      ? '보존형 윤문의 안전 편집 범위를 넘어 결과를 전달하지 않았습니다.'
      : polishStrictFailure === 'polish_evaluative_padding_added'
        ? '원문에 없던 평가성 표현을 안전하게 제거하지 못했습니다.'
        : '안전한 최소 표면 수정을 만들지 못했습니다.';
    addFloorCriticals(result.floorReport, [{ gate: polishStrictFailure, detail }], polishStrictFailure);
  } else {
    if (humanizationDepthReport?.applicable && humanizationDepthReport.pass === false) {
      const depthDetail = {
        detail: humanizationDepthReport.minimumEffectPass === false
          ? '실질 변화가 거의 없어 휴머나이징 결과로 전달하지 않았습니다.'
          : '보존을 우선해 목표한 휴머나이징 품질 최소선보다 약하게 나왔습니다.',
        reasons: humanizationDepthReport.reasons,
        blockingReasons: humanizationDepthReport.blockingReasons,
        substantiveEditRatio: humanizationDepthReport.metrics?.substantiveEditRatio,
        minimumSubstantiveEditRatio: humanizationDepthReport.plan?.minSubstantiveEditRatio,
        hardMinimumSubstantiveEditRatio: humanizationDepthReport.plan?.hardMinimumSubstantiveEditRatio,
        changedSentenceCount: humanizationDepthReport.metrics?.substantiveChangedSentenceCount,
        requiredChangedSentenceCount: humanizationDepthReport.plan?.requiredChangedSentenceCount,
        hardRequiredChangedSentenceCount: humanizationDepthReport.plan?.hardRequiredChangedSentenceCount
      };
      const longSectionRecoveryDelivery = rawSource.length >= sectionRecovery.MIN_DOCUMENT_CHARS
        && sectionRecoveryReport.metrics?.enabled === true;
      if (humanizationDepthReport.minimumEffectPass === false && !longSectionRecoveryDelivery) {
        addFloorCriticals(result.floorReport, [{
          ...depthDetail,
          gate: 'humanization_depth_no_effect'
        }], 'humanization_depth_no_effect');
      } else if (humanizationDepthReport.userReviewRequired !== false) {
        addFloorWarnings(result.floorReport, depthWarningDetails(humanizationDepthReport, depthDetail));
      }
    }
    if (finalGate.hardFail) {
      addFloorCriticals(result.floorReport, finalGate.violations, finalGate.reason);
    } else if (finalGate.violations.length || finalGate.warnings.length) {
      addFloorWarnings(result.floorReport, finalGate.violations, finalGate.warnings);
    }
  }
  const fallbackCount = records.filter(r => r.fallback).length;
  const effectiveChunks = records.filter(r => !r.skipped).length;
  const allFallback = effectiveChunks > 0 && fallbackCount >= effectiveChunks;
  const finalEquivalent = normalizeBare(rawSource) === normalizeBare(outputText);
  const allFallbackRecovered = allFallback
    && !finalEquivalent
    && (humanizationDepthReport?.minimumEffectPass === true || finalNoopRecovery.applied === true)
    && (finalNoopRecovery.applied === true
      || humanizationDepthRetryApplied === true
      || Number(sectionRecoveryReport.metrics?.applied || 0) > 0);
  if (finalEquivalent || (allFallback && !allFallbackRecovered)) {
    result.floorReport = result.floorReport || { status: 'blocked', criticals: [], warnings: [] };
    const longRecoveryReview = v2Enabled
      && selectedMode !== 'polish'
      && rawSource.length >= sectionRecovery.MIN_DOCUMENT_CHARS
      && sectionRecoveryReport.metrics?.enabled === true;
    if (!finalEquivalent && longRecoveryReview) {
      result.floorReport.status = 'needs_review';
      result.floorReport.warnings = [
        ...(result.floorReport.warnings || []),
        {
          gate: 'humanization_depth_below_minimum',
          detail: '장문 섹션 회복 후에도 실질 변화가 부족해 결과를 검토용으로 전달합니다.'
        }
      ];
    } else if (!v2Enabled && qualityPatternLabEnabled && !allFallback) {
      result.floorReport.status = result.floorReport.status === 'clean' ? 'needs_review' : result.floorReport.status;
      result.floorReport.warnings = [
        ...(result.floorReport.warnings || []),
        {
          gate: 'quality_pattern_low_effect',
          detail: 'quality pattern lab output is equivalent to source; delivered for audit comparison'
        }
      ];
    } else {
      result.floorReport.status = 'blocked';
      result.floorReport.criticals = result.floorReport.criticals || [];
      result.floorReport.criticals.push({
        gate: finalEquivalent ? 'gpt_noop_unchanged' : 'gpt_all_chunks_fallback',
        detail: finalEquivalent ? 'GPT output is equivalent to source.' : 'All GPT chunks failed hard gates and fell back to source.'
      });
    }
  }
  if (qualityPatternLabEnabled) softenQualityPatternLabFloorReport(result.floorReport);
  if (v2Enabled) softenV2ReviewableCriticals(result.floorReport, {
    mode: selectedMode,
    strictFallbackCause: hasStrictRecordDeliveryFailure(records)
  });
  else softenFloorReport(result.floorReport);

  const usage = addUsage(records.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage()), supplementalUsage);
  const escalatedCount = records.filter(r => r.escalated).length;
  const finalEditMetrics = computeEditMetrics(rawSource, outputText);
  const chunkExecution = summarizeChunkExecution(records, semanticReport, {
    polishRetryCount: polishRetryAttemptCount,
    generalSurfaceRetryCount: generalSurfaceRetryAttemptCount,
    koreanRefinementRetryCount: koreanRefinementRetryAttemptCount,
    fingerprintRetryCount: fingerprintRetryAttemptCount,
    endingStyleRetryCount: endingStyleRetryAttemptCount,
    resumeCoverageRetryCount: resumeCoverageRetryAttemptCount,
    sectionRecoveryCallCount: Number(sectionRecoveryReport.metrics?.miniAttemptCount || 0)
      + Number(sectionRecoveryReport.metrics?.escalationAttemptCount || 0)
  });
  const chunkFailures = summarizeChunkFailureCodes(records);
  const humanizationNoBenefitDelivered = v2Enabled
    && selectedMode !== 'polish'
    && result.floorReport?.status !== 'blocked'
    && ((humanizationDepthReport?.applicable === true
        && humanizationDepthReport?.minimumEffectPass === false)
      || (result.floorReport?.warnings || []).some(item => {
        const gate = String(item?.gate || item?.type || item || '').trim();
        return V2_SAFE_LOW_BENEFIT_GATES.has(gate);
      }));
  const qualityWarnings = v2Enabled
    ? dedupeQualityWarnings([
        ...(deliveryAudit?.warnings || []),
        ...qualityV2.warningsFromSemantic(semanticReport),
        ...(experienceCandidateAudit?.candidate && semanticReport?.uncertain
          ? [{ code: 'experience_novelty', severity: 'warning', message: '새 개인 경험으로 보이는 변화의 의미 심사가 불확실해 원문 대조가 필요해요.' }]
          : []),
        ...(records.some(record => (record.warnings || []).includes('v2_residual:structure_boundary_marker_failed'))
          ? [{ code: 'sentence_distribution_shift', severity: 'warning', message: '원문의 문장 경계 일부가 결과에서 달라졌을 수 있어요.' }]
          : []),
        ...(records.some(record => (record.warnings || []).includes('v2_residual:voice_existing_distribution_failed'))
          ? [{ code: 'sentence_distribution_shift', severity: 'warning', message: '원문의 장단문 분포가 결과에서 다소 평탄해졌을 수 있어요.' }]
          : []),
        ...(polishReport?.excessiveChange ? [{ code: 'polish_edit_range', severity: 'warning', message: '보존형 윤문의 권장 편집 범위를 넘었을 수 있어요.' }] : []),
        ...(structureAudit?.lostLockedCount > 0 ? [{ code: 'structure_lock_loss', severity: 'warning', message: '동결 구조 일부가 달라졌을 수 있어요.' }] : []),
        ...(humanizationDepthReport?.applicable
          && humanizationDepthReport.pass === false
          && humanizationDepthReport.userReviewRequired !== false
          ? depthQualityWarnings(humanizationDepthReport)
          : []),
        ...(humanizationNoBenefitDelivered
          ? [{ code: 'humanization_depth_below_minimum', severity: 'warning', message: '안전한 범위에서 충분한 변화를 만들기 어려워 원문에 가까운 결과를 전달했어요.' }]
          : []),
        ...(fingerprintAudit?.issueCodes?.includes('engine_phrase_fingerprint')
          ? [{ code: 'engine_phrase_fingerprint', severity: 'warning', message: '엔진이 만든 상투 표현이 한 문서에서 반복됐을 수 있어요.' }]
          : []),
        ...(fingerprintAudit?.issueCodes?.includes('contrast_relation_shift')
          ? [{ code: 'contrast_relation_shift', severity: 'warning', message: '부정·배제 관계가 인정·가산 관계로 달라졌을 수 있어 원문 대조가 필요해요.' }]
          : []),
        ...(fingerprintAudit?.issueCodes?.includes('semantic_relation_shift')
          ? [{ code: 'semantic_relation_shift', severity: 'warning', message: '목적·근거·대조·가능성 또는 행위 방향이 원문과 달라졌을 수 있어요.' }]
          : []),
        ...(endingStyleAudit?.pass === false
          ? [{ code: 'ending_style_mixed', severity: 'warning', message: '원문에 없던 종결체가 일부 섹션에 섞였을 수 있어요.' }]
          : []),
        ...(resumeCoverageAudit?.applicable && resumeCoverageAudit?.pass === false
          ? [{ code: 'resume_claim_omission', severity: 'warning', message: '자기소개서의 행동·역량·성과·직무 연결 내용 일부가 누락됐을 수 있어요.' }]
          : []),
        ...(koreanRefinementAudit?.residualWarnings || [])
      ])
    : [];
  const strictBlocked = result.floorReport?.status === 'blocked';
  const qualityStatus = strictBlocked || qualityWarnings.length || result.floorReport?.status === 'needs_review' ? 'needs_review' : 'clean';
  if (!strictBlocked && qualityStatus === 'needs_review' && result.floorReport?.status === 'clean') result.floorReport.status = 'needs_review';
  result.qualityStatus = qualityStatus;
  result.qualityWarnings = qualityWarnings;
  result.naturalnessShadow = deliveryAudit?.naturalnessShadow || null;
  result.documentProfile = documentProfile;
  result.voiceProfile = voiceProfile;
  result.semanticAudit = semanticReport;
  result.editMetrics = finalEditMetrics;
  result.humanizationDepth = humanizationDepthReport;
  result.koreanRefinement = koreanRefinementAudit;
  result.sourceReviewWarnings = sourceReviewWarnings;
  result.sourcePreflight = sourcePreflightAudit ? {
    version: sourcePreflightAudit.version || 1,
    changed: sourcePreflightAudit.changed === true,
    removedLineCount: Number(sourcePreflightAudit.removedLineCount || 0),
    noticeCount: Number(sourcePreflightAudit.noticeCount || 0),
    issueCodes: safeFailureCodeList(sourcePreflightAudit.issueCodes)
  } : null;
  result.dedupeAudit = postprocessMeta.dedupe || null;
  result.engineMeta = {
    schemaVersion: 2,
    engineVersion: v2Enabled ? VERSION : LEGACY_VERSION,
    requestedMode,
    requestStrength,
    effectiveMode: selectedMode,
    documentProfile: documentProfile.profile,
    profileConfidence: documentProfile.confidence,
    profileDecisionSource: documentProfile.profileDecisionSource || documentProfile.source || 'unknown',
    detectedDocumentProfile: documentProfile.detectedProfile || documentProfile.profile,
    detectedProfileConfidence: documentProfile.detectedProfileConfidence ?? documentProfile.confidence,
    requestedDocumentProfile: documentProfile.requestedDocumentProfile || '',
    profileOverrideApplied: documentProfile.profileOverrideApplied === true,
    profileOverrideIgnoredReason: documentProfile.profileOverrideIgnoredReason || '',
    candidateProfiles: documentProfile.candidateProfiles || documentProfile.candidates || [],
    safetyProfiles: documentProfile.safetyProfiles || [],
    profileMargin: documentProfile.profileMargin ?? 0,
    formatProfile: documentProfile.formatProfile || { length: 'standard', primary: 'plain', flags: [] },
    lineBoundaryPolicy,
    paragraphRepairPolicy: layoutRepair?.paragraphs?.policy || 'none',
    paragraphRoleBoundaryCount: Number(layoutRepair?.paragraphs?.roleBoundaryCount || 0),
    paragraphReadability: layoutRepair?.paragraphs?.readability || null,
    riskFlags: documentProfile.riskFlags || [],
    tonePolicy: documentProfile.tonePolicy || 'source_preserve',
    targetRegister: documentProfile.targetRegister || documentProfile.tonePolicy || 'source_preserve',
    targetRegisterSource: documentProfile.targetRegisterSource || 'legacy',
    targetRegisterStrength: documentProfile.targetRegisterStrength || requestStrength,
    basicStyle: documentProfile.basicStyle || String(basicStyle || ''),
    semanticJudgeRan: semanticReport.ran === true,
    discourseAuditVersion: Number(deliveryAudit?.discourseAudit?.version || 0),
    discoursePass: v2Enabled ? deliveryAudit?.discourseAudit?.pass !== false : null,
    discourseWarningCodes: safeFailureCodeList(deliveryAudit?.discourseAudit?.codes),
    discourseSignalCount: Number(deliveryAudit?.discourseAudit?.violations?.length || 0),
    discourseRepairRan: (semanticReport.initialViolations || []).some(item => discourseAudit.isDiscourseViolationCode(item?.type))
      && Number(semanticReport.repairCount || 0) > 0,
    repairCount: (semanticReport.repairCount || 0)
      + polishRetryCount
      + generalSurfaceRetryCount
      + polishSpeakerRestoreCount
      + (koreanDeterministicRepairCount > 0 ? 1 : 0)
      + koreanRefinementRetryCount
      + (quoteIntegrityRestoreCount > 0 ? 1 : 0)
      + fingerprintRepairCount
      + endingStyleRepairCount
      + resumeCoverageRepairCount,
    chunkCount: records.length,
    logicalChunkCount: chunkExecution.logicalChunkCount,
    editableChunkCount: chunkExecution.editableChunkCount,
    lockedChunkCount: chunkExecution.lockedChunkCount,
    skippedChunkCount: chunkExecution.skippedChunkCount,
    transformedChunkCount: chunkExecution.transformedChunkCount,
    humanizeCallCount: chunkExecution.humanizeCallCount,
    semanticModelCallCount: chunkExecution.semanticModelCallCount,
    surfaceRetryCallCount: chunkExecution.surfaceRetryCallCount,
    modelCallCount: chunkExecution.modelCallCount,
    semanticSectionCount: chunkExecution.semanticSectionCount,
    chunkFailureCodes: chunkFailures.all,
    chunkPrimaryFailureCodes: chunkFailures.primary,
    chunkResidualFailureCodes: chunkFailures.residual,
    chunkFallbackReasonCodes: chunkFailures.fallback,
    fallbackCount,
    lengthRatio: Number(finalEditMetrics.lengthRatio.toFixed(4)),
    polishSpeakerRestoreCount,
    polishSpeakerRestoredSentenceCount,
    polishRetryReason,
    polishEvaluativePaddingCodes,
    polishDeterministicPaddingRestoreCount,
    finalNoopRecoveryCount,
    finalNoopRecoveryAttempted: finalNoopRecovery.attempted === true,
    finalNoopRecoveryApplied: finalNoopRecovery.applied === true,
    finalNoopRecoveryMethod: finalNoopRecovery.applied ? finalNoopRecovery.method : '',
    finalNoopRecoveryReason: finalNoopRecovery.reason || '',
    humanizationDepthEnabled,
    humanizationDepthApplicable: humanizationDepthReport?.applicable === true,
    humanizationDepthPass: humanizationDepthReport?.pass === true,
    humanizationMinimumEffectPass: humanizationDepthReport?.minimumEffectPass === true,
    humanizationEffectStatus: humanizationDepthReport?.effectStatus || '',
    humanizationDepthUserReviewRequired: humanizationDepthReport?.userReviewRequired === true,
    humanizationDepthUserReviewReasons: safeFailureCodeList(humanizationDepthReport?.userReviewReasons),
    humanizationDepthShadowReasons: safeFailureCodeList(humanizationDepthReport?.shadowReasons),
    humanizationDepthSoftDelivered: humanizationDepthReport?.applicable === true
      && humanizationDepthReport?.pass === false
      && humanizationDepthReport?.minimumEffectPass === true,
    humanizationNoBenefitDelivered,
    humanizationPolicyVersion: humanizationDepthEnabled
      ? (humanizationDepthReport?.plan?.policyVersion || humanizationDepth.POLICY_VERSION)
      : '',
    humanizationPlanSignalSource: humanizationDepthReport?.plan?.signalSource || '',
    humanizationRiskLevel: humanizationDepthReport?.plan?.riskLevel || '',
    humanizationMinimumRatio: Number(humanizationDepthReport?.plan?.minSubstantiveEditRatio || 0),
    humanizationHardMinimumRatio: Number(humanizationDepthReport?.plan?.hardMinimumSubstantiveEditRatio || 0),
    humanizationTargetMinRatio: Number(humanizationDepthReport?.plan?.targetSubstantiveEditMin || 0),
    humanizationTargetMaxRatio: Number(humanizationDepthReport?.plan?.targetSubstantiveEditMax || 0),
    humanizationRequiredSentenceRatio: Number(humanizationDepthReport?.plan?.minChangedSentenceRatio || 0),
    humanizationHardRequiredSentenceCount: Number(humanizationDepthReport?.plan?.hardRequiredChangedSentenceCount || 0),
    humanizationMinimumTargetCoverage: Number(humanizationDepthReport?.plan?.minTargetCoverage || 0),
    substantiveEditRatio: Number(humanizationDepthReport?.metrics?.substantiveEditRatio || 0),
    substantiveChangedSentenceRatio: Number(humanizationDepthReport?.metrics?.substantiveChangedSentenceRatio || 0),
    substantiveCarryoverCount: Number(humanizationDepthReport?.metrics?.substantiveCarryoverCount || 0),
    substantiveCarryoverRatio: Number(humanizationDepthReport?.metrics?.substantiveCarryoverRatio || 0),
    substantiveCarryoverEligibleSentenceCount: Number(humanizationDepthReport?.metrics?.substantiveCarryoverEligibleSentenceCount || 0),
    substantiveCarryoverMaximum: Number(humanizationDepthReport?.plan?.maxSubstantiveCarryoverRatio || 1),
    humanizationTargetCoverage: Number(humanizationDepthReport?.metrics?.targetCoverage || 0),
    humanizationTargetChangedCount: Number(humanizationDepthReport?.metrics?.targetChangedCount || 0),
    humanizationTargetDepthMet: humanizationDepthReport?.metrics?.targetDepthMet === true,
    humanizationDeliveryDepthBand: humanizationDepthReport?.metrics?.deliveryDepthBand || '',
    humanizationDepthRetryCount,
    humanizationDepthEscalationAttemptCount,
    humanizationNoEffectRetryAttemptCount,
    humanizationRoleRecoveryAttemptCount,
    humanizationDepthRetryApplied,
    humanizationDepthRetryTargetSentenceCount,
    humanizationDepthRetryRejectedCount,
    humanizationDepthRetryRejectionCodes,
    sectionRecoveryEnabled: sectionRecoveryReport.metrics?.enabled === true,
    sectionRecoveryAttemptCount: Number(sectionRecoveryReport.metrics?.attempted || 0),
    sectionRecoveryPreferredSectionCount: Number(sectionRecoveryReport.metrics?.selectedPreferredSectionCount || 0),
    sectionRecoveryFragmentCount: Number(sectionRecoveryReport.metrics?.selectedFragmentCount || 0),
    sectionRecoveryAppliedCount: Number(sectionRecoveryReport.metrics?.applied || 0),
    sectionRecoveryEscalationCount: Number(sectionRecoveryReport.metrics?.escalated || 0),
    sectionRecoveryConcurrency: Number(sectionRecoveryReport.metrics?.concurrency || 0),
    sectionRecoveryRejectedAttemptCount: Number(sectionRecoveryReport.metrics?.rejectedAttemptCount || 0),
    sectionRecoveryRejectionCodes: safeFailureCodeList(sectionRecoveryReport.metrics?.rejectionCodes),
    sectionRecoveryRejectionCodeCounts: sanitizeCountMap(sectionRecoveryReport.metrics?.rejectionCodeCounts),
    sectionRecoveryMiniAppliedCount: Number(sectionRecoveryReport.metrics?.miniAppliedCount || 0),
    sectionRecoveryEscalationAppliedCount: Number(sectionRecoveryReport.metrics?.escalationAppliedCount || 0),
    humanizationDepthReasonCodes: safeFailureCodeList(humanizationDepthReport?.reasons),
    humanizationDepthBlockingReasonCodes: safeFailureCodeList(humanizationDepthReport?.blockingReasons),
    structuralChangedSentenceCount: Number(humanizationDepthReport?.metrics?.structurallyChangedSentenceCount || 0),
    structuralChangedSentenceRatio: Number(humanizationDepthReport?.metrics?.structuralChangedSentenceRatio || 0),
    materiallyRecastSentenceCount: Number(humanizationDepthReport?.metrics?.materiallyRecastSentenceCount || 0),
    effectiveStructuralChangedSentenceCount: Number(humanizationDepthReport?.metrics?.effectiveStructuralChangedSentenceCount || 0),
    clauseLevelStructuralAlternative: humanizationDepthReport?.metrics?.clauseLevelStructuralAlternative === true,
    humanizationRequiredStructuralSentenceCount: Number(humanizationDepthReport?.plan?.requiredStructuralChangedSentenceCount || 0),
    humanizationParagraphCoverageApplicable: humanizationDepthReport?.plan?.paragraphCoverageApplicable === true,
    humanizationEligibleParagraphCount: Number(humanizationDepthReport?.plan?.eligibleParagraphCount || 0),
    humanizationTargetParagraphCount: Number(humanizationDepthReport?.plan?.targetParagraphCount || 0),
    humanizationRequiredTargetParagraphCount: Number(humanizationDepthReport?.plan?.requiredTargetChangedParagraphCount || 0),
    humanizationTargetChangedParagraphCount: Number(humanizationDepthReport?.metrics?.targetChangedParagraphCount || 0),
    humanizationTargetParagraphCoverage: Number(humanizationDepthReport?.metrics?.targetParagraphCoverage || 0),
    rhetoricalRemediationTargetCount: Number(humanizationDepthReport?.metrics?.remediation?.targetCount || 0),
    rhetoricalRemediationAchievedCount: Number(humanizationDepthReport?.metrics?.remediation?.achievedReduction || 0),
    rhetoricalRemediationCoverage: Number(humanizationDepthReport?.metrics?.remediation?.coverage || 0),
    resumeRepetitionAuditVersion: Number(humanizationDepthReport?.metrics?.resumeRepetition?.version || 0),
    resumeRepetitionApplicable: humanizationDepthReport?.metrics?.resumeRepetition?.applicable === true,
    resumeRepetitionPass: humanizationDepthReport?.metrics?.resumeRepetition?.pass === true,
    resumeRepetitionThemeCount: Number(humanizationDepthReport?.metrics?.resumeRepetition?.themeCount || 0),
    resumeRepetitionSourcePairCount: Number(humanizationDepthReport?.metrics?.resumeRepetition?.sourcePairCount || 0),
    resumeRepetitionResidualPairCount: Number(humanizationDepthReport?.metrics?.resumeRepetition?.residualPairCount || 0),
    resumeRepetitionRequiredReduction: Number(humanizationDepthReport?.metrics?.resumeRepetition?.requiredReduction || 0),
    resumeRepetitionAchievedReduction: Number(humanizationDepthReport?.metrics?.resumeRepetition?.achievedReduction || 0),
    resumeRepetitionCoverage: Number(humanizationDepthReport?.metrics?.resumeRepetition?.coverage ?? 1),
    fingerprintAuditVersion: Number(fingerprintAudit?.version || 0),
    fingerprintPass: fingerprintAudit ? fingerprintAudit.pass === true : null,
    fingerprintIssueCodes: safeFailureCodeList(fingerprintAudit?.issueCodes),
    fingerprintIntroducedCount: Number(fingerprintAudit?.introducedCount || 0),
    fingerprintExcessIntroducedCount: Number(fingerprintAudit?.excessIntroducedCount || 0),
    semanticRelationShiftCount: Number(fingerprintAudit?.semanticRelations?.count || 0),
    semanticRelationShiftFamilies: safeFailureCodeList((fingerprintAudit?.semanticRelations?.shifts || []).map(item => item.family)),
    fingerprintRetryAttemptCount,
    fingerprintRepairCount,
    fingerprintRetryApplied,
    fingerprintShadow: Array.isArray(fingerprintAudit?.shadow) ? fingerprintAudit.shadow.slice(0, 8) : [],
    fingerprintShadowPositiveCodes: safeFailureCodeList((fingerprintAudit?.shadow || [])
      .filter(item => Number(item?.delta || 0) > 0)
      .map(item => item.code)),
    fingerprintShadowPositiveCount: (fingerprintAudit?.shadow || [])
      .reduce((sum, item) => sum + Math.max(0, Number(item?.delta || 0)), 0),
    endingStyleAuditVersion: Number(endingStyleAudit?.version || 0),
    endingStylePass: endingStyleAudit?.pass === true,
    endingStyleIssueCount: Number(endingStyleAudit?.issueCount || 0),
    endingStyleIntroducedOtherCount: Number(endingStyleAudit?.introducedOtherCount || 0),
    endingStyleRetryAttemptCount,
    endingStyleRepairCount,
    endingStyleRetryApplied,
    resumeCoverageAuditVersion: Number(resumeCoverageAudit?.version || 0),
    resumeCoverageApplicable: resumeCoverageAudit?.applicable === true,
    resumeCoveragePass: resumeCoverageAudit?.pass === true,
    resumeClaimCount: Number(resumeCoverageAudit?.claimCount || 0),
    resumeCoveredClaimCount: Number(resumeCoverageAudit?.coveredClaimCount || 0),
    resumeCoverageRatio: Number(resumeCoverageAudit?.coverageRatio ?? 1),
    resumeCoverageMinimumRecall: Number(resumeCoverageAudit?.minimumObservedRecall ?? 1),
    resumeCoverageRetryAttemptCount,
    resumeCoverageRepairCount,
    resumeCoverageRetryApplied,
    experienceCandidateVersion: Number(experienceCandidateAudit?.version || 0),
    experienceNoveltyCandidate: experienceCandidateAudit?.candidate === true,
    experienceNoveltyCandidateCount: Number(experienceCandidateAudit?.candidateCount || 0),
    experienceNoveltyConfirmed: (semanticReport?.violations || []).some(item => item?.type === 'experience_novelty'),
    experienceNoveltyUncertain: experienceCandidateAudit?.candidate === true && semanticReport?.uncertain === true,
    koreanRefinementVersion: Number(koreanRefinementAudit?.version || 0),
    koreanRefinementPass: koreanRefinementAudit?.pass === true,
    koreanRefinementIssueCodes: safeFailureCodeList(koreanRefinementAudit?.issueCodes),
    koreanRefinementIntroducedIssueCount: Number(koreanRefinementAudit?.introducedIssueCount || 0),
    formalRegisterResidualCount: Number((koreanRefinementAudit?.issues || [])
      .find(item => item.code === 'formal_register_residual')?.afterCount || 0),
    koreanDeterministicRepairCount,
    koreanRefinementRetryAttemptCount,
    koreanRefinementRetryCount,
    koreanRefinementRetryApplied,
    quoteIntegrityAuditVersion: Number(quoteIntegrityAudit?.version || 0),
    quoteIntegrityPass: quoteIntegrityAudit?.pass === true,
    quoteCountChanged: quoteIntegrityAudit?.countChanged === true,
    quoteContentChangedCount: Number(quoteIntegrityAudit?.changedCount || 0),
    quoteIntegrityRestoreCount,
    finalQuoteIntegrityRestoreCount,
    finalFormattingRepairCount: Number(finalFormattingRepair.changeCount || 0),
    finalFormattingRepairCodes: safeFailureCodeList(finalFormattingRepair.changeCodes),
    brokenLineBreakRepairCount: Number(finalFormattingRepair.brokenLineBreakRepairCount || 0),
    brokenParagraphBreakRepairCount: Number(finalFormattingRepair.brokenParagraphBreakRepairCount || 0),
    excessiveBlankLineRepairCount: Number(finalFormattingRepair.excessiveBlankLineRepairCount || 0),
    missingSentenceSpaceRepairCount: Number(finalFormattingRepair.changeCounts?.missing_sentence_space || 0),
    contextualSpacingRepairCount: Number(finalFormattingRepair.contextualSpacingRepairCount || 0),
    sourceReviewWarningCodes: safeFailureCodeList(sourceReviewWarnings.map(item => item.code)),
    sourceReviewWarningCount: sourceReviewWarnings.length,
    sourcePreflightVersion: Number(sourcePreflightAudit?.version || 0),
    sourcePreflightChanged: sourcePreflightAudit?.changed === true,
    sourceArtifactRemovedCount: Number(sourcePreflightAudit?.removedArtifactCount || 0),
    sourcePreflightNoticeCount: Number(sourcePreflightAudit?.noticeCount || 0),
    sourcePreflightIssueCodes: safeFailureCodeList(sourcePreflightAudit?.issueCodes)
  };
  result.humanizeMeta = {
    provider: 'openai',
    engine: v2Enabled ? VERSION : LEGACY_VERSION,
    profile: PROFILE,
    selectedModel: cfg.models.humanizePrimary,
    escalationModel: cfg.models.humanizeEscalation,
    escalated: escalatedCount > 0,
    escalationCount: escalatedCount,
    chunkCount: records.length,
    logicalChunkCount: chunkExecution.logicalChunkCount,
    editableChunkCount: chunkExecution.editableChunkCount,
    lockedChunkCount: chunkExecution.lockedChunkCount,
    skippedChunkCount: chunkExecution.skippedChunkCount,
    transformedChunkCount: chunkExecution.transformedChunkCount,
    humanizeCallCount: chunkExecution.humanizeCallCount,
    semanticModelCallCount: chunkExecution.semanticModelCallCount,
    surfaceRetryCallCount: chunkExecution.surfaceRetryCallCount,
    modelCallCount: chunkExecution.modelCallCount,
    fallbackCount,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    estimatedUsd: usage.estimatedUsd,
    usage,
    structureLock: result.structureLock || null,
    koreanQuality: result.koreanQuality || null,
    niklQuality: niklQualityEnabled ? (result.niklQualityTest || { enabled: true }) : null,
    niklQualityTest: niklQualityEnabled ? (result.niklQualityTest || { enabled: true }) : null,
    qualityPatternLab: qualityPatternLabEnabled ? (result.qualityPatternLab || { enabled: true }) : null,
    layoutFormat: layoutNlpEnabled ? (result.layoutFormat || { enabled: true }) : null,
    naturalnessShadow: deliveryAudit?.naturalnessShadow || null,
    koreanRefinement: koreanRefinementAudit,
    sourcePreflight: result.sourcePreflight,
    sourceReviewWarnings,
    layoutRepair: result.structureLock?.layoutRepair || null,
    dedupeAudit: result.dedupeAudit ? {
      removedExactCount: result.dedupeAudit.removedExactCount || 0,
      removedBlockCount: result.dedupeAudit.removedBlockCount || 0,
      removedBlockSentenceCount: result.dedupeAudit.removedBlockSentenceCount || 0,
      fuzzyWarningCount: result.dedupeAudit.fuzzyWarningCount || 0,
      skipped: result.dedupeAudit.skipped === true,
      reason: result.dedupeAudit.reason || ''
    } : null,
    engineMeta: result.engineMeta,
    runtimeConfigSource: cfg.source,
    styleProfile: styleProfile || PROFILE
  };

  return {
    result,
    surface: result.surface,
    inputRisk,
    mode: selectedMode,
    lang,
    chunked: true,
    chunkCount: chunks.length,
    status: result.floorReport.status,
    floorReport: result.floorReport,
    qualityStatus,
    qualityWarnings,
    sourceReviewWarnings,
    engineMeta: result.engineMeta,
    chunks: records,
    fallbackCount,
    gptEngine: result.humanizeMeta
  };
}

async function processChunk({ chunk, chunks, index, source, contract, inputRisk, sourceSurface, mode, requestStrength = '', lang, userNotes, evidence, cfg, styleProfile, documentProfile, voiceProfile, niklQualityTest = false, qualityPatternLab = false, safetyIdentifier = '', v2Enabled = false, signal }) {
  const original = chunk.text;
  if (chunk.locked) {
    chunk.outputText = original;
    return chunkRecord({
      chunk,
      outputText: original,
      skipped: true,
      locked: true,
      lockType: chunk.lockType || 'structure',
      warnings: [chunk.skipReason || 'structure_locked']
    });
  }
  if (shouldPassThrough(original) && mode !== 'polish') {
    chunk.outputText = original;
    return chunkRecord({ chunk, outputText: original, skipped: true });
  }
  const protectedTerms = extractProtectedTerms(original, documentProfile);
  const patchTargets = buildPatchTargets(original, mode);
  const highRisk = isHighRiskChunk(original, protectedTerms, patchTargets, cfg, inputRisk);
  const primaryReasoning = highRisk ? cfg.reasoning.factDense : cfg.reasoning.humanize;
  const chunkSurface = safeSurface(original) || sourceSurface;

  const first = await callHumanize({
    original,
    chunk,
    chunks,
    index,
    source,
    contract,
    inputRisk,
    sourceSurface: chunkSurface,
    mode,
    requestStrength,
    lang,
    userNotes,
    evidence,
    cfg,
    model: cfg.models.humanizePrimary,
    reasoningEffort: primaryReasoning,
    phase: 'primary',
    protectedTerms,
    patchTargets,
    styleProfile,
    documentProfile,
    voiceProfile,
    niklQualityTest,
    qualityPatternLab,
    runSemanticJudge: v2Enabled ? false : highRisk,
    v2Enabled,
    safetyIdentifier,
    signal
  });
  if (v2Enabled && mode === 'polish' && first.hardFail && first.record?.hardFailReason === 'noop_unchanged') {
    chunk.outputText = first.outputText;
    first.record.fallback = false;
    first.record.error = null;
    first.record.warnings = [...(first.record.warnings || []), 'polish_chunk_unchanged_allowed'];
    return first.record;
  }
  if (!first.hardFail || cfg.escalation.enabled === false) {
    chunk.outputText = first.hardFail ? original : first.outputText;
    return first.record;
  }

  const escalationPatchTargets = v2Enabled
    ? buildV2EscalationPatchTargets(patchTargets, first.record)
    : patchTargets;

  const second = await callHumanize({
    original,
    chunk,
    chunks,
    index,
    source,
    contract,
    inputRisk,
    sourceSurface: chunkSurface,
    mode,
    requestStrength,
    lang,
    userNotes,
    evidence,
    cfg,
    model: cfg.models.humanizeEscalation,
    reasoningEffort: cfg.reasoning.escalation,
    phase: 'escalation',
    protectedTerms,
    patchTargets: escalationPatchTargets,
    styleProfile,
    documentProfile,
    voiceProfile,
    niklQualityTest,
    qualityPatternLab,
    runSemanticJudge: v2Enabled ? false : highRisk,
    v2Enabled,
    safetyIdentifier,
    signal
  });
  second.record.primaryFailureCodes = safeFailureCodesFromRecord(first.record);
  if (!second.hardFail) {
    chunk.outputText = second.outputText;
    second.record.escalated = true;
    second.record.primaryError = first.record.error || first.record.hardFailReason;
    second.record.primaryUsage = first.record.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record.usage);
    return second.record;
  }

  const reviewableBoundaryReasons = new Set(['structure_boundary_marker_failed', 'noop_unchanged']);
  const boundaryFailureReasons = [first.record?.hardFailReason, second.record?.hardFailReason];
  if (v2Enabled
      && boundaryFailureReasons.includes('structure_boundary_marker_failed')
      && boundaryFailureReasons.every(reason => reviewableBoundaryReasons.has(reason))) {
    // 두 모델이 원문 경계 토큰을 지키지 못한 결과는 그대로 전달하지 않는다.
    // polish는 뒤의 1회 표면 수정 단계가 원문에서 다시 시작하고, 일반 모드는
    // 원문 기반 실질 휴머나이징 재시도로 회복할 수 있도록 안전 fallback으로 표시한다.
    chunk.outputText = original;
    const needsGeneralSurfaceRetry = mode !== 'polish';
    second.record.fallback = needsGeneralSurfaceRetry;
    second.record.error = needsGeneralSurfaceRetry ? 'structure_boundary_marker_failed' : null;
    second.record.hardFailReason = needsGeneralSurfaceRetry ? 'structure_boundary_marker_failed' : '';
    second.record.escalated = true;
    second.record.primaryError = first.record.hardFailReason;
    second.record.primaryUsage = first.record.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record.usage);
    second.record.warnings = [
      ...(second.record.warnings || []),
      'v2_residual:structure_boundary_marker_failed',
      ...(needsGeneralSurfaceRetry
        ? ['general_surface_retry_pending', 'general_surface_retry_safe_fallback']
        : ['polish_surface_boundary_pending'])
    ];
    return second.record;
  }

  if (v2Enabled
      && first.record?.hardFailReason === 'voice_sparse_distribution_failed'
      && second.record?.hardFailReason === 'voice_sparse_distribution_failed') {
    // 구두점 없는 장문은 원문 그대로 되돌리면 다시 거대한 한 문장이 된다.
    // 상위 모델도 길이 분포 계약을 완전히 맞추지 못한 경우, 사실·구조 게이트를
    // 통과한 2차 결과를 전달하고 최종 voice 감사에서 검토 경고를 노출한다.
    chunk.outputText = second.outputText;
    second.record.fallback = false;
    second.record.error = null;
    second.record.hardFailReason = '';
    second.record.escalated = true;
    second.record.primaryError = first.record.hardFailReason;
    second.record.primaryUsage = first.record.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record.usage);
    second.record.warnings = [...(second.record.warnings || []), 'v2_residual:voice_sparse_distribution_failed'];
    return second.record;
  }

  if (v2Enabled && isReviewableResidualPovAttempt(second)) {
    // 화자 보존 위반은 상위 모델로 한 번 수리한 뒤에도 남을 수 있다. 빈 출력·
    // 손상·숫자/보호어/구조 위반이 함께 없는 후보라면 원문으로 되돌려 no-op
    // 차단을 만들지 않고, 전체 문서 의미 감사와 voice 감사에서 다시 점검한 뒤
    // needs_review로 전달한다. 이는 v2의 "수리 후 의미·화자 경고 전달" 정책이다.
    chunk.outputText = second.outputText;
    second.record.fallback = false;
    second.record.error = null;
    second.record.hardFailReason = '';
    second.record.escalated = true;
    second.record.primaryError = first.record?.hardFailReason || first.record?.error || '';
    second.record.primaryUsage = first.record?.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record?.usage);
    second.record.warnings = [...(second.record.warnings || []), 'v2_residual:pov'];
    return second.record;
  }

  const voiceReviewAttempts = [first, second]
    .filter(attempt => attempt.record?.hardFailReason === 'voice_existing_distribution_failed');
  if (v2Enabled
      && voiceReviewAttempts.length > 0
      && [first.record, second.record].every(isRecoverableSurfaceFallbackRecord)) {
    // 두 모델이 원문의 장단문 분포를 지키지 못했으면 그중 덜 나쁜 결과를
    // 임의로 전달하지 않는다. 원문으로 되돌린 뒤 사실·구조·voice를 보존한
    // 실질 휴머나이징을 정확히 한 번 수행하고, 동일 voice 계약을 통과할 때만
    // 채택한다. naturalness shadow 점수는 이 경로에 사용하지 않는다.
    chunk.outputText = original;
    second.record.fallback = true;
    second.record.error = 'voice_existing_distribution_failed';
    second.record.hardFailReason = 'voice_existing_distribution_failed';
    second.record.escalated = true;
    second.record.primaryError = first.record.hardFailReason;
    second.record.primaryUsage = first.record.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record.usage);
    second.record.floorViolations = [
      ...(first.record?.floorViolations || []),
      ...(second.record?.floorViolations || [])
    ];
    second.record.warnings = [
      ...(second.record?.warnings || []),
      'v2_residual:voice_existing_distribution_failed',
      'general_surface_retry_pending',
      'general_surface_retry_safe_fallback'
    ];
    return second.record;
  }

  if (v2Enabled
      && mode !== 'polish'
      && first.record?.hardFailReason === 'noop_unchanged'
      && second.record?.hardFailReason === 'noop_unchanged') {
    chunk.outputText = second.outputText;
    second.record.fallback = false;
    second.record.error = null;
    second.record.escalated = true;
    second.record.primaryError = first.record.hardFailReason;
    second.record.primaryUsage = first.record.usage || null;
    second.record.usage = addUsage(second.record.usage || emptyUsage(), first.record.usage);
    second.record.warnings = [...(second.record.warnings || []), 'general_surface_retry_pending'];
    return second.record;
  }

  const safeFallbackSurfaceRetry = v2Enabled
    && mode !== 'polish'
    && [first.record, second.record].every(isRecoverableSurfaceFallbackRecord);
  chunk.outputText = original;
  return chunkRecord({
    chunk,
    outputText: original,
    fallback: true,
    escalated: true,
    error: second.record.error || second.record.hardFailReason || first.record.error || 'gpt_hard_gate_failed',
    warnings: [
      'gpt_primary_and_escalation_failed',
      ...(safeFallbackSurfaceRetry ? ['general_surface_retry_pending', 'general_surface_retry_safe_fallback'] : [])
    ],
    primaryFailureCodes: safeFailureCodeList([
      ...safeFailureCodesFromRecord(first.record),
      ...safeFailureCodesFromRecord(second.record)
    ]),
    floorViolations: [...(first.record.floorViolations || []), ...(second.record.floorViolations || [])],
    usage: addUsage(first.record.usage || emptyUsage(), second.record.usage),
    elapsedMs: (first.record.elapsedMs || 0) + (second.record.elapsedMs || 0)
  });
}

async function callHumanize(args) {
  const {
    original, chunk, chunks, index, source, contract, inputRisk, sourceSurface, mode, requestStrength, lang, userNotes, evidence,
    cfg, model, reasoningEffort, phase, protectedTerms, patchTargets, styleProfile, documentProfile, voiceProfile,
    niklQualityTest = false, qualityPatternLab = false, runSemanticJudge, v2Enabled = false, safetyIdentifier = '', signal
  } = args;
  try {
    const koreanSourceQuality = safeKoreanQualityAnalysis(original, {
      mode,
      register: contract.register
    });
    const koreanQualityHints = safeKoreanQualityHints(koreanSourceQuality);
    const niklSourceQuality = niklQualityTest ? safeNiklQualityAnalysis(original, {
      mode,
      register: contract.register
    }) : null;
    const niklQualityHints = niklQualityTest ? safeNiklQualityHints(niklSourceQuality) : '';
    const niklExternalApiHints = niklQualityTest ? await safeNiklExternalApiHints(original, protectedTerms) : '';
    const qualityPatternProfile = qualityPatternLab ? safeQualityPatternProfile(original, {
      mode,
      register: contract.register
    }) : null;
    const qualityPatternHints = qualityPatternLab ? safeQualityPatternHints(qualityPatternProfile) : '';
    const riskProfile = composeRiskProfile(inputRisk, koreanQualityHints, [niklQualityHints, niklExternalApiHints, qualityPatternHints].filter(Boolean).join('\n\n'));
    const chunkHumanizationPlan = v2Enabled && isHumanizationDepthEnabled() ? humanizationDepth.buildHumanizationPlan(original, {
      requestStrength,
      documentProfile,
      inputRisk
    }) : null;
    const chunkDiscourseProfile = v2Enabled ? discourseAudit.buildDiscourseProfile(original) : null;
    const hp = prompts.buildHumanizePrompt(mode, lang, {
      requestStrength,
      speakerType: contract.speakerType,
      register: contract.register,
      lengthPolicy: contract.lengthPolicy,
      styleProfile: styleProfile || PROFILE,
      userNotes,
      evidence,
      riskProfile,
      documentProfile,
      voiceProfile,
      humanizationPlan: chunkHumanizationPlan,
      discourseProfile: chunkDiscourseProfile
    });
    const retryInstruction = phase === 'escalation' ? prompts.buildEscalationInstruction() : '';
    const response = await completeJson({
      system: [hp.stable, retryInstruction].filter(Boolean).join('\n\n'),
      user: prompts.buildHumanizeUser({ chunk, chunks, index, protectedTerms, patchTargets, dynamicContext: hp.dynamic, mode }),
      schema: HUMANIZE_SCHEMA,
      schemaName: 'gpt_prod_humanize_result',
      model,
      reasoningEffort,
      verbosity: 'medium',
      maxOutputTokens: maxOutputTokensFor(original),
      config: cfg,
      signal,
      safetyIdentifier,
      meta: {
        task: 'humanize',
        phase,
        mode,
        requestStrength,
        profile: PROFILE,
        chunkIndex: index,
        escalated: phase === 'escalation'
      }
    });
    let outputText = sanitizeOutput(response.json.outputText);
    const boundaryAudit = structureChunk.restoreBoundaryMarkers(outputText, chunk);
    outputText = boundaryAudit.text;
    outputText = chunkPostprocess(outputText, original, mode, contract, {
      preserveLineBreaks: voiceProfile?.lineBreakSensitive === true
    });
    let judgeReport = null;
    let judgeViolations = [];
    let judgeHardFail = false;
    let judgeHardFailReason = '';
    if (runSemanticJudge) {
      judgeReport = await require('./judge').judgeAndRepair(original, outputText, {
        lang,
        signal,
        config: cfg,
        maxRounds: 1,
        allowedExtra: evidence || userNotes || '',
        mode,
        safetyIdentifier
      });
      outputText = judgeReport.outputText || outputText;
      if (judgeReport.pass === false) {
        judgeHardFail = true;
        judgeHardFailReason = 'semantic_judge_failed';
        judgeViolations = (judgeReport.violations || []).map(v => ({
          gate: 'semantic_judge_failed',
          type: v.type,
          span: v.span,
          detail: v.detail
        }));
      } else if (judgeReport.skipped) {
        judgeHardFail = true;
        judgeHardFailReason = 'semantic_judge_skipped';
        judgeViolations = [{
          gate: 'semantic_judge_skipped',
          reason: judgeReport.reason || 'judge_skipped',
          detail: 'semantic judge did not have enough verified source claims'
        }];
      }
    }
    const gate = evaluateChunkGate({
      outputText,
      original,
      source,
      contract,
      mode,
      protectedTerms,
      sourceSurface,
      allowedExtra: evidence || userNotes || '',
      documentProfile
    });
    if (!boundaryAudit.ok) {
      gate.hardFail = true;
      gate.reason = 'structure_boundary_marker_failed';
      gate.warnings.push('structure_boundary_marker_failed');
      gate.violations.push({
        gate: 'structure_boundary_marker_failed',
        detail: boundaryAudit.expectedLineCount !== null && boundaryAudit.expectedLineCount !== boundaryAudit.actualLineCount
          ? `잠근 행 수가 달라졌습니다(${boundaryAudit.expectedLineCount}→${boundaryAudit.actualLineCount}).`
          : boundaryAudit.segmentationChanged
            ? `잠근 문장 수가 달라졌습니다(${boundaryAudit.expectedSentenceCount}→${boundaryAudit.actualSentenceCount}).`
          : '병합 청크의 원문 경계 토큰이 누락되거나 중복되었습니다.'
      });
    }
    if (v2Enabled && !gate.hardFail) {
      const preservationViolations = gate.violations.filter(isV2ChunkPreservationViolation);
      const hardPreservationViolation = preservationViolations.find(v => normalizedViolationGate(v) !== 'novelty');
      const preservationViolation = hardPreservationViolation || preservationViolations[0];
      if (preservationViolation) {
        const preservationGate = String(preservationViolation.gate || preservationViolation.type || 'fact_preservation_failed');
        const residualNovelty = phase === 'escalation'
          && normalizedViolationGate(preservationViolation) === 'novelty'
          && !hardPreservationViolation;
        if (residualNovelty) {
          // The upper model has already had one explicit fact-removal attempt.
          // Residual semantic risk follows the v2 delivery policy: keep the
          // candidate for whole-document audit and surface needs_review rather
          // than silently reverting the chunk to the source.
          gate.warnings.push('v2_residual:novelty');
        } else {
          gate.hardFail = true;
          gate.reason = preservationGate;
          gate.warnings.push(`v2_retry:${preservationGate}`);
        }
      }
    }
    if (v2Enabled && !gate.hardFail) {
      const voiceDistributionViolation = sparseVoiceDistributionViolation({
        original,
        source,
        outputText,
        voiceProfile,
        documentProfile
      });
      if (voiceDistributionViolation) {
        gate.hardFail = true;
        gate.reason = voiceDistributionViolation.gate;
        gate.warnings.push(`v2_retry:${voiceDistributionViolation.gate}`);
        gate.violations.push(voiceDistributionViolation);
      }
    }
    if (v2Enabled && !gate.hardFail) {
      const existingDistributionViolation = existingVoiceDistributionViolation({
        original,
        source,
        outputText,
        mode,
        documentProfile
      });
      if (existingDistributionViolation) {
        gate.hardFail = true;
        gate.reason = existingDistributionViolation.gate;
        gate.warnings.push(`v2_retry:${existingDistributionViolation.gate}`);
        gate.violations.push(existingDistributionViolation);
      }
    }
    const qualityGate = safeKoreanQualityGate(original, outputText, {
      mode,
      register: contract.register,
      beforeAnalysis: koreanSourceQuality
    });
    const niklQualityGate = niklQualityTest ? safeNiklQualityGate(original, outputText, {
      mode,
      register: contract.register,
      beforeAnalysis: niklSourceQuality
    }) : null;
    const qualityPatternAudit = qualityPatternLab ? safeQualityPatternAudit(original, outputText, {
      mode,
      register: contract.register,
      beforeProfile: qualityPatternProfile,
      protectedTerms,
      externalApiHintsUsed: Boolean(niklExternalApiHints)
    }) : null;
    if (qualityGate) {
      if (Array.isArray(qualityGate.warnings) && qualityGate.warnings.length) {
        gate.warnings.push(...qualityGate.warnings);
      }
      if (Array.isArray(qualityGate.violations) && qualityGate.violations.length) {
        gate.violations.push(...qualityGate.violations);
      }
      if (qualityGate.blocking && process.env.STRICT_QUALITY_GATE === '1') {
        gate.hardFail = true;
        gate.reason = qualityGate.reason || 'korean_quality_regression';
      }
    }
    if (niklQualityGate) {
      if (Array.isArray(niklQualityGate.warnings) && niklQualityGate.warnings.length) {
        gate.warnings.push(...niklQualityGate.warnings);
      }
      if (Array.isArray(niklQualityGate.violations) && niklQualityGate.violations.length) {
        gate.violations.push(...niklQualityGate.violations.map(v => ({ ...v, niklQuality: true })));
      }
    }
    if (judgeHardFail && process.env.STRICT_QUALITY_GATE === '1') {
      gate.hardFail = true;
      gate.reason = judgeHardFailReason;
      gate.warnings.push(judgeHardFailReason);
      gate.violations.push(...judgeViolations);
    } else if (judgeHardFail) {
      gate.warnings.push(judgeHardFailReason);
      gate.violations.push(...judgeViolations);
    }
    if (qualityPatternLab && gate.hardFail && gate.reason === 'noop_unchanged') {
      gate.hardFail = false;
      gate.reason = '';
      gate.warnings.push('quality_pattern_low_effect');
      gate.violations.push({ gate: 'quality_pattern_low_effect', detail: 'output equivalent to source; delivered for lab audit' });
    }
    if (qualityPatternAudit?.auditTrail?.warnings?.length) {
      gate.warnings.push(...qualityPatternAudit.auditTrail.warnings.map(w => `quality_pattern:${w}`));
      gate.violations.push(...qualityPatternAudit.auditTrail.warnings.map(w => ({ gate: w, qualityPatternLab: true })));
    }
    const serverEditMetrics = computeEditMetrics(original, outputText);
    return {
      outputText,
      hardFail: gate.hardFail,
      record: chunkRecord({
        chunk,
        outputText: gate.hardFail ? original : outputText,
        fallback: gate.hardFail,
        error: gate.hardFail ? gate.reason : null,
        hardFailReason: gate.reason,
        warnings: [
          ...(response.json.warnings || []),
          ...(response.json.riskFlags || []).map(v => `risk:${v}`),
          ...(response.json.factualRiskNotes || []).map(v => `fact_note:${v}`),
          ...(judgeViolations.length ? [judgeHardFailReason || 'gpt_semantic_judge_warning'] : []),
          ...gate.warnings
        ],
        floorViolations: gate.violations,
        usage: response.usage,
        elapsedMs: response.elapsedMs,
        editIntensity: response.json.editIntensity,
        protectedTerms: response.json.protectedTerms || protectedTerms,
        changedSentenceRatio: serverEditMetrics.changedSentenceRatio,
        charEditRatio: serverEditMetrics.charEditRatio,
        lengthRatio: serverEditMetrics.lengthRatio,
        judgeReport,
        koreanQuality: compactKoreanQualityGate(qualityGate),
        niklQuality: compactNiklQualityGate(niklQualityGate),
        qualityPatternLab: compactQualityPatternAudit(qualityPatternAudit),
        selectedModel: response.model,
        escalated: phase === 'escalation'
      })
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    try {
      logger.warn('gpt_prod.call_failed', {
        task: 'humanize',
        phase,
        mode,
        model,
        chunkIndex: index,
        err: err && err.message || String(err)
      });
    } catch {}
    return {
      outputText: original,
      hardFail: true,
      record: chunkRecord({
        chunk,
        outputText: original,
        fallback: true,
        error: err && err.message || String(err),
        hardFailReason: 'gpt_call_failed',
        warnings: ['gpt_call_failed'],
        selectedModel: model,
        escalated: phase === 'escalation'
      })
    };
  }
}

async function detect({ text, lang = 'ko', signal, config, route = 'detect', allowLocalFallback = true, uid = '', safetyIdentifier = '' } = {}) {
  const source = String(text || '').trim();
  const cfg = await loadConfig(config);
  const safetyId = isEngineV2Enabled() && uid
    ? (safetyIdentifier || safetyIdentifierForUid(uid))
    : (safetyIdentifier || '');
  const user = lang === 'en' ? `[TEXT TO ANALYZE]\n${source}` : `[분석할 글]\n${source}`;
  try {
    const res = await callDetectModel({
      prompt: prompts.buildDetectPrompt(lang),
      user,
      cfg,
      signal,
      route,
      phase: 'detect:primary',
      model: cfg.models.detect,
      reasoningEffort: cfg.reasoning.detect,
      safetyIdentifier: safetyId,
      escalated: false
    });
    let out = normalizeDetectResult(res.json);
    out.gptMeta = metaFromResponse(res, cfg, { task: route, escalated: false });
    if (shouldEscalateDetect(out, source, cfg)) {
      const esc = await callDetectModel({
        prompt: prompts.buildDetectPrompt(lang),
        user,
        cfg,
        signal,
        route,
        phase: 'detect:confidence_escalation',
        model: cfg.models.detectEscalation,
        reasoningEffort: cfg.reasoning.escalation,
        safetyIdentifier: safetyId,
        escalated: true
      });
      out = normalizeDetectResult(esc.json);
      out.gptMeta = metaFromResponse(esc, cfg, { task: route, escalated: true, primaryConfidence: res.json.confidence || '' });
    }
    return out;
  } catch (firstErr) {
    try {
      const res = await callDetectModel({
        prompt: prompts.buildDetectPrompt(lang),
        user,
        cfg,
        signal,
        route,
        phase: 'detect:escalation',
        model: cfg.models.detectEscalation,
        reasoningEffort: cfg.reasoning.escalation,
        safetyIdentifier: safetyId,
        escalated: true
      });
      const out = normalizeDetectResult(res.json);
      out.gptMeta = metaFromResponse(res, cfg, { task: route, escalated: true, primaryError: firstErr.message });
      return out;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!allowLocalFallback) throw err;
      return deterministicDetectFallback(source, firstErr || err);
    }
  }
}

async function callDetectModel({ prompt, user, cfg, signal, route, phase, model, reasoningEffort, escalated, safetyIdentifier = '' }) {
  return await completeJson({
      system: prompt,
      user,
      schema: DETECT_SCHEMA,
      schemaName: 'gpt_prod_detect_result',
      model,
      reasoningEffort,
      verbosity: 'low',
      maxOutputTokens: 2200,
      config: cfg,
      signal,
      safetyIdentifier,
      meta: { task: route, phase, mode: 'detect', profile: PROFILE, escalated }
    });
}

async function rewriteSentence({ text, lang = 'ko', signal, config, uid = '', safetyIdentifier = '' } = {}) {
  const cfg = await loadConfig(config);
  const source = String(text || '').trim();
  const safetyId = isEngineV2Enabled() && uid
    ? (safetyIdentifier || safetyIdentifierForUid(uid))
    : (safetyIdentifier || '');
  const res = await completeJson({
    system: prompts.buildRewritePrompt(lang),
    user: `[원문]\n${source}`,
    schema: REWRITE_SCHEMA,
    schemaName: 'gpt_prod_rewrite_sentence',
    model: cfg.models.repair,
    reasoningEffort: cfg.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: 600,
    config: cfg,
    signal,
    safetyIdentifier: safetyId,
    meta: { task: 'rewrite_sentence', phase: 'repair', mode: 'preview', profile: PROFILE }
  });
  const rewritten = sanitizeOutput(res.json.rewritten);
  return { rewritten: rewritten || source, gptMeta: metaFromResponse(res, cfg, { task: 'rewrite_sentence' }) };
}

async function suggestEvidence({ query, signal, config, uid = '', safetyIdentifier = '' } = {}) {
  const cfg = await loadConfig(config);
  const text = String(query || '').trim();
  const safetyId = isEngineV2Enabled() && uid
    ? (safetyIdentifier || safetyIdentifierForUid(uid))
    : (safetyIdentifier || '');
  if (!text) return { candidates: [], warnings: ['empty_query'] };
  try {
    const out = await callEvidenceSearch({ text, cfg, signal, phase: 'search:primary', model: cfg.models.evidenceSearch, reasoningEffort: cfg.reasoning.evidenceSearch, safetyIdentifier: safetyId });
    if ((out.warnings || []).includes('source_url_verification_filtered_all')) {
      throw new Error('source_url_verification_filtered_all');
    }
    return out;
  } catch (firstErr) {
    if (signal?.aborted) throw firstErr;
    const out = await callEvidenceSearch({ text, cfg, signal, phase: 'search:escalation', model: cfg.models.evidenceEscalation, reasoningEffort: cfg.reasoning.escalation, safetyIdentifier: safetyId });
    out.warnings = [...(out.warnings || []), `primary_failed:${firstErr.message || String(firstErr)}`];
    out.gptMeta = { ...(out.gptMeta || {}), escalated: true, primaryError: firstErr.message || String(firstErr) };
    return out;
  }
}

async function callEvidenceSearch({ text, cfg, signal, phase, model, reasoningEffort, safetyIdentifier = '' }) {
  const res = await completeJson({
    system: prompts.buildEvidencePrompt(),
    user: `[검증할 주장 또는 주제]\n${text}`,
    schema: EVIDENCE_SCHEMA,
    schemaName: 'gpt_prod_evidence_candidates',
    model,
    reasoningEffort,
    verbosity: 'low',
    maxOutputTokens: 2500,
    tools: [webSearchTool()],
    toolChoice: 'required',
    include: ['web_search_call.action.sources'],
    config: cfg,
    signal,
    safetyIdentifier,
    meta: { task: 'evidence_search', phase, mode: 'evidence', profile: PROFILE, escalated: phase.includes('escalation') }
  });
  const verifiedUrls = collectWebSearchUrls(res.raw);
  const warnings = [...(res.json.warnings || [])];
  let candidates = (res.json.candidates || [])
    .map(c => ({ ...c, url: String(c.url || '').trim() }))
    .filter(c => /^https?:\/\//i.test(c.url))
    .filter(c => {
      const unsafe = isUnsafeEvidenceUrl(c.url);
      if (unsafe) warnings.push('unsafe_source_url_filtered');
      return !unsafe;
    })
    .map(c => ({ ...c, sourceVerified: verifiedUrls.size ? hasVerifiedUrl(c.url, verifiedUrls) : false }));
  if (verifiedUrls.size) {
    candidates = candidates.filter(c => c.sourceVerified);
  } else {
    candidates = await verifyEvidenceCandidates(candidates, signal);
    warnings.push('source_url_verified_by_fetch');
  }
  candidates = candidates.slice(0, 8);
  if (verifiedUrls.size && !candidates.length) warnings.push('source_url_verification_filtered_all');
  return {
    candidates,
    warnings,
    gptMeta: metaFromResponse(res, cfg, { task: 'evidence_search', escalated: phase.includes('escalation'), verifiedSourceUrlCount: verifiedUrls.size })
  };
}

function evaluateChunkGate({ outputText, original, source, contract, mode, protectedTerms, sourceSurface, allowedExtra = '', documentProfile = null }) {
  const warnings = [];
  const violations = [];
  let directPreservationReason = '';
  const sourceAnchors = collectStructureAnchors(original);
  if (!outputText || looksLikeMeta(outputText)) {
    return { hardFail: true, reason: 'empty_or_meta_output', warnings, violations };
  }
  if (looksLikePromptLeak(outputText)) {
    return { hardFail: true, reason: 'prompt_instruction_leak', warnings, violations };
  }
  if (looksEncodingCorrupted(original, outputText)) {
    return { hardFail: true, reason: 'encoding_corruption', warnings, violations };
  }
  if (looksTruncated(outputText)) {
    return { hardFail: true, reason: 'sentence_truncated', warnings, violations };
  }
  if (sourceAnchors.length >= 2) {
    const missingAnchors = sourceAnchors.filter(a => !structureAnchorPresent(a, outputText));
    if (missingAnchors.length) {
      violations.push({
        gate: 'section_anchor_loss',
        missing: missingAnchors.slice(0, 8).map(a => a.raw)
      });
      warnings.push('section_anchor_loss');
    }
  }
  const lengthGate = measureLengthCollapse(original, outputText, sourceAnchors.length);
  if (lengthGate.hardFail) {
    violations.push(lengthGate.violation);
    warnings.push('length_collapse');
  }
  const lostTerms = protectedTerms.filter(t => protectedTermMissing(t, outputText));
  if (lostTerms.length) {
    violations.push({ gate: 'protected_term_loss', terms: lostTerms.slice(0, 12) });
    warnings.push('protected_term_loss');
  }
  const numberAudit = compareNumberMultiset(original, outputText, allowedExtra);
  if (numberAudit.changed) {
    violations.push({
      gate: 'number_multiset_changed',
      addedCount: numberAudit.addedCount,
      removedCount: numberAudit.removedCount
    });
    warnings.push('number_multiset_changed');
    directPreservationReason = 'number_multiset_changed';
  }
  const profileName = String(documentProfile?.profile || '');
  const profileNames = new Set([profileName, ...(documentProfile?.safetyProfiles || []).map(value => String(value || ''))]);
  const preserveLists = mode === 'polish'
    || documentProfile?.formatProfile?.flags?.includes?.('questionnaire')
    || documentProfile?.formatProfile?.flags?.includes?.('list_heavy')
    || [...profileNames].some(profile => [
      'academic_paper',
      'report_assignment',
      'student_record_teacher',
      'student_self_assessment',
      'resume_application'
    ].includes(profile));
  if (preserveLists) {
    const sourceLists = buildVoiceProfile(original, { documentProfile }).listItemCount || 0;
    const outputLists = buildVoiceProfile(outputText, { documentProfile }).listItemCount || 0;
    if (sourceLists !== outputLists) {
      violations.push({ gate: 'list_structure_changed', sourceCount: sourceLists, outputCount: outputLists });
      warnings.push('list_structure_changed');
      directPreservationReason ||= 'list_structure_changed';
    }
  }
  try {
    let floorViolations = floor.collectFloorViolations({
      result: { outputText },
      rawText: original,
      povSeed: contract.povSeed,
      optIn: false,
      mode,
      chunkLevel: true,
      allowedExtra
    }) || [];
    // A repeated sentence that already existed in this source chunk is not a
    // transformation defect. Only newly introduced or amplified repetition
    // may fail the chunk gate; the document audit applies the same calibration.
    const repetitionAudit = qualityV2.compareRepetitionDelta(original, outputText);
    if (!repetitionAudit.increased) {
      floorViolations = floorViolations.filter(violation => String(violation?.type || violation?.gate || '') !== 'repetition');
    }
    violations.push(...floorViolations);
    const hard = floorViolations.find(isBlockingViolation);
    if (hard) {
      warnings.push(`floor_${hard.gate || hard.type || 'violation'}`);
      return { hardFail: true, reason: String(hard.gate || hard.type || 'floor_violation'), warnings, violations };
    }
  } catch (err) {
    violations.push({ gate: 'floor_check_error', detail: err && err.message || String(err) });
    warnings.push('floor_check_error');
  }
  if (directPreservationReason) {
    return { hardFail: true, reason: directPreservationReason, warnings, violations };
  }
  if (normalizeBare(original).length > 120 && normalizeBare(original) === normalizeBare(outputText)) {
    warnings.push('noop_unchanged');
    violations.push({ gate: 'noop_unchanged', detail: 'output equivalent to source' });
    return { hardFail: true, reason: 'noop_unchanged', warnings, violations };
  }
  try {
    const outSurface = surfaceguard.buildSurfaceReport(outputText);
    const srcRatio = sourceSurface?.paragraphs?.abstractRiskRatio || 0;
    const outRatio = outSurface?.paragraphs?.abstractRiskRatio || 0;
    if (outRatio > srcRatio + 0.22 && outRatio >= 0.55) {
      warnings.push('surface_risk_regression');
      violations.push({ gate: 'surface_risk_regression', sourceRatio: srcRatio, outputRatio: outRatio });
    }
  } catch {}
  return { hardFail: false, reason: '', warnings, violations };
}

function evaluateWholeDocumentGate({ outputText, source, contract, mode, sourceSurface, allowedExtra = '' }) {
  const warnings = [];
  const violations = [];
  if (!outputText || looksLikeMeta(outputText)) {
    return { hardFail: true, reason: 'empty_or_meta_output', warnings, violations };
  }
  if (floor.looksLikeRefusal(outputText)) {
    return { hardFail: true, reason: 'refusal', warnings, violations };
  }
  if (looksLikePromptLeak(outputText)) {
    return { hardFail: true, reason: 'prompt_instruction_leak', warnings, violations };
  }
  if (looksEncodingCorrupted(source, outputText)) {
    return { hardFail: true, reason: 'encoding_corruption', warnings, violations };
  }
  if (looksTruncated(outputText)) {
    return { hardFail: true, reason: 'sentence_truncated', warnings, violations };
  }
  const sourceAnchors = collectStructureAnchors(source);
  if (sourceAnchors.length >= 2) {
    const missingAnchors = sourceAnchors.filter(a => !structureAnchorPresent(a, outputText));
    if (missingAnchors.length) {
      violations.push({ gate: 'section_anchor_loss', missing: missingAnchors.slice(0, 12).map(a => a.raw) });
      warnings.push('section_anchor_loss');
    }
  }
  const lengthGate = measureLengthCollapse(source, outputText, sourceAnchors.length);
  if (lengthGate.hardFail) {
    violations.push(lengthGate.violation);
    warnings.push('length_collapse');
  }
  const protectedTerms = extractProtectedTerms(source);
  const lostTerms = protectedTerms.filter(t => protectedTermMissing(t, outputText));
  if (lostTerms.length) {
    violations.push({ gate: 'protected_term_loss', terms: lostTerms.slice(0, 16) });
    warnings.push('protected_term_loss');
  }
  const numberAudit = compareNumberMultiset(source, outputText, allowedExtra);
  if (numberAudit.changed) {
    violations.push({
      gate: 'number_multiset_changed',
      addedCount: numberAudit.addedCount,
      removedCount: numberAudit.removedCount
    });
    warnings.push('number_multiset_changed');
  }
  if (normalizeBare(source).length > 120 && normalizeBare(source) === normalizeBare(outputText)) {
    warnings.push('noop_unchanged');
    violations.push({ gate: 'noop_unchanged', detail: 'final output equivalent to source' });
    return { hardFail: true, reason: 'noop_unchanged', warnings, violations };
  }
  try {
    const outSurface = surfaceguard.buildSurfaceReport(outputText);
    const srcRatio = sourceSurface?.paragraphs?.abstractRiskRatio || 0;
    const outRatio = outSurface?.paragraphs?.abstractRiskRatio || 0;
    if (outRatio > srcRatio + 0.22 && outRatio >= 0.55) {
      warnings.push('surface_risk_regression');
      violations.push({ gate: 'surface_risk_regression', sourceRatio: srcRatio, outputRatio: outRatio });
    }
  } catch {}
  return { hardFail: false, reason: '', warnings, violations };
}

function addFloorCriticals(report, violations, fallbackGate = 'gpt_final_gate_failed') {
  if (!report) return;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const additions = (violations || []).length
    ? violations.map(v => ({ ...v, gate: v.gate || v.type || fallbackGate, finalDocumentGate: true }))
    : [{ gate: fallbackGate, finalDocumentGate: true }];
  report.status = 'blocked';
  report.criticals = [...criticals, ...additions];
  report.warnings = [...warnings, ...additions.map(v => v.gate || v.type || fallbackGate)];
}

function addFloorWarnings(report, violations, warningGates = []) {
  if (!report) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const additions = (violations || []).map(v => ({ ...v, softenedFinalGate: true }));
  report.warnings = [
    ...warnings,
    ...warningGates,
    ...additions
  ];
  if (report.status === 'clean' && shouldPromoteWarningsToNeedsReview([...warningGates, ...additions])) {
    report.status = 'needs_review';
  }
}

function shouldPromoteWarningsToNeedsReview(items = []) {
  return (items || []).some(item => {
    const gate = typeof item === 'string'
      ? item
      : String(item?.gate || item?.type || item?.action || '').trim();
    return REVIEW_WARNING_GATES.has(gate);
  });
}

function isBlockingViolation(v) {
  const t = String(v?.type || v?.gate || '').toLowerCase();
  return /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated/.test(t);
}

function collectStructureAnchors(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const anchors = [];
  for (const line of lines) {
    if (line.length < 2 || line.length > 140) continue;
    let m = line.match(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]{1,4})\s*[.)．]?\s*(.{0,90})$/);
    if (m) {
      anchors.push(anchorOf(line, 'roman', m[1], m[2]));
      continue;
    }
    m = line.match(/^(\d{1,2})\s*[.)．]\s+(.{2,110})$/);
    if (m) {
      anchors.push(anchorOf(line, 'number', m[1], m[2]));
      continue;
    }
    m = line.match(/^(제\s?\d{1,3}\s?(?:장|절|항))\s+(.{2,100})$/);
    if (m) anchors.push(anchorOf(line, 'legal', m[1], m[2]));
  }
  return anchors.slice(0, 30);
}

function anchorOf(raw, type, marker, title) {
  const markerKey = normalizeBare(marker).replace(/[.)．]/g, '');
  const titleKey = normalizeBare(title).slice(0, 24);
  return { raw, type, marker: markerKey, titleKey };
}

function structureAnchorPresent(anchor, outputText) {
  const out = normalizeBare(outputText);
  if (anchor.titleKey && anchor.titleKey.length >= 6) return out.includes(anchor.titleKey);
  return out.includes(normalizeBare(anchor.raw));
}

function measureLengthCollapse(original, outputText, anchorCount = 0) {
  const sourceLen = normalizeBare(original).length;
  const outLen = normalizeBare(outputText).length;
  if (sourceLen < 700 || outLen <= 0) return { hardFail: false };
  const ratio = outLen / sourceLen;
  const minRatio = anchorCount >= 3 ? 0.78 : 0.65;
  if (ratio >= minRatio) return { hardFail: false };
  return {
    hardFail: true,
    violation: {
      gate: 'length_collapse',
      sourceLen,
      outLen,
      ratio: Number(ratio.toFixed(3)),
      minRatio
    }
  };
}

function isHighRiskChunk(text, protectedTerms, patchTargets, cfg, inputRisk) {
  const len = String(text || '').length;
  if (len >= (cfg.escalation.longTextChars || 10000)) return true;
  if ((protectedTerms || []).length >= (cfg.escalation.protectedTermThreshold || 40)) return true;
  if ((patchTargets || []).length >= (cfg.escalation.patchTargetThreshold || 12)) return true;
  if (inputRisk && inputRisk.grade === 'C' && len > 2000) return true;
  return false;
}

function extractProtectedTerms(text, documentProfile = null) {
  const s = String(text || '');
  const out = new Set();
  const patterns = [
    /\bhttps?:\/\/[^\s)]+/g,
    /\b\d{2,4}[.-]\d{1,2}[.-]\d{1,2}\b/g,
    /(?<![A-Za-z0-9_])\d+(?:\.\d+)?\s?(?:%|원|만원|억원|조원|평|명|개|건|회|년|개월|일|시간|분|km|kg|g|cm|m)(?=$|[^가-힣A-Za-z0-9_])/g,
    /[A-Z][A-Za-z0-9&.-]{1,}(?:\s+[A-Z][A-Za-z0-9&.-]{1,}){0,3}/g,
    /[가-힣A-Za-z0-9]+(?:대학교|대학원|연구소|학회|기관|공사|공단|주식회사|택배|병원|유치원|어린이집|교육부|보건복지부|AWS|API)/g,
    /[가-힣A-Za-z0-9]{2,}(?:·[가-힣A-Za-z0-9]{2,}){1,}/g,
    /[가-힣A-Za-z0-9][가-힣A-Za-z0-9·\s-]{1,40}\([A-Za-z가-힣0-9][^)）]{1,40}\)/g,
    /[가-힣A-Za-z0-9·-]{2,}(?:시스템|기술|설비|기능|인프라|포털|터미널|플랫폼|데이터|API|AI|AWS)/g,
    /[가-힣]{2,}\(\d{4}\)/g
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      addProtectedTerm(out, m[0]);
    }
  }
  if (/(?:연구\s*개발|연구실|실험|공정|시편|분석\s*장비|재현성)/u.test(s)) {
    const professionalPatterns = [
      /공정\s*조건/gu,
      /공정\s*변수/gu,
      /공정\s*최적화/gu,
      /상관관계/gu,
      /재현성/gu,
      /수치화/gu,
      /정량화/gu,
      /데이터\s*해석/gu,
      /결과\s*검증/gu,
      /반복\s*실험/gu
    ];
    for (const re of professionalPatterns) {
      for (const match of s.matchAll(re)) addProtectedTerm(out, match[0]);
    }
  }
  return [...out].slice(0, 120);
}

function addProtectedTerm(out, raw) {
  for (const term of normalizeProtectedTermCandidate(raw)) {
    if (term.length >= 2 && term.length <= 80) out.add(term);
  }
}

function normalizeProtectedTermCandidate(raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!v || /[\r\n]/.test(String(raw || ''))) return [];
  const paren = v.match(/^(.+?)\(([^)）]{1,60})\)$/);
  if (paren) {
    const before = trimParenTermPrefix(paren[1]);
    const inside = String(paren[2] || '').trim();
    const out = [];
    if (isProtectedTermLike(inside)) out.push(inside);
    const combined = before ? `${before}(${inside})` : '';
    if (isProtectedTermLike(combined)) out.push(combined);
    return out;
  }
  return isProtectedTermLike(v) ? [v] : [];
}

function trimParenTermPrefix(value) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  let picked = words.slice(-4);
  while (picked.length > 1 && /(?:은|는|이|가|을|를|에서|으로|로|와|과|의|에)$/.test(picked[0])) {
    picked = picked.slice(1);
  }
  return picked.join(' ');
}

function isProtectedTermLike(value) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  if (v.length < 2 || v.length > 80) return false;
  if (/[.!?。！？]/.test(v)) return false;
  const words = v.split(' ').filter(Boolean);
  if (words.length > 6) return false;
  if (v.length > 42 && /(?:은|는|이|가|을|를|에서|으로|로|와|과|의|에)(?=$|[^가-힣A-Za-z0-9_])/.test(v)) return false;
  if (v.length > 55 && !/[A-Z0-9%]/.test(v)) return false;
  return true;
}

function protectedTermMissing(term, outputText) {
  const t = String(term || '').replace(/\s+/g, ' ').trim();
  if (!isProtectedTermLike(t)) return false;
  const out = String(outputText || '');
  if (out.includes(t)) return false;
  const compactOut = normalizeBare(out);
  const compactTerm = normalizeBare(t);
  if (compactTerm.length >= 3 && compactOut.includes(compactTerm)) return false;
  const paren = t.match(/\(([^)）]{2,60})\)$/);
  if (paren) {
    const inner = String(paren[1] || '').trim();
    if (inner && (out.includes(inner) || normalizeBare(inner).length >= 3 && compactOut.includes(normalizeBare(inner)))) return false;
  }
  return true;
}

function buildPatchTargets(text) {
  const s = String(text || '');
  const targets = [];
  if ((s.match(/\n{3,}/g) || []).length) targets.push('과도한 빈 줄 정리');
  return targets;
}

function maxOutputTokensFor(text) {
  const chars = String(text || '').length;
  // Korean rewrites can consume close to one output token per character, and
  // Responses reasoning tokens share this same ceiling. A low ceiling caused
  // otherwise valid long paragraphs to end as incomplete and then repeat on
  // the escalation model. The API bills actual usage, not this allowance.
  return Math.max(2400, Math.min(12000, Math.ceil(chars * 3.2)));
}

function isV2ChunkPreservationViolation(v) {
  const gate = normalizedViolationGate(v);
  return new Set([
    'novelty',
    'lostfacts',
    'lost_facts',
    'pov',
    'pov_inject',
    'protected_term_loss',
    'section_anchor_loss',
    'length_collapse',
    'number_multiset_changed',
    'list_structure_changed'
  ]).has(gate);
}

function sparseVoiceDistributionViolation({ original, source, outputText, voiceProfile, documentProfile } = {}) {
  const sentence = voiceProfile?.sentence || {};
  const target = sentence.sparseSplitTarget;
  if (sentence.punctuationSparse !== true || !target) return null;
  if (normalizeBare(original) !== normalizeBare(source)) return null;
  const current = buildVoiceProfile(outputText, { documentProfile: documentProfile || 'unknown' }).sentence;
  const missed = [];
  if (current.count < target.minCount || current.count > target.maxCount) {
    missed.push(`문장 수 ${current.count}(목표 ${target.minCount}~${target.maxCount})`);
  }
  if (current.min > target.shortMax) missed.push(`최단 ${current.min}자(목표 ${target.shortMax}자 이하)`);
  if (current.max < target.longMin) missed.push(`최장 ${current.max}자(목표 ${target.longMin}자 이상)`);
  if (!missed.length) return null;
  return {
    gate: 'voice_sparse_distribution_failed',
    type: 'voice_sparse_distribution_failed',
    detail: `구두점 없는 장문 분할 계약 미충족: ${missed.join(', ')}`
  };
}

function existingVoiceDistributionViolation({ original, source, outputText, mode, documentProfile } = {}) {
  if (mode === 'polish' || normalizeBare(original) !== normalizeBare(source)) return null;
  const before = buildVoiceProfile(original, { documentProfile: documentProfile || 'unknown' }).sentence;
  const after = buildVoiceProfile(outputText, { documentProfile: documentProfile || 'unknown' }).sentence;
  // 청크·최종 감사·의미 수리가 모두 voiceProfile의 동일 판정을 사용한다.
  // naturalness shadow 점수는 이 판정이나 후보 선택에 사용하지 않는다.
  const distribution = sentenceDistributionShift(before, after);
  if (!distribution.shift) return null;
  return {
    gate: 'voice_existing_distribution_failed',
    type: 'voice_existing_distribution_failed',
    detail: distribution.detail
  };
}

function isSafeGeneralSurfaceCandidate(source, candidate, contract, documentProfile, mode = 'assignment') {
  return auditGeneralSurfaceCandidate(source, candidate, contract, documentProfile, mode).pass;
}

function auditGeneralSurfaceCandidate(source, candidate, contract, documentProfile, mode = 'assignment') {
  const before = String(source || '').trim();
  const after = String(candidate || '').trim();
  const codes = [];
  const add = code => {
    if (!codes.includes(code)) codes.push(code);
  };
  if (!before || !after) return { pass: false, codes: ['empty_candidate'] };
  if (normalizeBare(before) === normalizeBare(after)) return { pass: false, codes: ['candidate_unchanged'] };
  const metrics = computeEditMetrics(before, after);
  if (metrics.charEditRatio <= 0 || metrics.charEditRatio > 0.32) add('edit_range_exceeded');
  if (metrics.lengthRatio < 0.90 || metrics.lengthRatio > 1.12) add('length_range_failed');
  if (paragraphCount(before) !== paragraphCount(after)) add('structure_loss');
  if (floor.measureNovelty(before, after, '').count > 0) add('semantic_shift');
  if (floor.measureLostFacts(before, after).count > 0) add('semantic_shift');
  if (compareNumberMultiset(before, after).changed) add('number_changed');
  const povDrift = floor.measurePovDrift(before, after, contract?.povSeed);
  if (povDrift.introducedAnyFirstPerson || povDrift.droppedAnyFirstPerson) add('pov_shift');
  if (extractProtectedTerms(before, documentProfile).some(term => !containsNormalizedValue(after, term))) add('protected_term_loss');
  const beforeVoice = buildVoiceProfile(before, { documentProfile: documentProfile || 'unknown' });
  const afterVoice = buildVoiceProfile(after, { documentProfile: documentProfile || 'unknown' });
  const beforeSentenceCount = meaningfulSentenceCount(before);
  const afterSentenceCount = meaningfulSentenceCount(after);
  const exactSentenceStructure = beforeVoice.lineStructureSensitive === true
    || documentProfile?.formatProfile?.flags?.some?.(flag => ['questionnaire', 'list_heavy', 'creative_lines'].includes(flag));
  if (exactSentenceStructure && beforeSentenceCount !== afterSentenceCount) add('structure_loss');
  if (!exactSentenceStructure) {
    const sentenceRatio = beforeSentenceCount ? afterSentenceCount / beforeSentenceCount : 1;
    const sentenceDelta = Math.abs(afterSentenceCount - beforeSentenceCount);
    if (sentenceRatio < 0.75 || sentenceRatio > 1.30 || sentenceDelta > Math.max(2, Math.ceil(beforeSentenceCount * 0.25))) add('structure_loss');
  }
  if (beforeVoice.directQuoteCount !== afterVoice.directQuoteCount) add('quote_loss');
  if (beforeVoice.listItemCount !== afterVoice.listItemCount) add('structure_loss');
  if (beforeVoice.headingCount !== afterVoice.headingCount) add('structure_loss');
  if (beforeVoice.lineStructureSensitive && beforeVoice.lineCount !== afterVoice.lineCount) add('structure_loss');
  if (existingVoiceDistributionViolation({
    original: before,
    source: before,
    outputText: after,
    mode,
    documentProfile
  })) add('voice_shift');
  return { pass: codes.length === 0, codes, metrics };
}

function isSafeLocalizedLanguageCandidate({
  source,
  before,
  candidate,
  contract,
  documentProfile,
  mode = 'assignment',
  protectedTerms = [],
  currentDepth = null,
  candidateDepth = null,
  maxLocalEditRatio = 0.12,
  minLocalLengthRatio = 0.85,
  maxLocalLengthRatio = 1.12,
  allowDepthRegression = false
} = {}) {
  const original = String(source || '').trim();
  const current = String(before || '').trim();
  const after = String(candidate || '').trim();
  if (!original || !current || !after || normalizeBare(current) === normalizeBare(after)) return false;
  const localEdit = computeEditMetrics(current, after);
  if (localEdit.charEditRatio <= 0 || localEdit.charEditRatio > maxLocalEditRatio) return false;
  if (localEdit.lengthRatio < minLocalLengthRatio || localEdit.lengthRatio > maxLocalLengthRatio) return false;
  if (paragraphCount(current) !== paragraphCount(after)) return false;
  if (compareNumberMultiset(original, after).changed) return false;
  const beforeNovelty = floor.measureNovelty(original, current, '').count || 0;
  const afterNovelty = floor.measureNovelty(original, after, '').count || 0;
  const beforeLostFacts = floor.measureLostFacts(original, current).count || 0;
  const afterLostFacts = floor.measureLostFacts(original, after).count || 0;
  if (afterNovelty > beforeNovelty || afterLostFacts > beforeLostFacts) return false;
  const povDrift = floor.measurePovDrift(original, after, contract?.povSeed);
  if (povDrift.introducedAnyFirstPerson || povDrift.droppedAnyFirstPerson) return false;
  if ((protectedTerms || []).some(term => !containsNormalizedValue(after, term))) return false;

  const beforeVoice = buildVoiceProfile(current, { documentProfile: documentProfile || 'unknown' });
  const afterVoice = buildVoiceProfile(after, { documentProfile: documentProfile || 'unknown' });
  if (beforeVoice.directQuoteCount !== afterVoice.directQuoteCount) return false;
  if (beforeVoice.listItemCount !== afterVoice.listItemCount) return false;
  if (beforeVoice.headingCount !== afterVoice.headingCount) return false;
  if (beforeVoice.lineStructureSensitive && beforeVoice.lineCount !== afterVoice.lineCount) return false;

  const currentDiscourse = discourseAudit.compareDiscourse(original, current);
  const candidateDiscourse = discourseAudit.compareDiscourse(original, after);
  const currentCodes = new Set(currentDiscourse.codes || []);
  if ((candidateDiscourse.codes || []).some(code => !currentCodes.has(code))) return false;

  if (!allowDepthRegression && currentDepth?.applicable && candidateDepth?.applicable) {
    const currentScore = humanizationDepth.humanizationCandidateScore(currentDepth);
    const candidateScore = humanizationDepth.humanizationCandidateScore(candidateDepth);
    if (candidateScore + 0.03 < currentScore) return false;
    if (Number(candidateDepth.metrics?.substantiveEditRatio || 0) + 0.008
        < Number(currentDepth.metrics?.substantiveEditRatio || 0)) return false;
    if (Number(candidateDepth.metrics?.structurallyChangedSentenceCount || 0) + 1
        < Number(currentDepth.metrics?.structurallyChangedSentenceCount || 0)) return false;
  }
  if (mode === 'polish') {
    const policy = qualityV2.polishEditPolicy(original, after);
    const padding = qualityV2.comparePolishEvaluativePadding(original, after);
    if (policy.noSafeChange || policy.excessiveChange || padding.increased) return false;
  }
  return true;
}

function preservesFinalStructure(source, candidate, chunks, plan, boundaryRepair) {
  const audit = structureChunk.buildStructureAudit({
    source,
    outputText: candidate,
    chunks,
    plan,
    boundaryRepair
  });
  return (audit.lostLockedCount || 0) === 0 && audit.lockedOrderChanged !== true;
}

function acceptGeneralSurfaceRecovery(records, selectedIndices = null) {
  for (const [index, record] of (records || []).entries()) {
    if (selectedIndices && !selectedIndices.has(index)) continue;
    const pending = (record.warnings || []).some(warning => [
      'general_surface_retry_pending',
      'general_surface_retry_safe_fallback'
    ].includes(warning));
    if (record.fallback === true && !pending && !isRecoverableSurfaceFallbackRecord(record)) continue;
    if (pending || record.fallback === true) {
      record.fallback = false;
      record.error = null;
      record.hardFailReason = '';
      record.floorViolations = [];
    }
    record.warnings = (record.warnings || []).filter(warning => ![
      'general_surface_retry_pending',
      'general_surface_retry_safe_fallback',
      'v2_residual:structure_boundary_marker_failed',
      'v2_residual:voice_existing_distribution_failed'
    ].includes(warning));
  }
}

function containsNormalizedValue(haystack, needle) {
  const normalize = value => String(value || '').normalize('NFC').replace(/\s+/gu, '').toLowerCase();
  return normalize(haystack).includes(normalize(needle));
}

function meaningfulSentenceCount(value) {
  return splitSentences(value).filter(sentence => String(sentence || '').replace(/\s+/gu, '').length >= 3).length;
}

function isRecoverableSurfaceFallbackRecord(record) {
  const gate = normalizedViolationGate({ gate: record?.hardFailReason });
  return new Set([
    'novelty',
    'lostfacts',
    'lost_facts',
    'pov',
    'pov_inject',
    'protected_term_loss',
    'section_anchor_loss',
    'length_collapse',
    'number_multiset_changed',
    'list_structure_changed',
    'structure_boundary_marker_failed',
    'voice_sparse_distribution_failed',
    'voice_existing_distribution_failed',
    'noop_unchanged'
  ]).has(gate);
}

function isReviewableResidualPovAttempt(attempt) {
  const reason = normalizedViolationGate({ gate: attempt?.record?.hardFailReason });
  if (!['pov', 'pov_inject'].includes(reason) || !String(attempt?.outputText || '').trim()) return false;
  const preservation = (attempt.record?.floorViolations || []).filter(isV2ChunkPreservationViolation);
  return preservation.length > 0 && preservation.every(violation => [
    'pov',
    'pov_inject'
  ].includes(normalizedViolationGate(violation)));
}

function normalizedViolationGate(v) {
  return String(v?.gate || v?.type || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_');
}

function buildV2EscalationPatchTargets(patchTargets, record) {
  const targets = Array.isArray(patchTargets) ? [...patchTargets] : [];
  if (record?.hardFailReason === 'noop_unchanged') {
    targets.push('원문과 완전히 같거나 조사·구두점·동의어 한두 개만 바꾼 출력은 이번 재시도 실패다. 사실·이미지·화자·제목·줄바꿈은 보존하고, 휴머나이징 대상 문장의 절 순서·연결 방식·호흡을 실질적으로 다시 구성한다.');
  }
  if (record?.hardFailReason === 'structure_boundary_marker_failed') {
    targets.push('원문의 V2_SENTENCE 토큰 사이에는 정확히 한 문장만 둔다. 문장을 추가 마침표로 더 나누거나 토큰 양쪽 문장을 합치지 말고, 모든 경계 토큰을 같은 순서로 그대로 출력한다.');
  }
  if (record?.hardFailReason === 'number_multiset_changed') {
    targets.push('원문의 모든 숫자·수량·연도·목록 번호를 같은 횟수로 정확히 보존한다. 새 숫자를 만들거나 기존 숫자를 삭제하지 않는다.');
  }
  if (record?.hardFailReason === 'list_structure_changed') {
    targets.push('원문의 목록 항목 수와 목록/본문 구분을 그대로 보존한다. 새 목록을 만들거나 항목을 합치지 않는다.');
  }
  if (['pov', 'pov_inject'].includes(normalizedViolationGate({ gate: record?.hardFailReason }))) {
    targets.push('1차 결과가 원문의 화자 종류를 바꿨다. 원문에 실제로 있는 1인칭 단수·복수만 유지하고, 원문에 없는 나는·저는·제가·우리·저희를 새로 만들거나 기존 화자를 삭제하지 않는다.');
  }
  if (record?.hardFailReason === 'voice_sparse_distribution_failed') {
    const violation = (record.floorViolations || []).find(v => normalizedViolationGate(v) === 'voice_sparse_distribution_failed');
    targets.push([
      '구두점 없는 원문을 비슷한 길이의 문장들로 균등 분할한 것이 1차 실패 원인이다. 원문의 의미와 순서를 그대로 둔 채 짧은 문장과 긴 문장이 분명히 섞이도록 다시 나눈다. 짧은 문장은 원문에 있던 완전한 절만 독립시키고, 앞 문장을 요약·평가·반복하는 새 덧문장은 만들지 않는다.',
      String(violation?.detail || '').trim()
    ].filter(Boolean).join(' '));
  }
  if (record?.hardFailReason === 'voice_existing_distribution_failed') {
    const violation = (record.floorViolations || []).find(v => normalizedViolationGate(v) === 'voice_existing_distribution_failed');
    targets.push([
      '1차 결과가 원문의 짧은 문장과 긴 문장 차이를 중간 길이로 평탄화했다. 문장별 주장과 경계를 유지하고, 원문의 문장 길이 순서·최단문·최장문 대비를 다시 보존한다.',
      String(violation?.detail || '').trim()
    ].filter(Boolean).join(' '));
  }
  const novelty = (record?.floorViolations || []).find(v => normalizedViolationGate(v) === 'novelty');
  if (novelty) {
    const detail = String(novelty.detail || '').trim().slice(0, 240);
    targets.push([
      '1차 결과에 원문에 없는 사실이 검출됐다. 원문에 없는 수치·연도·기관명·인용·고유명사를 모두 제거하고, 원문에 실제로 있는 내용만으로 다시 작성한다.',
      detail ? `검출 항목: ${detail}` : ''
    ].filter(Boolean).join(' '));
  }
  return targets;
}

function sanitizeOutput(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:결과|출력|재작성\s*결과|변환\s*결과)\s*[:：]\s*/i, '')
    .trim();
}

function chunkPostprocess(text, original, mode, contract, { preserveLineBreaks = false } = {}) {
  let out = String(text || '').trim();
  if (preserveLineBreaks) return out;
  try { out = local.spacing.fixSpacing(out).text; } catch {}
  try { out = local.spacing.restoreUrls(out, original).text; } catch {}
  try { out = local.spacing.stripAiUrlParams(out).text; } catch {}
  try {
    const target = mode === 'blog'
      ? (contract.register === 'polite' ? 'hap' : contract.register === 'haeyo' ? 'haeyo' : null)
      : (contract.register === 'polite' ? 'hap' : contract.register === 'plain' ? 'handa' : contract.register === 'haeyo' ? 'haeyo' : null);
    if (target) out = local.registernormalize.normalizeRegister(out, target).text;
  } catch {}
  return out.trim();
}

const STRUCT_LINE_RE = /^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.、)]|\d{1,2}(?!\d)\s*[.)]\s|\d{1,2}\.\d{1,2}|[가-하]\s*[.)]\s|[①-⑳]|[-•*+▪◦·●○■□◆◇▶▷※]\s|\|.*\||제\s?\d{1,3}\s?(?:조|장|절|항))/u;

function structJoinLocal(text) {
  const ls = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!ls.length) return '';
  let acc = ls[0];
  for (let k = 1; k < ls.length; k += 1) {
    acc += '\n' + ls[k];
  }
  return acc;
}

function tidyParagraphsLocal(doc, source = '') {
  const blocks = String(doc || '').split(/\n[ \t]*\n+/);
  const sourceParaCount = paragraphCount(source);
  const outputParaCount = blocks.map(b => b.trim()).filter(Boolean).length;
  return blocks.map((b, i) => {
    const t = b.trim();
    if (!t) return '';
    if (i === 0 && /\n\s*—/.test(b)) {
      return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    }
    if (sourceParaCount <= 1 && outputParaCount <= 1) return structJoinLocal(t);
    return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}

function finalPostprocess(text, source, mode, contract, meta = {}, { preserveLineBreaks = false } = {}) {
  let out = String(text || '').trim();
  if (!preserveLineBreaks) {
    try { out = tidyParagraphsLocal(out, source); } catch {}
    try {
      if (mode === 'blog') {
        const target = contract.register === 'polite' ? 'hap' : 'haeyo';
        out = local.basicblogtone.cleanupBasicBlogTone(out, { register: target }).text;
      }
    } catch {}
    // 문서 병합 뒤 흐름을 먼저 보정하고, 그 결과에 한해 제한적 exact dedupe를 적용한다.
    try {
      const fc = local.flowcohesion.flowCohesion(out, { preserveParagraphs: true });
      out = fc.text || out;
    } catch {}
    try {
      const dedupe = local.dedupe.dedupeSentences(out);
      out = dedupe.text;
      const blockDedupe = local.dedupe.removeNewExactDuplicateBlocks(source, out);
      out = blockDedupe.text;
      meta.dedupe = {
        removedExactCount: (dedupe.removed || 0) + (blockDedupe.removedSentenceCount || 0),
        removedBlockCount: blockDedupe.removedBlockCount || 0,
        removedBlockSentenceCount: blockDedupe.removedSentenceCount || 0,
        fuzzyWarningCount: dedupe.fuzzyWarnings?.length || 0,
        fuzzyWarnings: dedupe.fuzzyWarnings || []
      };
    } catch {}
  } else {
    meta.dedupe = { skipped: true, reason: 'creative_line_structure' };
  }
  try { out = local.spacing.restoreUrls(out, source).text; } catch {}
  return out.trim();
}

function freezeLockedBlocks(source, outputText, chunks) {
  let frozenSource = String(source || '');
  let frozenOutput = String(outputText || '');
  const blocks = [];
  const tokenByIndex = new Map();
  for (const chunk of chunks || []) {
    if (!chunk?.locked || !String(chunk.text || '').trim()) continue;
    const value = String(chunk.text);
    const token = `ZXQLOCK${String(blocks.length).padStart(4, '0')}QXZ`;
    const sourceReplaced = replaceFirstExact(frozenSource, value, token);
    const outputReplaced = replaceFirstExact(frozenOutput, value, token);
    if (!sourceReplaced.replaced || !outputReplaced.replaced) continue;
    frozenSource = sourceReplaced.text;
    frozenOutput = outputReplaced.text;
    blocks.push({ token, value, lockType: chunk.lockType || 'structure', index: chunk.index });
    tokenByIndex.set(chunk.index, token);
  }
  if (!blocks.length) return null;
  const auditChunks = (chunks || []).map(chunk => {
    const token = tokenByIndex.get(chunk.index);
    if (!token) return chunk;
    return { ...chunk, text: token, outputText: token };
  });
  return { source: frozenSource, output: frozenOutput, blocks, auditChunks };
}

function restoreLockedBlocks(text, blocks) {
  let output = String(text || '');
  for (const block of blocks || []) output = output.split(block.token).join(block.value);
  return output;
}

function replaceFirstExact(text, needle, replacement) {
  const index = String(text || '').indexOf(String(needle || ''));
  if (index < 0) return { text, replaced: false };
  return { text: text.slice(0, index) + replacement + text.slice(index + needle.length), replaced: true };
}

function dedupeQualityWarnings(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    if (!item?.code || !item?.message) return false;
    const key = `${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function depthQualityWarnings(report) {
  const reasons = new Set(report?.reasons || []);
  const warnings = [];
  if (reasons.has('substantive_carryover_high')) {
    warnings.push({
      code: 'humanization_carryover_high',
      severity: 'warning',
      message: '원문과 실질적으로 같은 일반 문장이 권장 상한보다 많이 남아 있어요.'
    });
  }
  if (reasons.has('rhetorical_remediation_low')) {
    warnings.push({
      code: 'rhetorical_remediation_incomplete',
      severity: 'warning',
      message: 'AI식으로 반복되는 담화 골격 일부가 충분히 완화되지 않았을 수 있어요.'
    });
  }
  if (reasons.has('resume_semantic_repetition_low')) {
    warnings.push({
      code: 'resume_semantic_repetition_remaining',
      severity: 'warning',
      message: '지원 이유나 진로 고민이 여러 문단에서 비슷하게 반복돼 결과 확인이 필요해요.'
    });
  }
  if ([
    'substantive_edit_ratio_low',
    'substantive_sentence_coverage_low',
    'risk_target_coverage_low',
    'structural_rewrite_coverage_low',
    'punctuation_or_surface_only'
  ].some(code => reasons.has(code))) {
    warnings.push({
      code: 'humanization_depth_below_minimum',
      severity: 'warning',
      message: '원문 보존을 우선해 목표 강도보다 약하게 변환됐어요. 결과를 확인해 주세요.'
    });
  }
  return warnings.length ? warnings : [{
    code: 'humanization_depth_below_minimum',
    severity: 'warning',
    message: '목표한 휴머나이징 강도에 일부 미달해 결과 확인이 필요해요.'
  }];
}

function depthWarningDetails(report, base = {}) {
  return depthQualityWarnings(report).map(item => ({
    ...base,
    gate: item.code,
    detail: item.message
  }));
}

function paragraphCount(text) {
  return String(text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean).length;
}

function buildResult({ source, outputText, contract, mode, records, inputRisk, niklQualityTest = false, qualityPatternLab = false, structureAudit = null }) {
  const result = {
    outputText,
    styleProfile: PROFILE,
    operation: 'humanize_only',
    contract,
    povSeed: contract.povSeed,
    records,
    inputRisk,
    structureLock: structureAudit || null
  };
  try { result.povDrift = floor.measurePovDrift(source, outputText, contract.povSeed); } catch {}
  try { result.floorNovelty = floor.measureNovelty(source, outputText, ''); } catch {}
  try { result.floorLength = floor.measureLength(source, outputText, mode); } catch {}
  try { result.repetition = floor.measureRepetition(outputText); } catch {}
  try { result.lostFacts = floor.measureLostFacts(source, outputText); } catch {}
  try { result.softDrift = local.softguard.measureSoftDrift(source, outputText); } catch {}
  try { result.conclusionDrift = local.softguard.measureConclusionDrift(source, outputText); } catch {}
  try { result.surface = surfaceguard.buildSurfaceReport(outputText); } catch {}
  try {
    result.noOpScore = local.outputguard.noOpScore(source, outputText);
    result.weakTransform = mode === 'polish' ? result.noOpScore >= 0.97 : result.noOpScore >= 0.88;
  } catch {}
  try { result.koreanQuality = compactKoreanQualityGate(koreanQuality.evaluateKoreanQuality(source, outputText, { mode, register: contract.register })); } catch {}
  try {
    result.floorReport = floor.buildFloorReport({
      result,
      rawText: source,
      mode,
      povSeed: contract.povSeed,
      optIn: false,
      allowedExtra: ''
    });
  } catch (err) {
    result.floorReport = {
      status: 'error',
      criticals: [{ gate: 'floor_report_error', detail: err && err.message || String(err) }],
      warnings: []
    };
  }
  attachKoreanQualityWarnings(result.floorReport, result.koreanQuality);
  if (niklQualityTest) {
    try {
      result.niklQualityTest = compactNiklQualityGate(safeNiklQualityGate(source, outputText, {
        mode,
        register: contract.register
      }));
    } catch {}
    result.niklQuality = result.niklQualityTest || null;
    attachNiklQualityWarnings(result.floorReport, result.niklQualityTest);
  }
  if (qualityPatternLab) {
    try {
      const protectedTerms = collectRecordProtectedTerms(records);
      const externalApiHintsUsed = records.some(r => r?.qualityPatternLab?.auditTrail?.externalApiHintsUsed === true);
      const audit = safeQualityPatternAudit(source, outputText, {
        mode,
        register: contract.register,
        protectedTerms,
        externalApiHintsUsed
      });
      const compact = compactQualityPatternAudit(audit);
      result.qualityPatternLab = {
        enabled: true,
        version: compact?.version || 'ko-quality-pattern-lab-v1',
        action: compact?.auditTrail?.action || 'pass',
        externalApiHintsUsed
      };
      result.qualityProfileBefore = compact?.qualityProfileBefore || null;
      result.qualityProfileAfter = compact?.qualityProfileAfter || null;
      result.patternDelta = compact?.patternDelta || null;
      result.auditTrail = compact?.auditTrail || null;
      result.protectedTermReport = compact?.protectedTermReport || null;
      result.claimStrengthDrift = compact?.claimStrengthDrift || null;
      result.rhetoricalInsertion = compact?.rhetoricalInsertion || null;
      result.grammarHardError = compact?.grammarHardError || null;
      result.externalApiHintsUsed = externalApiHintsUsed;
      attachQualityPatternWarnings(result.floorReport, compact);
    } catch {}
  }
  attachWeakTransformWarning(result.floorReport, result);
  if (qualityPatternLab) softenQualityPatternLabFloorReport(result.floorReport);
  softenFloorReport(result.floorReport);
  return result;
}

function attachKoreanQualityWarnings(report, quality) {
  if (!report || !quality || quality.action === 'pass') return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.warnings = [
    ...warnings,
    {
      gate: 'korean_quality_final',
      action: quality.action,
      reason: quality.reason || '',
      riskDelta: quality.riskDelta
    }
  ];
}

function attachNiklQualityWarnings(report, quality) {
  if (!report || !quality || quality.action === 'pass') return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.warnings = [
    ...warnings,
    {
      gate: 'nikl_quality',
      niklQuality: true,
      action: quality.action,
      reason: quality.reason,
      niklRiskDelta: quality.niklRiskDelta,
      beforeRisk: quality.beforeRisk,
      afterRisk: quality.afterRisk,
      missingTerms: quality.missingTerms || []
    }
  ];
}

function attachQualityPatternWarnings(report, audit) {
  if (!report || !audit || !audit.auditTrail) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const action = audit.auditTrail.action || 'pass';
  if (action === 'pass') return;
  const warningList = audit.auditTrail.warnings || [];
  report.warnings = [
    ...warnings,
    {
      gate: 'quality_pattern_lab',
      action,
      warnings: warningList,
      blockers: audit.auditTrail.blockers || [],
      riskDelta: audit.patternDelta?.riskDelta,
      protectedTermLossCount: audit.protectedTermReport?.lossCount || 0,
      grammarHardError: audit.grammarHardError?.introduced === true
    }
  ];
  if (report.status === 'clean') {
    report.status = action === 'blocked'
      ? 'blocked'
      : shouldPromoteWarningsToNeedsReview(warningList)
        ? 'needs_review'
        : report.status;
  }
}

function addStructureWarnings(report, audit) {
  if (!report || !audit) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const additions = [];
  if (audit.lostLockedCount > 0) {
    additions.push({
      gate: 'structure_lock_loss',
      action: 'needs_review',
      lostLockedCount: audit.lostLockedCount,
      lostLocked: audit.lostLocked || []
    });
  }
  if (audit.lockedOrderChanged) {
    additions.push({
      gate: 'structure_lock_order',
      action: 'needs_review',
      count: audit.lockedOutOfOrderCount || 0,
      items: audit.lockedOutOfOrder || []
    });
  }
  if (audit.boundaryRepair?.applied) {
    additions.push({
      gate: 'chunk_boundary_repaired',
      action: 'pass',
      count: audit.boundaryRepair.count,
      repairs: audit.boundaryRepair.repairs || []
    });
  }
  if (audit.unsafeBoundaryCount > 0) {
    additions.push({
      gate: 'unsafe_chunk_boundary',
      action: 'needs_review',
      count: audit.unsafeBoundaryCount,
      samples: audit.unsafeBoundaries || []
    });
  }
  if (audit.layoutRepair?.pass === false) {
    additions.push({
      gate: 'post_semantic_layout_incomplete',
      action: 'needs_review',
      detail: '의미 감사 뒤 목표 문단 구조와 가독성 기준을 완전히 충족하지 못했습니다.'
    });
  }
  if (!additions.length) return;
  report.warnings = [...warnings, ...additions];
  if (report.status === 'clean' && additions.some(v => v.action === 'needs_review')) {
    report.status = 'needs_review';
  }
}

function attachWeakTransformWarning(report, result) {
  if (!report || !result || !result.weakTransform) return;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.warnings = [
    ...warnings,
    {
      gate: 'weak_transform',
      noOpScore: Number(Number(result.noOpScore || 0).toFixed(3)),
      detail: 'output is close to source; delivered but should be monitored'
    }
  ];
}

function softenFloorReport(report) {
  if (!report || process.env.STRICT_QUALITY_GATE === '1') return report;
  if (report.status !== 'blocked') return report;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  if (process.env.GPT_SOFTEN_FLOOR_REPORT === '0') return report;
  if (hasStrictDeliveryCritical(criticals)) return report;
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  report.status = 'needs_review';
  report.warnings = [
    ...warnings,
    ...criticals.map(c => ({ ...c, softenedFromCritical: true }))
  ];
  report.criticals = [];
  return report;
}

function softenV2ReviewableCriticals(report, { mode = '', strictFallbackCause = false } = {}) {
  if (!report || report.status !== 'blocked') return report;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  const strict = criticals.filter(critical => {
    const gate = String(critical?.gate || critical?.type || '').trim();
    if (mode !== 'polish'
        && V2_SAFE_LOW_BENEFIT_GATES.has(gate)
        && !(gate === 'gpt_all_chunks_fallback' && strictFallbackCause)) return false;
    return STRICT_DELIVERY_GATES.has(gate) || isBlockingViolation(critical);
  });
  const reviewable = criticals.filter(critical => !strict.includes(critical));
  if (reviewable.length) {
    report.warnings = [
      ...(Array.isArray(report.warnings) ? report.warnings : []),
      ...reviewable.map(critical => ({
        ...critical,
        softenedFromCritical: true,
        v2DeliveryPolicy: true,
        v2LowBenefitDelivery: V2_SAFE_LOW_BENEFIT_GATES.has(String(critical?.gate || critical?.type || '').trim())
      }))
    ];
  }
  report.criticals = strict;
  report.status = strict.length ? 'blocked' : (reviewable.length ? 'needs_review' : report.status);
  return report;
}

function hasStrictRecordDeliveryFailure(records = []) {
  const strictPattern = /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated|refus(?:al|ed)/iu;
  return (records || []).some(record => {
    const values = [
      record?.hardFailReason,
      record?.error,
      record?.primaryError,
      ...(record?.primaryFailureCodes || []),
      ...(record?.floorViolations || []).map(item => item?.gate || item?.type),
      ...(record?.warnings || [])
    ];
    return values.some(value => strictPattern.test(String(value || '')));
  });
}

function hasStrictDeliveryCritical(criticals) {
  return (criticals || []).some(c => {
    const gate = String(c?.gate || c?.type || '').trim();
    return STRICT_DELIVERY_GATES.has(gate) || isBlockingViolation(c);
  });
}

function calibrateV2RepetitionReport(result, source, outputText) {
  if (!result) return null;
  const audit = qualityV2.compareRepetitionDelta(source, outputText);
  result.repetitionAudit = audit;
  if (audit.increased || !result.floorReport) return audit;
  const report = result.floorReport;
  const isRepetition = item => {
    if (typeof item === 'string') return item === 'repetition';
    return String(item?.gate || item?.type || '').trim() === 'repetition';
  };
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const removedCritical = criticals.some(isRepetition);
  const removedWarning = warnings.some(isRepetition);
  report.criticals = criticals.filter(item => !isRepetition(item));
  report.warnings = warnings.filter(item => !isRepetition(item));
  const hasReviewReason = report.criticals.length > 0
    || Number(report.metrics?.lostFacts || 0) >= 3
    || report.warnings.some(item => item?.softenedFromCritical === true
      || (item?.action && item.action !== 'pass'));
  if ((removedCritical || removedWarning) && !hasReviewReason
      && (report.status === 'blocked' || report.status === 'needs_review')) {
    report.status = 'clean';
  }
  report.metrics = {
    ...(report.metrics || {}),
    repetition: audit.after.total,
    sourceRepetition: audit.before.total,
    repetitionDelta: audit.delta.total
  };
  return audit;
}

function summarizeChunkExecution(records, semanticReport, {
  polishRetryCount = 0,
  generalSurfaceRetryCount = 0,
  koreanRefinementRetryCount = 0,
  fingerprintRetryCount = 0,
  endingStyleRetryCount = 0,
  resumeCoverageRetryCount = 0,
  sectionRecoveryCallCount = 0
} = {}) {
  const rows = Array.isArray(records) ? records : [];
  const lockedChunkCount = rows.filter(record => record.locked === true).length;
  const skippedChunkCount = rows.filter(record => record.skipped === true).length;
  const transformed = rows.filter(record => record.locked !== true && record.skipped !== true);
  const humanizeCallCount = transformed.reduce((sum, record) => sum + 1 + (record.escalated === true ? 1 : 0), 0);
  const semanticModelCallCount = semanticCallCount(semanticReport);
  const surfaceRetryCallCount = Math.max(0, Number(polishRetryCount) || 0)
    + Math.max(0, Number(generalSurfaceRetryCount) || 0)
    + Math.max(0, Number(koreanRefinementRetryCount) || 0)
    + Math.max(0, Number(fingerprintRetryCount) || 0)
    + Math.max(0, Number(endingStyleRetryCount) || 0)
    + Math.max(0, Number(resumeCoverageRetryCount) || 0)
    + Math.max(0, Number(sectionRecoveryCallCount) || 0);
  return {
    logicalChunkCount: rows.length,
    editableChunkCount: rows.length - lockedChunkCount,
    lockedChunkCount,
    skippedChunkCount,
    transformedChunkCount: transformed.length,
    humanizeCallCount,
    semanticModelCallCount,
    surfaceRetryCallCount,
    modelCallCount: humanizeCallCount + semanticModelCallCount + surfaceRetryCallCount,
    semanticSectionCount: Number(semanticReport?.sectionCount) || 0
  };
}

function semanticCallCount(report) {
  if (report?.ran !== true) return 0;
  const sections = Array.isArray(report.reports) ? report.reports : [];
  if (!sections.length) return Math.max(1, Number(report.sectionCount) || 1);
  return sections.reduce((sum, section) => {
    const baseJudges = section?.escalated === true ? 2 : 1;
    const rounds = Math.max(0, Number(section?.rounds) || 0);
    const rejectedRecheck = section?.repairRejected === true && rounds > 0 ? 1 : 0;
    return sum + baseJudges + (rounds * 2) - rejectedRecheck;
  }, 0);
}

function chunkRecord({
  chunk,
  outputText,
  fallback = false,
  skipped = false,
  locked = false,
  lockType = '',
  escalated = false,
  error = null,
  hardFailReason = '',
  primaryFailureCodes = [],
  warnings = [],
  floorViolations = [],
  usage = null,
  elapsedMs = 0,
  editIntensity = null,
  changedSentenceRatio = null,
  charEditRatio = null,
  lengthRatio = null,
  protectedTerms = [],
  selectedModel = '',
  judgeReport = null,
  koreanQuality = null,
  niklQuality = null,
  qualityPatternLab = null
}) {
  return {
    index: chunk.index,
    position: chunk.position,
    inLen: chunk.text.length,
    outLen: String(outputText || '').length,
    fallback,
    skipped,
    locked,
    lockType,
    sectionPath: chunk.sectionPath || '',
    escalated,
    error,
    hardFailReason,
    primaryFailureCodes: safeFailureCodeList(primaryFailureCodes),
    warnings: Array.isArray(warnings) ? warnings : [],
    floorViolations,
    usage,
    elapsedMs,
    editIntensity,
    changedSentenceRatio,
    charEditRatio,
    lengthRatio,
    protectedTerms,
    judgeReport,
    koreanQuality,
    niklQuality,
    qualityPatternLab,
    selectedModel
  };
}

function deterministicDetectFallback(text, err) {
  const ir = safeInputRisk(text);
  const ratio = Number(ir?.abstractRiskRatio) || 0;
  const probability = Math.round(Math.min(92, Math.max(15, 22 + 70 * ratio)));
  return {
    probability,
    summary: 'LLM 판정이 실패해 로컬 표면 지표 기준으로 임시 추정했습니다.',
    detail: '문단의 추상성, 균일한 문장 구조, 구체 정보 밀도를 기준으로 계산한 내부 fallback 값입니다.',
    signals: ['local_surface_fallback'],
    confidence: 'low',
    gptMeta: {
      provider: 'openai',
      engine: VERSION,
      fallback: true,
      error: err && err.message || String(err)
    }
  };
}

function normalizeDetectResult(json) {
  const probability = Math.max(0, Math.min(100, Math.round(Number(json.probability) || 0)));
  return {
    probability,
    summary: String(json.summary || '').trim() || '분석 결과를 생성했습니다.',
    detail: String(json.detail || '').trim(),
    signals: Array.isArray(json.signals) ? json.signals.slice(0, 12) : [],
    confidence: ['low', 'medium', 'high'].includes(json.confidence) ? json.confidence : 'medium'
  };
}

function shouldEscalateDetect(out, source, cfg) {
  if (!cfg?.models?.detectEscalation || cfg.models.detectEscalation === cfg.models.detect) return false;
  const probability = Number(out?.probability);
  const signals = Array.isArray(out?.signals) ? out.signals.length : 0;
  if (out?.confidence === 'low') return true;
  if (Number.isFinite(probability) && probability >= 45 && probability <= 65 && signals < 3) return true;
  if (String(source || '').length >= 6000 && out?.confidence !== 'high') return true;
  return false;
}

function collectWebSearchUrls(raw) {
  const urls = new Set();
  const walk = (node, path = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}.${i}`));
      return;
    }
    const type = String(node.type || node.kind || '').toLowerCase();
    const looksLikeSearchSource = /web|search|citation|annotation|source|result|reference/.test(path) ||
      /web|search|citation|annotation|source|result|reference/.test(type);
    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof value === 'string' && /url$/i.test(key) && /^https?:\/\//i.test(value) && looksLikeSearchSource) {
        const norm = normalizeEvidenceUrl(value);
        if (norm && !isUnsafeEvidenceUrl(norm)) urls.add(norm);
      } else {
        walk(value, nextPath);
      }
    }
  };
  walk(raw, '');
  urls.delete('');
  return urls;
}

function normalizeEvidenceUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function hasVerifiedUrl(url, verifiedUrls) {
  const norm = normalizeEvidenceUrl(url);
  if (!norm) return false;
  if (verifiedUrls.has(norm)) return true;
  for (const verified of verifiedUrls) {
    if (norm.startsWith(verified + '/') || verified.startsWith(norm + '/')) return true;
  }
  return false;
}

async function verifyEvidenceCandidates(candidates, parentSignal) {
  const out = [];
  for (const candidate of candidates.slice(0, 8)) {
    if (parentSignal?.aborted) throw new Error('aborted');
    const ok = await verifyEvidenceUrl(candidate.url, parentSignal);
    if (ok) out.push({ ...candidate, sourceVerified: true });
  }
  return out;
}

async function verifyEvidenceUrl(url, parentSignal) {
  if (await isUnsafeEvidenceFetchTarget(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.GPT_EVIDENCE_URL_VERIFY_TIMEOUT_MS) || 6000);
  const onAbort = () => controller.abort();
  try {
    if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
    let resp = await fetchEvidenceWithRedirects(url, 'HEAD', controller.signal);
    if (resp.status === 405 || resp.status === 403) {
      resp = await fetchEvidenceWithRedirects(url, 'GET', controller.signal);
    }
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
  }
}

async function fetchEvidenceWithRedirects(url, method, signal) {
  let current = String(url || '').trim();
  for (let i = 0; i < 4; i += 1) {
    if (await isUnsafeEvidenceFetchTarget(current)) throw new Error('unsafe_evidence_url');
    const resp = await fetch(current, {
      method,
      redirect: 'manual',
      signal,
      headers: method === 'GET' ? { Range: 'bytes=0-2048' } : undefined
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) return resp;
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('too_many_evidence_redirects');
}

function isUnsafeEvidenceUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === 'metadata.google.internal') return true;
    const ipType = net.isIP(host);
    if (!ipType) return false;
    return isPrivateIp(host, ipType);
  } catch {
    return true;
  }
}

async function isUnsafeEvidenceFetchTarget(url) {
  if (isUnsafeEvidenceUrl(url)) return true;
  try {
    const u = new URL(String(url || '').trim());
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (net.isIP(host)) return false;
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length) return true;
    return records.some(r => {
      const ipType = net.isIP(r.address);
      return !ipType || isPrivateIp(r.address, ipType);
    });
  } catch {
    return true;
  }
}

function isPrivateIp(host, ipType) {
  if (ipType === 4) {
    const parts = host.split('.').map(n => Number(n));
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  const v = host.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  if (v.startsWith('::ffff:')) return true;
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIp(mapped[1], 4);
  return false;
}

function metaFromResponse(res, cfg, extra = {}) {
  return {
    provider: 'openai',
    engine: VERSION,
    selectedModel: res.model,
    runtimeConfigSource: cfg.source,
    cachedInputTokens: res.usage?.cachedInputTokens || 0,
    reasoningTokens: res.usage?.reasoningTokens || 0,
    estimatedUsd: res.usage?.estimatedUsd || 0,
    usage: res.usage,
    ...extra
  };
}

function safeSurface(text) {
  try { return surfaceguard.buildSurfaceReport(text); } catch { return null; }
}

function safeInputRisk(text) {
  try { return surfaceguard.classifyInputRisk(text); } catch { return null; }
}

function safeKoreanQualityAnalysis(text, opts = {}) {
  try { return koreanQuality.analyzeText(text, opts); } catch { return null; }
}

function safeKoreanQualityHints(analysis) {
  try { return analysis ? koreanQuality.buildPromptHints(analysis, { max: 8 }) : ''; } catch { return ''; }
}

function safeKoreanQualityGate(source, output, opts = {}) {
  try { return koreanQuality.evaluateKoreanQuality(source, output, opts); } catch { return null; }
}

function safeNiklQualityAnalysis(text, opts = {}) {
  try { return koreanQuality.niklTest.analyzeNiklQuality(text, opts); } catch { return null; }
}

function safeNiklQualityHints(analysis) {
  try { return analysis ? koreanQuality.niklTest.buildNiklPromptHints(analysis, { max: 6 }) : ''; } catch { return ''; }
}

async function safeNiklExternalApiHints(text, protectedTerms = []) {
  try {
    if (process.env.GPT_NIKL_EXTERNAL_API_ENABLED !== '1') return '';
    const api = koreanQuality.officialApi;
    const status = api.getApiStatus();
    const providers = selectedNiklApiProviders(status);
    if (!providers.length) return '';
    const max = Math.max(0, Math.min(2, Number(process.env.GPT_NIKL_API_LOOKUP_MAX || 2) || 2));
    if (!max) return '';
    const candidates = selectNiklApiCandidates(text, protectedTerms).slice(0, max);
    if (!candidates.length) return '';
    const timeoutMs = Math.max(500, Math.min(1200, Number(process.env.NIKL_API_TIMEOUT_MS || 1200) || 1200));
    const settled = await Promise.allSettled(candidates.map(query =>
      api.lookupCandidate(query, { providers, timeoutMs })
    ));
    const lookups = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(hasNiklLookupHit)
      .slice(0, max);
    if (!lookups.length) return '';
    const lines = [
      '[국립국어원 외부 API 조회 힌트]',
      '표준국어대사전/우리말샘/온용어 조회 결과다. 정의문을 복사하지 말고, 용어 표기 보존과 어색한 치환 방지에만 사용한다.',
      '조회된 용어는 원문 핵심 표기로 보아 임의로 쉬운 말이나 다른 용어로 바꾸지 않는다.'
    ];
    for (const item of lookups) lines.push(formatNiklLookupHint(item));
    return lines.join('\n');
  } catch {
    return '';
  }
}

function safeNiklQualityGate(source, output, opts = {}) {
  try { return koreanQuality.niklTest.evaluateNiklQuality(source, output, opts); } catch { return null; }
}

function safeQualityPatternProfile(text, opts = {}) {
  try { return koreanQuality.qualityPatternLab.buildQualityProfile(text, opts); } catch { return null; }
}

function safeQualityPatternHints(profile) {
  try { return profile ? koreanQuality.qualityPatternLab.buildPromptHints(profile, { max: 8 }) : ''; } catch { return ''; }
}

function safeQualityPatternAudit(source, output, opts = {}) {
  try { return koreanQuality.qualityPatternLab.buildAudit(source, output, opts); } catch { return null; }
}

function compactQualityPatternAudit(audit) {
  try { return koreanQuality.qualityPatternLab.compactAudit(audit); } catch { return null; }
}

function compactKoreanQualityGate(gate) {
  if (!gate) return null;
  return {
    action: gate.action,
    reason: gate.reason || '',
    koreanRiskDelta: gate.riskDelta,
    grammarHardDelta: gate.grammarHardDelta || 0,
    koreanSkillRisk: gate.output?.koreanSkillRisk,
    translationeseRisk: gate.output?.translationeseRisk,
    grammarRisk: gate.output?.grammarRisk,
    styleConsistencyRisk: gate.output?.styleConsistencyRisk,
    grade: gate.output?.grade,
    topKoreanPatterns: (gate.output?.topPatterns || []).slice(0, 8)
  };
}

function compactNiklQualityGate(gate) {
  try { return koreanQuality.niklTest.compactNiklReport(gate); } catch { return null; }
}

function collectRecordProtectedTerms(records = []) {
  const out = [];
  const seen = new Set();
  for (const record of records || []) {
    for (const term of record?.protectedTerms || []) {
      const value = String(term || '').trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= 160) return out;
    }
  }
  return out;
}

function softenQualityPatternLabFloorReport(report) {
  if (!report || report.status !== 'blocked') return report;
  const criticals = Array.isArray(report.criticals) ? report.criticals : [];
  if (!criticals.length) return report;
  const strict = criticals.filter(isQualityPatternStrictCritical);
  const soft = criticals.filter(c => !isQualityPatternStrictCritical(c));
  if (strict.length) {
    report.criticals = strict;
    if (soft.length) {
      report.warnings = [
        ...(Array.isArray(report.warnings) ? report.warnings : []),
        ...soft.map(c => ({ ...c, softenedFromCritical: true, qualityPatternLab: true }))
      ];
    }
    return report;
  }
  report.status = 'needs_review';
  report.warnings = [
    ...(Array.isArray(report.warnings) ? report.warnings : []),
    ...soft.map(c => ({ ...c, softenedFromCritical: true, qualityPatternLab: true }))
  ];
  report.criticals = [];
  return report;
}

function isQualityPatternStrictCritical(c) {
  const gate = String(c?.gate || c?.type || '').trim();
  return /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated/i.test(gate);
}

function compactRisk(inputRisk) {
  if (!inputRisk) return '';
  return JSON.stringify({
    risk: inputRisk.risk || 'ok',
    grade: inputRisk.grade || '',
    abstractRiskRatio: inputRisk.abstractRiskRatio,
    needsUserAnchor: inputRisk.needsUserAnchor === true
  });
}

function composeRiskProfile(inputRisk, koreanQualityHints, niklQualityHints = '') {
  const parts = [];
  const base = compactRisk(inputRisk);
  if (base) parts.push(base);
  if (koreanQualityHints) parts.push(koreanQualityHints);
  if (niklQualityHints) parts.push(niklQualityHints);
  return parts.join('\n\n');
}

function selectedNiklApiProviders(status) {
  const keys = status?.keys || {};
  const requested = String(process.env.GPT_NIKL_API_PROVIDERS || 'opendict,stdict,term')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  return requested.filter(p => ['opendict', 'stdict', 'term'].includes(p) && keys[p]);
}

function selectNiklApiCandidates(text, protectedTerms = []) {
  const out = new Set();
  const push = value => {
    const v = String(value || '')
      .replace(/\([^)]*\)/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^가-힣A-Za-z0-9·\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!v || v.length < 2 || v.length > 28) return;
    if (/^\d/.test(v) || /^[A-Za-z0-9 .-]+$/.test(v)) return;
    if (!/[가-힣]/.test(v)) return;
    out.add(v);
  };
  for (const term of protectedTerms || []) push(term);
  const source = String(text || '');
  const technical = source.match(/[가-힣A-Za-z0-9·-]{2,}(?:시스템|기술|설비|기능|인프라|플랫폼|데이터|과정|정책|이론|분석|서비스|교육|연구|관리|운영)/g) || [];
  for (const term of technical) push(term);
  const quoted = source.match(/[“"']([^“"']{2,24})[”"']/g) || [];
  for (const term of quoted) push(term.replace(/[“”"']/g, ''));
  return [...out].slice(0, 12);
}

function hasNiklLookupHit(item) {
  const providers = item?.providers || {};
  return Object.entries(providers).some(([name, p]) => {
    const hasItems = Array.isArray(p?.items) && p.items.length > 0;
    if (name === 'term') return hasItems;
    return hasItems || Number(p?.total || 0) > 0;
  });
}

function formatNiklLookupHint(item) {
  const providers = item?.providers || {};
  const sourceNames = [];
  const words = new Set();
  if (providers.opendict) {
    sourceNames.push('우리말샘');
    for (const v of providers.opendict.items || []) if (v.word) words.add(v.word);
  }
  if (providers.stdict) {
    sourceNames.push('표준국어대사전');
    for (const v of providers.stdict.items || []) if (v.word) words.add(v.word);
  }
  if (providers.term && Array.isArray(providers.term.items) && providers.term.items.length) {
    sourceNames.push('온용어');
    for (const v of providers.term.items || []) if (v.word) words.add(v.word);
  }
  const wordList = [...words].slice(0, 4).join(', ');
  return `- "${item.query}": ${sourceNames.join('/')} 조회됨${wordList ? `, 표기 후보 ${wordList}` : ''}`;
}

async function safeFormatLayout(text, opts = {}) {
  try {
    const source = String(text || '').trim();
    if (!source) return null;
    return await layoutNormalizer.formatDocument(source, {
      mode: opts.mode || 'assignment',
      phase: opts.phase || 'post',
      // Python NLP(kiwipiepy/kss)는 변환마다 서브프로세스로 모델을 새로 로드해 Render 512Mi에서 OOM 크래시 루프를
      // 일으켰다(2026-07-05~09 실사고). 운영은 JS 포맷팅만 쓰고, Python은 메모리 여유 있는 환경에서만 opt-in.
      enableNlp: process.env.LAYOUT_NLP_PYTHON_ENABLED === '1',
      timeoutMs: Number(process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000,
      maxChars: Number(process.env.LAYOUT_NLP_MAX_CHARS || 12000) || 12000
    });
  } catch (err) {
    logger.warn('gpt.layout_format_failed', {
      phase: opts.phase || 'post',
      err: err && err.message || String(err)
    });
    return null;
  }
}

function buildLayoutFormatMeta(preLayout, postLayout, rawSource, outputText) {
  const pre = preLayout?.report || null;
  const post = postLayout?.report || null;
  return {
    enabled: true,
    version: layoutNormalizer.VERSION,
    inputChanged: pre?.applied === true,
    outputChanged: post?.applied === true,
    sourceChanged: pre?.applied === true,
    finalOutputChanged: post?.applied === true,
    pre: compactLayoutReport(pre),
    post: compactLayoutReport(post),
    engines: mergeLayoutEngines(pre, post),
    beforeChars: String(rawSource || '').length,
    afterChars: String(outputText || '').length
  };
}

function compactLayoutReport(report) {
  if (!report) return null;
  return {
    phase: report.phase || '',
    profile: report.profile || '',
    applied: report.applied === true,
    need: report.need || null,
    before: report.before || null,
    after: report.after || null,
    gates: report.gates || null,
    spacingGate: report.spacingGate || null,
    nlp: report.nlp || null
  };
}

function mergeLayoutEngines(pre, post) {
  const names = ['kss', 'kiwipiepy', 'pykospacing'];
  const out = {};
  for (const name of names) {
    const p = pre?.nlp?.engines?.[name] || {};
    const q = post?.nlp?.engines?.[name] || {};
    out[name] = {
      ok: p.ok === true || q.ok === true,
      version: p.version || q.version || '',
      preOk: p.ok === true,
      postOk: q.ok === true,
      error: p.ok === true || q.ok === true ? '' : String(q.error || p.error || '').slice(0, 180)
    };
  }
  return out;
}

function looksLikeMeta(text) {
  return /^(죄송|I'?m sorry|As an AI|정책상|요청하신|변환 결과|재작성 결과)/i.test(String(text || '').trim());
}

function looksLikePromptLeak(text) {
  return /(재작성할\s*텍스트|작업\s*위치|본문이다\.\s*이\s*청크만\s*(?:다듬는다|선택한\s*강도에\s*맞게\s*변환한다)|앞\s*문맥\s*-\s*참고만|뒤\s*문맥\s*-\s*참고만)/.test(String(text || ''));
}

function summarizeChunkFailureCodes(records) {
  const primary = [];
  const residual = [];
  const fallback = [];
  const rows = Array.isArray(records) ? records : [];
  for (const record of rows) {
    addSafeFailureCode(primary, record?.primaryError);
    for (const code of record?.primaryFailureCodes || []) addSafeFailureCode(primary, code);
    addSafeFailureCode(residual, record?.hardFailReason);
    if (record?.hardFailReason || record?.fallback === true) addSafeFailureCode(residual, record?.error);
    for (const violation of record?.floorViolations || []) {
      addSafeFailureCode(residual, violation?.gate || violation?.type);
    }
    for (const warning of record?.warnings || []) {
      const value = String(warning || '').trim();
      if (/^v2_retry:/iu.test(value)) addSafeFailureCode(primary, value.slice(value.indexOf(':') + 1));
      else if (/^v2_residual:/iu.test(value)) addSafeFailureCode(residual, value.slice(value.indexOf(':') + 1));
      else if (/^(?:gpt_primary_and_escalation_failed|general_surface_retry_safe_fallback)$/iu.test(value)) {
        addSafeFailureCode(record?.fallback === true ? fallback : residual, value);
      }
    }
    if (record?.fallback === true) {
      addSafeFailureCode(fallback, record?.hardFailReason);
      addSafeFailureCode(fallback, record?.error);
      for (const violation of record?.floorViolations || []) {
        addSafeFailureCode(fallback, violation?.gate || violation?.type);
      }
    }
  }
  const all = safeFailureCodeList([...primary, ...residual, ...fallback]);
  return {
    all,
    primary: safeFailureCodeList(primary),
    residual: safeFailureCodeList(residual),
    fallback: safeFailureCodeList(fallback)
  };
}

function safeFailureCodesFromRecord(record) {
  return safeFailureCodeList([
    record?.hardFailReason,
    record?.error,
    ...(record?.floorViolations || []).map(violation => violation?.gate || violation?.type)
  ]);
}

function safeFailureCodeList(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const code = safeFailureCode(value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= 24) break;
  }
  return out;
}

function sanitizeCountMap(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const [rawCode, rawCount] of Object.entries(source).slice(0, 24)) {
    const code = safeFailureCode(rawCode);
    if (!code) continue;
    output[code] = Math.max(0, Number(rawCount) || 0);
  }
  return output;
}

function addUniqueCode(values, code) {
  if (!Array.isArray(values)) return;
  const normalized = String(code || '').trim();
  if (normalized && !values.includes(normalized)) values.push(normalized);
}

function addSafeFailureCode(target, value) {
  const code = safeFailureCode(value);
  if (code) target.push(code);
}

function safeFailureCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z][A-Za-z0-9_.:-]{1,79}$/u.test(raw)) {
    return raw.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 80);
  }
  const lower = raw.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/u.test(lower)) return 'openai_rate_limited';
  if (/timeout|timed out|deadline/u.test(lower)) return 'openai_timeout';
  if (/abort(?:ed|error)?/u.test(lower)) return 'request_aborted';
  if (/refusal|content.?filter|safety.?refusal/u.test(lower)) return 'openai_refusal';
  if (/schema|invalid json|malformed json|json parse/u.test(lower)) return 'openai_schema_error';
  if (/network|fetch failed|econnreset|enotfound|socket hang up/u.test(lower)) return 'openai_network_error';
  return '';
}

function looksEncodingCorrupted(original, outputText) {
  const src = String(original || '');
  const out = String(outputText || '');
  if (!/[가-힣]/.test(src)) return false;
  const q = (out.match(/\?/g) || []).length;
  if (q >= 8 && q / Math.max(1, out.length) >= 0.08) return true;
  return /\?{2,}.*\?{2,}.*\?{2,}/.test(out);
}

function looksTruncated(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/[,:;，、]$/.test(s)) return true;
  return /(?:그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/.test(s);
}

function normalizeBare(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

module.exports = {
  VERSION,
  PROFILE,
  run,
  detect,
  rewriteSentence,
  suggestEvidence,
  normalizeMode,
  effectiveModeForProfile
};
