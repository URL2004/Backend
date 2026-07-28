'use strict';

const net = require('net');
const dns = require('dns').promises;
const { completeJson, webSearchTool, safetyIdentifierForUid } = require('./openaiClient');
const { HUMANIZE_SCHEMA, DETECT_SCHEMA, REWRITE_SCHEMA, EVIDENCE_SCHEMA } = require('./schemas');
const { applyDetectNarrativePolicy } = require('../lib/detectNarrativePolicy');
const prompts = require('./prompts');
const { addUsage, emptyUsage } = require('./usageCost');
const { buildContract } = require('../engine/contract');
const structureChunk = require('./structureChunk');
const floor = require('../engine/floor');
const surfaceguard = require('../engine/surfaceguard');
const spacing = require('../engine/spacing');
const dedupe = require('../engine/dedupe');
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
  sentenceDistributionShift,
  paragraphExpansionLimit
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
const literalSpans = require('./literalSpans');
const candidateIntegrity = require('./candidateIntegrity');
const safeEditAccumulator = require('./safeEditAccumulator');
const commercialSignals = require('./commercialSignals');
const omissionRestore = require('./omissionRestore');
const {
  classifyModelFailure,
  isNonEscalatableModelFailureCode
} = require('./modelFailure');
const { shouldPassThrough, shouldPreserveVoiceSentenceBoundaries } = require('./chunkPolicy');
const deliveryPolicy = require('../lib/humanizeDeliveryPolicy');

const VERSION = 'gpt-prod-v2.5.11';
const PROFILE = 'engine-gpt-prod';
const REVIEW_WARNING_GATES = new Set([
  'section_anchor_loss',
  'length_collapse',
  'protected_term_loss',
  'structure_lock_loss',
  'structure_lock_order',
  'questionnaire_structure_changed',
  'unsafe_chunk_boundary',
  'section_path_mismatch',
  'grammar_hard_error',
  'speaker_drift',
  'register_shift',
  'paragraph_collapse',
  'number_multiset_changed',
  // 휴머나이징 강도·동일 문장 잔존은 결과 안전 경고가 아니라
  // effectStatus/effectNotices의 단일 소유 영역이다.
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

function isAdminNiklProfile(styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  return profile.includes('admin') || profile.includes('lab') || profile.includes('test');
}

function isNiklQualityEnabled(value, styleProfile = '') {
  // NIKL 리소스는 관리자 검증용으로 유지하되 운영 변환 경로에는 명시적으로
  // 켜지 않는 한 로드하지 않는다. 한국어 판정의 단일 소유자는
  // koreanRefinement이며, NIKL은 delivery/후보 선택에 관여하지 않는다.
  if (process.env.GPT_NIKL_QUALITY_ENABLED !== '1') return false;
  return value === true && isAdminNiklProfile(styleProfile);
}

function isLayoutNlpEnabled(value) {
  if (process.env.GPT_LAYOUT_NLP_ENABLED === '0' || process.env.LAYOUT_NLP_PRODUCTION_ENABLED === '0') return false;
  if (value === true) return true;
  if (value === false) return false;
  return true;
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
  const mediumConfidenceDistinctProfile = confidence >= 0.55 && [
    'long_explainer',
    'clinical_record',
    'legal_contract',
    'student_record_teacher',
    'student_self_assessment',
    'resume_application',
    'mail_notice',
    'creative'
  ].includes(profile);
  // 기본 피하기는 요청 강도를 뜻할 뿐 블로그 문체 강제가 아니다. 임상·지원서·
  // 세특처럼 형태가 뚜렷한 장르는 중간 신뢰도에서도 장르 프롬프트를 쓰되,
  // `결론` 같은 일반 낱말만으로 잡힌 학술·보고서 후보는 0.75 또는 report 힌트를
  // 요구한다. 그래야 짧은 일반 글이 학술 문체로 과교정되지 않는다.
  if ((confidence >= 0.75 || trustedOverride || mediumConfidenceDistinctProfile) && [
    'academic_paper',
    'report_assignment',
    'long_explainer',
    'clinical_record',
    'legal_contract',
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
  return runEngine(options);
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
  layoutNlp = null
} = {}) {
  const submittedSource = String(text || '').trim();
  if (!submittedSource) throw new Error('engine-gpt-prod: empty text');
  const sourcePreflightAudit = sourcePreflight.auditAndSanitizeSource(submittedSource);
  const rawSource = sourcePreflightAudit?.text || submittedSource;
  if (inputRouting.isEnglishInput(rawSource)) {
    const error = new Error('현재 휴머나이징 엔진은 한국어 글만 지원해요. 영어 입력은 원문 보존을 위해 변환하지 않습니다.');
    error.code = 'HUMANIZE_KOREAN_ONLY';
    error.noCharge = true;
    throw error;
  }
  const cfg = await loadConfig(config);
  const humanizationDepthEnabled = isHumanizationDepthEnabled();
  const requestedMode = normalizeRequestedMode(mode);
  const requestStrength = requestStrengthForMode(requestedMode);
  const polishAllowed = allowPolish === true;
  const normalizedMode = normalizeMode(mode, { allowPolish: polishAllowed });
  const detectedDocumentProfile = detectDocumentProfile(rawSource, { basicStyle });
  const documentProfile = applyTargetRegister(
    applyDocumentProfileOverride(detectedDocumentProfile, documentProfileOverride),
    { requestStrength, basicStyle }
  );
  const selectedMode = effectiveModeForProfile(requestedMode, normalizedMode, documentProfile);
  const voiceProfile = buildVoiceProfile(rawSource, { documentProfile, mode: selectedMode });
  const safetyId = safetyIdentifier || (uid ? safetyIdentifierForUid(uid) : '');
  const lineBoundaryPolicy = String(voiceProfile?.lineBoundaryPolicy || 'none');
  const layoutStructureLocked = lineBoundaryPolicy !== 'none';
  const layoutNlpEnabled = isLayoutNlpEnabled(layoutNlp) && !layoutStructureLocked;
  const preLayout = null;
  const inlineCodeFreeze = literalSpans.freezeInlineCode(rawSource);
  const source = inlineCodeFreeze.text;
  const niklQualityEnabled = isNiklQualityEnabled(niklQualityTest, styleProfile);
  const allowedExtra = deliveryPolicy.buildAllowedExtra({ evidence, userNotes });
  const contract = buildContract(source, { mode: selectedMode, lang, optIn: !!String(userNotes || '').trim() });
  const inputRisk = safeInputRisk(source);
  const sourceSurface = safeSurface(source);
  const chunkPlan = structureChunk.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveSentenceBoundaries: shouldPreserveVoiceSentenceBoundaries(
      source,
      voiceProfile,
      selectedMode,
      requestStrength
    ),
    sentenceBoundaryMinimum: selectedMode === 'polish' ? 3 : 4,
    preserveLineBoundaries: lineBoundaryPolicy,
    formatProfile: documentProfile.formatProfile
  });
  const chunks = chunkPlan.chunks;
  const chunkConcurrency = configuredChunkConcurrency();
  const records = await mapWithConcurrency(chunks, chunkConcurrency, async (chunk, i) => {
    return processChunk({
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
      safetyIdentifier: safetyId,
      signal
    });
  }, signal);

  let sectionRecoveryReport = {
    metrics: {
      enabled: sectionRecovery.isEnabled(),
      attempted: 0,
      applied: 0,
      escalated: 0,
        selectedSectionCount: 0,
        selectedTargetOnlyCount: 0,
        miniAttemptCount: 0,
        escalationAttemptCount: 0,
        escalationEligibleCount: 0,
        escalationSkippedCount: 0,
        escalationSkipCodes: [],
        escalationSkipCodeCounts: {},
        escalationMaximum: sectionRecovery.configuredMaxEscalations(),
        concurrency: sectionRecovery.RECOVERY_CONCURRENCY,
      sectionIndices: [],
      appliedSectionIndices: [],
      rejectedAttemptCount: 0,
      rejectionCodes: [],
      rejectionCodeCounts: {},
      miniAppliedCount: 0,
      escalationAppliedCount: 0,
      partialAppliedCount: 0,
      partialAppliedSentenceCount: 0,
      partialRejectedSentenceCount: 0,
      partialRejectionCodes: []
    },
    usages: []
  };
  if (humanizationDepthEnabled && rawSource.length >= sectionRecovery.MIN_DOCUMENT_CHARS) {
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
      validateCandidate: ({ entry, currentOutput, candidate }) => auditGeneralSurfaceCandidate(
        entry.source,
        candidate,
        contract,
        documentProfile,
        selectedMode,
        currentOutput,
        entry.plan
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
  const frozen = freezeLockedBlocks(source, outputText, chunks);
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
  let safePartialCandidateAppliedCount = Number(sectionRecoveryReport.metrics?.partialAppliedCount || 0);
  let safePartialSentenceAppliedCount = Number(sectionRecoveryReport.metrics?.partialAppliedSentenceCount || 0);
  let safePartialSentenceRejectedCount = Number(sectionRecoveryReport.metrics?.partialRejectedSentenceCount || 0);
  const safePartialRejectionCodes = safeFailureCodeList(sectionRecoveryReport.metrics?.partialRejectionCodes);
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
  let koreanSourceRestoreCount = 0;
  let quoteIntegrityAudit = null;
  let inlineCodeIntegrity = { pass: true, restoredCount: 0, missingCount: 0 };
  let quoteIntegrityRestoreCount = 0;
  let finalQuoteIntegrityRestoreCount = 0;
  let fingerprintAudit = null;
  let fingerprintRetryAttemptCount = 0;
  let fingerprintRepairCount = 0;
  let fingerprintRetryApplied = false;
  let fingerprintSourceRestoreCount = 0;
  let finalSourceIntegrityRestoreCount = 0;
  const finalSourceIntegrityRestoreCodes = [];
  let finalKoreanSourceRestoreCount = 0;
  const finalKoreanSourceRestoreCodes = [];
  let endingStyleAudit = null;
  let endingStyleRetryAttemptCount = 0;
  let endingStyleRepairCount = 0;
  let endingStyleRetryApplied = false;
  let endingStyleSourceRestoreCount = 0;
  let resumeCoverageAudit = null;
  let resumeCoverageRetryAttemptCount = 0;
  let resumeCoverageRepairCount = 0;
  let resumeCoverageRetryApplied = false;
  let experienceCandidateAudit = null;
  let deterministicOmissionRestoreCount = 0;
  let deterministicOmissionRestoreRejectedCount = 0;
  const deterministicOmissionRestoreRejectionCodes = [];
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
  const sourceReviewWarnings = [
    ...(sourcePreflightAudit?.warnings || []),
    ...koreanRefinement.buildSourceReviewWarnings(rawSource, documentProfile),
    ...commercialSignals.buildSourceReviewWarnings(documentProfile)
  ];
  if (selectedMode === 'polish') {
    polishReport = qualityV2.polishEditPolicy(auditSource, outputText, { documentProfile });
    polishPaddingReport = qualityV2.comparePolishEvaluativePadding(auditSource, outputText);
    polishEvaluativePaddingCodes = safeFailureCodeList(polishPaddingReport.introducedCodes);
    if (!polishReport.noSafeChange && polishPaddingReport.increased) {
      const restored = qualityV2.restorePolishEvaluativePaddingSentences(auditSource, outputText);
      if (restored.applied) {
        outputText = restored.text;
        polishRetryReason = 'evaluative_padding';
        polishRetryCount = 1;
        polishDeterministicPaddingRestoreCount = restored.restoredSentenceCount || 1;
        polishReport = qualityV2.polishEditPolicy(auditSource, outputText, { documentProfile });
        polishPaddingReport = qualityV2.comparePolishEvaluativePadding(auditSource, outputText);
      }
    }
    // 원문 교정 항목 잔존은 아래 공통 koreanRefinement 경로가 결정론 수리 후
    // 문제 문장만 모델로 고친다. 여기서 별도 surface 재시도를 먼저 실행하면
    // 두 수리기가 같은 오류를 놓고 경쟁하고, 편집률만 맞는 무관한 후보가
    // 한국어 수리보다 먼저 채택될 수 있다.
    if (polishReport.noSafeChange || polishPaddingReport.increased) {
      try {
        polishRetryReason ||= polishReport.noSafeChange
          ? 'unchanged'
          : 'evaluative_padding';
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
        const retryCandidate = String(retried.outputText || '').trim();
        const candidateReport = qualityV2.polishEditPolicy(auditSource, retryCandidate, { documentProfile });
        const candidatePadding = qualityV2.comparePolishEvaluativePadding(auditSource, retryCandidate);
        const retryContentUnsafe = compareNumberMultiset(auditSource, retryCandidate).changed
          || floor.measureLostFacts(auditSource, retryCandidate).count > 0
          || floor.measureNovelty(auditSource, retryCandidate, allowedExtra).count > 0;
        const safeRetryCandidate = retried.safeChangeFound === true
          && isSafeLocalizedLanguageCandidate({
            source: auditSource,
            before: outputText,
            candidate: retryCandidate,
            contract,
            documentProfile,
            mode: selectedMode,
            protectedTerms: collectRecordProtectedTerms(records),
            maxLocalEditRatio: 0.45,
            minLocalLengthRatio: 0.85,
            maxLocalLengthRatio: 1.15
          })
          && preservesFinalStructure(
            auditSource,
            retryCandidate,
            frozen ? frozen.auditChunks : chunks,
            chunkPlan,
            boundaryRepair
          );
        if (safeRetryCandidate) {
          outputText = retryCandidate;
          polishReport = candidateReport;
          polishPaddingReport = candidatePadding;
        }
        polishEvaluativePaddingCodes = safeFailureCodeList([
          ...polishEvaluativePaddingCodes,
          ...candidatePadding.introducedCodes
        ]);
        // 가장 구체적인 실패 원인을 먼저 보존한다. 공통 후보 감사가 평가성
        // 주장 추가도 함께 거부하므로 안전 후보가 아니란 이유만으로 이를
        // 단순 무변환으로 덮으면 운영 원인과 사용자 안내가 어긋난다.
        if (retryContentUnsafe) {
          // The retry is not the delivered result: preserve the original and
          // report that no safe polish change was produced. Labeling an
          // unrelated, fact-losing draft as excessive/evaluative would hide
          // the actual outcome (the source remained unchanged).
          polishStrictFailure = 'polish_unchanged';
        } else if (candidatePadding.increased) {
          polishStrictFailure = 'polish_evaluative_padding_added';
        } else if (candidateReport.excessiveChange) {
          polishStrictFailure = 'polish_excessive_change';
        } else if (!safeRetryCandidate || candidateReport.noSafeChange) {
          polishStrictFailure = 'polish_unchanged';
        } else {
          acceptGeneralSurfaceRecovery(records);
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
  const humanizationDepthStages = [];
  const recordHumanizationDepthStage = (stage, report = null, value = outputText) => {
    if (!humanizationDepthEnabled || selectedMode === 'polish') return null;
    const measured = report || humanizationDepth.evaluateHumanizationDepth(
      auditSource,
      value,
      humanizationPlan
    );
    humanizationDepthStages.push(buildDepthStageSnapshot(stage, measured));
    return measured;
  };
  const humanizationPlan = humanizationDepthEnabled ? humanizationDepth.buildHumanizationPlan(auditSource, {
    requestStrength,
    documentProfile,
    inputRisk
  }) : null;
  let humanizationDepthReport = humanizationDepthEnabled
    ? humanizationDepth.evaluateHumanizationDepth(auditSource, outputText, humanizationPlan)
    : null;
  recordHumanizationDepthStage('post_merge', humanizationDepthReport);
  const generalSurfaceRetryPending = records.some(record => (record.warnings || []).includes('general_surface_retry_pending'))
    && records.every(record => record.fallback !== true || (record.warnings || []).includes('general_surface_retry_safe_fallback'));
  if (selectedMode !== 'polish'
      && (generalSurfaceRetryPending
        || humanizationDepth.needsHumanizationRecovery(humanizationDepthReport))) {
    const wasEquivalent = normalizeBare(auditSource) === normalizeBare(outputText);
    const startedWithSevereNoEffect = wasEquivalent || isSevereHumanizationNoEffect(humanizationDepthReport);
    const longDocumentRecovery = rawSource.length >= sectionRecovery.MIN_DOCUMENT_CHARS
      && sectionRecovery.isEnabled();
    // 장문은 이미 최대 8개 절을 병렬 회복했으므로 문서 전체에서 놓친 대상만
    // mini로 한 번 마감한다. 단문은 두 번까지 시도하되 기본도 최소 효과만
    // 넘었다는 이유로 목표 미달 상태에서 조기 종료하지 않는다.
    const maxDepthAttempts = longDocumentRecovery ? 1 : 2;
    if (startedWithSevereNoEffect) finalNoopRecovery.attempted = true;
    let lastRetryError = null;
    for (let attempt = 0; attempt < maxDepthAttempts; attempt += 1) {
      const roleRecoveryPending = (humanizationDepthReport?.reasons || []).some(reason => [
        'resume_semantic_repetition_low',
        'paragraph_rewrite_coverage_low'
      ].includes(reason));
      const severeNoEffect = isSevereHumanizationNoEffect(humanizationDepthReport);
      if (attempt > 0
          && (humanizationDepthEnabled
            ? !humanizationDepth.needsHumanizationRecovery(humanizationDepthReport)
            : humanizationDepthReport?.pass === true)) break;
      try {
        generalSurfaceRetryAttemptCount += 1;
        humanizationDepthRetryCount += 1;
        // 원문과 완전히 같은 결과는 일반적인 "깊이 부족"보다 강한 기술 실패다.
        // 기본 피하기도 첫 회복이 실패하면 상위 모델로 한 번 승격해, 원문 그대로
        // 전달·과금되는 경우를 최대한 줄인다.
        const escalation = attempt > 0 && (requestStrength === 'advanced' || wasEquivalent || severeNoEffect);
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
        let retryOutput = retried.outputText;
        const retryValidation = auditGeneralSurfaceCandidateWithStructure({
          source: auditSource,
          current: outputText,
          candidate: retryOutput,
          contract,
          documentProfile,
          mode: selectedMode,
          chunks: frozen ? frozen.auditChunks : chunks,
          plan: chunkPlan,
          boundaryRepair,
          humanizationPlan
        });
        retryOutput = retryValidation.candidate || retryOutput;
        const retryDepth = humanizationDepthEnabled
          ? humanizationDepth.evaluateHumanizationDepth(auditSource, retryOutput, humanizationPlan)
          : { pass: true };
        const safeRetryCandidate = retryValidation.pass === true;
        // 고급은 mini가 조금만 개선한 후보를 냈다고 멈추지 않는다. 안전한 개선은
        // 중간 후보로 유지하되 최소선에 못 미치면 상위 모델이 남은 문장·문단만 한 번
        // 더 회복한다. 결과를 막거나 무차감하는 대신 실제 체감 강도를 만드는 경로다.
        const retryWorthUsing = humanizationDepthEnabled
          ? humanizationDepth.isBetterHumanizationCandidate(humanizationDepthReport, retryDepth)
          : retryDepth.pass === true;
        if (safeRetryCandidate && retryWorthUsing) {
          outputText = retryOutput;
          generalSurfaceRetryCount += 1;
          humanizationDepthRetryApplied = true;
          humanizationDepthReport = retryDepth;
          acceptGeneralSurfaceRecovery(records);
          if (startedWithSevereNoEffect && humanizationDepthReport?.minimumEffectPass === true) {
            finalNoopRecoveryCount = 1;
            finalNoopRecovery = { attempted: true, applied: true, method: 'model', reason: 'substantive_humanization' };
          }
        } else if (humanizationDepthEnabled) {
          const partial = safeEditAccumulator.accumulateSafeEdits({
            source: auditSource,
            current: outputText,
            candidate: retryOutput,
            plan: humanizationPlan,
            currentReport: humanizationDepthReport,
            evaluateDepth: value => humanizationDepth.evaluateHumanizationDepth(
              auditSource,
              value,
              humanizationPlan
            ),
            validateCandidate: trial => auditGeneralSurfaceCandidateWithStructure({
              source: auditSource,
              current: outputText,
              candidate: trial,
              contract,
              documentProfile,
              mode: selectedMode,
              chunks: frozen ? frozen.auditChunks : chunks,
              plan: chunkPlan,
              boundaryRepair,
              humanizationPlan
            })
          });
          safePartialSentenceRejectedCount += Number(partial.rejectedCount || 0);
          for (const code of partial.rejectedCodes || []) addUniqueCode(safePartialRejectionCodes, code);
          if (partial.applied) {
            outputText = partial.outputText;
            humanizationDepthReport = partial.report;
            generalSurfaceRetryCount += 1;
            humanizationDepthRetryApplied = true;
            safePartialCandidateAppliedCount += 1;
            safePartialSentenceAppliedCount += Number(partial.appliedCount || 0);
            acceptGeneralSurfaceRecovery(records);
            if (startedWithSevereNoEffect && humanizationDepthReport?.minimumEffectPass === true) {
              finalNoopRecoveryCount = 1;
              finalNoopRecovery = {
                attempted: true,
                applied: true,
                method: 'safe_sentence_accumulator',
                reason: 'substantive_humanization'
              };
            }
            continue;
          }
          humanizationDepthRetryRejectedCount += 1;
          if (!retried.safeChangeFound || !retryOutput || normalizeBare(outputText) === normalizeBare(retryOutput)) {
            addUniqueCode(humanizationDepthRetryRejectionCodes, 'candidate_unchanged');
          }
          if (!safeRetryCandidate) {
            addUniqueCode(humanizationDepthRetryRejectionCodes, 'safety_audit_failed');
            for (const code of retryValidation.codes || []) addUniqueCode(humanizationDepthRetryRejectionCodes, code);
          }
          if (safeRetryCandidate && !retryWorthUsing) {
            addUniqueCode(humanizationDepthRetryRejectionCodes, 'depth_not_improved');
          }
          humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(auditSource, outputText, humanizationPlan);
        }
      } catch (error) {
        lastRetryError = error;
        const failureCode = modelCallFailureCode(error);
        humanizationDepthRetryRejectedCount += 1;
        addUniqueCode(humanizationDepthRetryRejectionCodes, failureCode);
        // 클라이언트가 오류별 허용 재시도를 이미 소진했다. 전송·refusal·
        // schema 실패를 "mini 품질 부족"으로 오인해 상위 모델로 승격하지 않는다.
        break;
      }
    }
    if (startedWithSevereNoEffect && finalNoopRecovery.applied !== true) {
      finalNoopRecovery = {
        attempted: true,
        applied: false,
        method: 'model',
        reason: lastRetryError
          ? modelCallFailureCode(lastRetryError)
          : 'no_substantive_change'
      };
    }
  }
  recordHumanizationDepthStage('post_depth_recovery', humanizationDepthReport);

  if (!polishStrictFailure) {
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

  if (!polishStrictFailure) {
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
    if (koreanRefinementAudit?.pass === false) {
      const restored = koreanRefinement.restoreIntroducedIntegritySentences({
        source: auditSource,
        outputText,
        audit: koreanRefinementAudit
      });
      if (restored.applied) {
        const candidate = restored.text;
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
          candidateDepth,
          maxLocalEditRatio: 0.4,
          minLocalLengthRatio: 0.78,
          maxLocalLengthRatio: 1.22,
          allowDepthRegression: true
        }) && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
        if (safeCandidate && koreanRefinement.isImprovedAudit(koreanRefinementAudit, candidateAudit)) {
          outputText = candidate;
          koreanRefinementAudit = candidateAudit;
          koreanSourceRestoreCount += restored.restoredSentenceCount || 1;
          if (candidateDepth) humanizationDepthReport = candidateDepth;
        }
      }
    }
  }

  if (!polishStrictFailure && selectedMode !== 'polish' && fingerprint.isEnabled()) {
    fingerprintAudit = fingerprint.auditFingerprint(auditSource, outputText, documentProfile);
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
        const candidateFingerprint = fingerprint.auditFingerprint(auditSource, candidate, documentProfile);
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
      if (fingerprintAudit?.pass === false) {
        const restored = fingerprint.restoreUnsafeRelationSentences(auditSource, outputText, fingerprintAudit);
        if (restored.applied) {
          const candidate = restored.text;
          const candidateFingerprint = fingerprint.auditFingerprint(auditSource, candidate, documentProfile);
          const candidateDepth = humanizationDepthEnabled
            ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
            : null;
          const safeCandidate = fingerprint.isImproved(fingerprintAudit, candidateFingerprint)
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
              maxLocalEditRatio: 0.4,
              minLocalLengthRatio: 0.78,
              maxLocalLengthRatio: 1.22,
              allowDepthRegression: true
            })
            && preservesFinalStructure(auditSource, candidate, frozen ? frozen.auditChunks : chunks, chunkPlan, boundaryRepair);
          if (safeCandidate) {
            outputText = candidate;
            fingerprintAudit = candidateFingerprint;
            fingerprintSourceRestoreCount += restored.restoredSentenceCount || 1;
            if (candidateDepth) humanizationDepthReport = candidateDepth;
          }
        }
      }
    }
  }

  if (!polishStrictFailure) {
    endingStyleAudit = endingStyle.auditEndingStyle(auditSource, outputText, documentProfile);
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
        const candidateEndingAudit = endingStyle.auditEndingStyle(auditSource, candidate, documentProfile);
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
      // 모델 수리가 거절되거나 여전히 혼용이 남아도 문서 전체를 경고
      // 상태로 보내지 않는다. 새 종결체가 생긴 문제 문장만 원문 대응
      // 문장으로 되돌리고, 구조·깊이·사실 검사를 다시 통과한 경우에만 쓴다.
      if (endingStyleAudit?.pass === false) {
        const restored = endingStyle.restoreIntroducedEndingSentences(
          auditSource,
          outputText,
          endingStyleAudit,
          documentProfile
        );
        if (restored.applied) {
          const candidate = restored.text;
          const candidateEndingAudit = restored.audit
            || endingStyle.auditEndingStyle(auditSource, candidate, documentProfile);
          const candidateDepth = humanizationDepthEnabled && selectedMode !== 'polish'
            ? humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, humanizationPlan)
            : null;
          const safeCandidate = endingStyle.isImproved(endingStyleAudit, candidateEndingAudit)
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
              allowDepthRegression: true
            })
            && preservesFinalStructure(
              auditSource,
              candidate,
              frozen ? frozen.auditChunks : chunks,
              chunkPlan,
              boundaryRepair
            );
          if (safeCandidate) {
            outputText = candidate;
            endingStyleAudit = candidateEndingAudit;
            endingStyleSourceRestoreCount = restored.restoredSentenceCount || 1;
            endingStyleRepairCount += endingStyleSourceRestoreCount;
            endingStyleRetryApplied = true;
            if (candidateDepth) humanizationDepthReport = candidateDepth;
          }
        }
      }
    }
  }

  if (!polishStrictFailure) {
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

  if (!polishStrictFailure) {
    experienceCandidateAudit = experienceAudit.detectExperienceCandidate(
      auditSource,
      outputText,
      allowedExtra
    );
  }

  if (humanizationDepthEnabled && selectedMode !== 'polish') {
    humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(
      auditSource,
      outputText,
      humanizationPlan
    );
    recordHumanizationDepthStage('pre_semantic', humanizationDepthReport);
  }
  let preSemanticStructureAudit = structureChunk.buildStructureAudit({
    source: auditSource,
    outputText,
    chunks: frozen ? frozen.auditChunks : chunks,
    plan: chunkPlan,
    boundaryRepair
  });
  const auditVoiceProfile = buildVoiceProfile(auditSource, { documentProfile, mode: selectedMode });
  let deterministicAudit = qualityV2.buildDeterministicAudit({
    source: auditSource,
    outputText,
    mode: selectedMode,
    contract,
    voiceProfile: auditVoiceProfile,
    documentProfile,
    structureAudit: preSemanticStructureAudit,
    protectedTerms: collectRecordProtectedTerms(records),
    allowedExtra
  });
  let semanticReport = { ran: false, pass: true, repairCount: 0, sectionCount: 0 };
  if (!polishStrictFailure) {
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
        allowedExtra,
        mode: selectedMode,
        discourseSignals: [
          ...(deterministicAudit?.discourseAudit?.codes || []),
          ...(fingerprintAudit?.issueCodes || []),
          ...((fingerprintAudit?.semanticRelations?.shifts || [])
            .map(item => `semantic_relation_shift:${item.family}`)),
          ...(experienceCandidateAudit?.candidate ? ['experience_novelty_candidate'] : [])
        ],
        safetyIdentifier: safetyId,
        documentProfile
      });
      supplementalUsage = addUsage(supplementalUsage, semanticReport.usage);
      const semanticOutput = semanticReport.outputText || outputText;
      const restoredOmissions = omissionRestore.restoreConfirmedSemanticOmissions({
        source: auditSource,
        outputText: semanticOutput,
        semanticReport
      });
      if (restoredOmissions.applied) {
        const beforeRestoreStructure = structureChunk.buildStructureAudit({
          source: auditSource,
          outputText: semanticOutput,
          chunks: frozen ? frozen.auditChunks : chunks,
          plan: chunkPlan,
          boundaryRepair
        });
        const restoredStructure = structureChunk.buildStructureAudit({
          source: auditSource,
          outputText: restoredOmissions.text,
          chunks: frozen ? frozen.auditChunks : chunks,
          plan: chunkPlan,
          boundaryRepair
        });
        const restoreIntegrity = candidateIntegrity.auditCandidateIntegrity({
          source: auditSource,
          before: semanticOutput,
          candidate: restoredOmissions.text,
          documentProfile,
          mode: selectedMode
        });
        const beforeNumberRisk = numberAuditRisk(compareNumberMultiset(auditSource, semanticOutput, allowedExtra));
        const restoredNumberRisk = numberAuditRisk(compareNumberMultiset(
          auditSource,
          restoredOmissions.text,
          allowedExtra
        ));
        const structureSafe = structureAuditNotWorse(beforeRestoreStructure, restoredStructure);
        if (restoreIntegrity.pass === true && structureSafe && restoredNumberRisk <= beforeNumberRisk) {
          outputText = restoredOmissions.text;
          deterministicOmissionRestoreCount += restoredOmissions.restoredCount;
          semanticReport = reconcileSemanticOmissionRestores(semanticReport, restoredOmissions);
        } else {
          outputText = semanticOutput;
          deterministicOmissionRestoreRejectedCount += restoredOmissions.restoredCount;
          for (const code of restoreIntegrity.reasons || []) {
            addUniqueCode(deterministicOmissionRestoreRejectionCodes, code);
          }
          if (!structureSafe) {
            addUniqueCode(deterministicOmissionRestoreRejectionCodes, 'structure_integrity_worsened');
          }
          if (restoredNumberRisk > beforeNumberRisk) {
            addUniqueCode(deterministicOmissionRestoreRejectionCodes, 'number_facts_worsened');
          }
        }
      } else {
        outputText = semanticOutput;
      }
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
        allowedExtra
      });
    }
  }

  let postSemanticDepthRegression = false;
  if (humanizationDepthEnabled && selectedMode !== 'polish') {
    const beforeSemanticBest = bestDepthStageSnapshot(humanizationDepthStages);
    humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(
      auditSource,
      outputText,
      humanizationPlan
    );
    const postSemanticSnapshot = buildDepthStageSnapshot('post_semantic', humanizationDepthReport);
    postSemanticDepthRegression = isMaterialDepthRegression(beforeSemanticBest, postSemanticSnapshot);
    humanizationDepthStages.push(postSemanticSnapshot);
  }

  // 의미 수리가 추가 주장 등을 제거하는 과정에서 결과 전체가 원문으로 돌아갈
  // 수 있다. 앞 단계에서 무변환이 아니었다면 기존 회복 루프가 이를 볼 수 없으므로,
  // 최종 레이아웃 전에 한 번 더 재작성하고 의미 심사까지 다시 통과한 후보만 쓴다.
  if (selectedMode !== 'polish'
      && (postSemanticDepthRegression
        || (finalNoopRecovery.attempted !== true
          && (normalizeBare(auditSource) === normalizeBare(outputText)
            || isSevereHumanizationNoEffect(humanizationDepth.evaluateHumanizationDepth(
              auditSource,
              outputText,
              humanizationPlan || humanizationDepth.buildHumanizationPlan(auditSource, {
                requestStrength,
                documentProfile,
                inputRisk
              })
            )))))) {
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
        let candidate = String(retried.outputText || '').trim();
        let candidateValidation = auditGeneralSurfaceCandidateWithStructure({
          source: auditSource,
          current: outputText,
          candidate,
          contract,
          documentProfile,
          mode: selectedMode,
          chunks: frozen ? frozen.auditChunks : chunks,
          plan: chunkPlan,
          boundaryRepair,
          humanizationPlan: postNoopPlan
        });
        candidate = candidateValidation.candidate || candidate;
        let candidateDepth = humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, postNoopPlan);
        let safeCandidate = candidateValidation.pass === true;
        let candidateImprovesRegression = !postSemanticDepthRegression
          || humanizationDepth.isBetterHumanizationCandidate(postNoopDepthReport, candidateDepth);
        let partialAppliedSentenceCount = 0;
        if (!safeCandidate || !candidateImprovesRegression) {
          const partial = safeEditAccumulator.accumulateSafeEdits({
            source: auditSource,
            current: outputText,
            candidate,
            plan: postNoopPlan,
            currentReport: postNoopDepthReport,
            evaluateDepth: value => humanizationDepth.evaluateHumanizationDepth(
              auditSource,
              value,
              postNoopPlan
            ),
            validateCandidate: trial => auditGeneralSurfaceCandidateWithStructure({
              source: auditSource,
              current: outputText,
              candidate: trial,
              contract,
              documentProfile,
              mode: selectedMode,
              chunks: frozen ? frozen.auditChunks : chunks,
              plan: chunkPlan,
              boundaryRepair,
              humanizationPlan: postNoopPlan
            })
          });
          safePartialSentenceRejectedCount += Number(partial.rejectedCount || 0);
          for (const code of partial.rejectedCodes || []) addUniqueCode(safePartialRejectionCodes, code);
          if (partial.applied) {
            candidate = partial.outputText;
            candidateDepth = partial.report;
            candidateValidation = auditGeneralSurfaceCandidateWithStructure({
              source: auditSource,
              current: outputText,
              candidate,
              contract,
              documentProfile,
              mode: selectedMode,
              chunks: frozen ? frozen.auditChunks : chunks,
              plan: chunkPlan,
              boundaryRepair,
              humanizationPlan: postNoopPlan
            });
            candidate = candidateValidation.candidate || candidate;
            candidateDepth = humanizationDepth.evaluateHumanizationDepth(auditSource, candidate, postNoopPlan);
            safeCandidate = candidateValidation.pass === true;
            candidateImprovesRegression = !postSemanticDepthRegression
              || humanizationDepth.isBetterHumanizationCandidate(postNoopDepthReport, candidateDepth);
            if (safeCandidate && candidateImprovesRegression) {
              partialAppliedSentenceCount = Number(partial.appliedCount || 0);
            }
          }
        }
        if (!safeCandidate || candidateDepth.minimumEffectPass !== true || !candidateImprovesRegression) {
          lastRecoveryReason = !candidate || normalizeBare(candidate) === normalizeBare(auditSource)
            ? 'candidate_unchanged'
            : (!safeCandidate
                ? 'safety_audit_failed'
                : (!candidateImprovesRegression ? 'depth_not_improved' : 'minimum_effect_failed'));
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
          allowedExtra,
          mode: selectedMode,
          discourseSignals: ['post_semantic_noop_recovery'],
          safetyIdentifier: safetyId,
          documentProfile
        });
        supplementalUsage = addUsage(supplementalUsage, candidateSemantic.usage);
        let auditedCandidate = String(candidateSemantic.outputText || candidate).trim();
        const auditedCandidateValidation = auditGeneralSurfaceCandidateWithStructure({
          source: auditSource,
          current: outputText,
          candidate: auditedCandidate,
          contract,
          documentProfile,
          mode: selectedMode,
          chunks: frozen ? frozen.auditChunks : chunks,
          plan: chunkPlan,
          boundaryRepair,
          humanizationPlan: postNoopPlan
        });
        auditedCandidate = auditedCandidateValidation.candidate || auditedCandidate;
        const auditedDepth = humanizationDepth.evaluateHumanizationDepth(auditSource, auditedCandidate, postNoopPlan);
        const safeAuditedCandidate = candidateSemantic.pass === true
          && auditedDepth.minimumEffectPass === true
          && (!postSemanticDepthRegression
            || humanizationDepth.isBetterHumanizationCandidate(postNoopDepthReport, auditedDepth))
          && auditedCandidateValidation.pass === true;
        if (!safeAuditedCandidate) {
          lastRecoveryReason = candidateSemantic.pass === true ? 'post_semantic_safety_failed' : 'semantic_audit_failed';
          humanizationDepthRetryRejectedCount += 1;
          addUniqueCode(humanizationDepthRetryRejectionCodes, lastRecoveryReason);
          continue;
        }
        outputText = auditedCandidate;
        if (partialAppliedSentenceCount > 0) {
          safePartialCandidateAppliedCount += 1;
          safePartialSentenceAppliedCount += partialAppliedSentenceCount;
        }
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
          allowedExtra
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
        const failureCode = modelCallFailureCode(error);
        lastRecoveryReason = failureCode;
        humanizationDepthRetryRejectedCount += 1;
        addUniqueCode(humanizationDepthRetryRejectionCodes, failureCode);
        break;
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
  if (humanizationDepthEnabled && selectedMode !== 'polish') {
    humanizationDepthReport = humanizationDepth.evaluateHumanizationDepth(
      auditSource,
      outputText,
      humanizationPlan
    );
    recordHumanizationDepthStage('post_semantic_recovery', humanizationDepthReport);
  }

  const postLayout = layoutNlpEnabled
    ? await safeFormatLayout(outputText, { mode: selectedMode, phase: 'post' })
    : null;
  if (postLayout?.text) outputText = postLayout.text;
  if (frozen) outputText = restoreLockedBlocks(outputText, frozen.blocks);
  if (inlineCodeFreeze.count > 0) {
    inlineCodeIntegrity = literalSpans.restoreInlineCode(outputText, inlineCodeFreeze);
    outputText = inlineCodeIntegrity.text;
  }
  const layoutRepair = structureChunk.restorePostSemanticLayout({
    source: rawSource,
    outputText,
    chunks,
    mode: selectedMode,
    requestStrength,
    documentProfile,
    profileConfidence: documentProfile.confidence
  });
  outputText = layoutRepair.text || outputText;
  // 직접 인용은 의미 심사 이후의 일반 어휘 후처리가 아니라 동결 구조다.
  // 의미 수리나 레이아웃 복원에서 내부 내용이 달라졌다면 같은 위치의
  // 원문 인용만 재조립한다.
  {
    const restored = restoreDirectQuoteContents(rawSource, outputText);
    if (restored.applied) {
      outputText = restored.text;
      quoteIntegrityRestoreCount += restored.restoredCount || 1;
      finalQuoteIntegrityRestoreCount = restored.restoredCount || 1;
    }
    quoteIntegrityAudit = auditDirectQuoteIntegrity(rawSource, outputText);
  }
  // 의미 수리·레이아웃 복원도 드물게 새 연어·논항·시제 오류를 만들 수 있다.
  // 최종 단계에서는 자유 재작성을 다시 호출하지 않고, 원문에 없던 것으로
  // 확인된 문제 문장만 같은 위치의 원문 문장으로 되돌린다. 이 후보 역시
  // 공통 비퇴행 감사와 전체 구조 검사를 통과해야 한다.
  {
    const finalKoreanBefore = koreanRefinement.analyzeKoreanRefinement({
      source: rawSource,
      outputText,
      documentProfile,
      mode: selectedMode
    });
    const restored = koreanRefinement.restoreIntroducedIntegritySentences({
      source: rawSource,
      outputText,
      audit: finalKoreanBefore
    });
    if (restored.applied) {
      const candidate = restored.text;
      const candidateKorean = koreanRefinement.analyzeKoreanRefinement({
        source: rawSource,
        outputText: candidate,
        documentProfile,
        mode: selectedMode
      });
      const candidateDepth = humanizationDepthEnabled && selectedMode !== 'polish'
        ? humanizationDepth.evaluateHumanizationDepth(rawSource, candidate, humanizationPlan)
        : null;
      const safeCandidate = koreanRefinement.isImprovedAudit(finalKoreanBefore, candidateKorean)
        && isSafeLocalizedLanguageCandidate({
          source: rawSource,
          before: outputText,
          candidate,
          contract,
          documentProfile,
          mode: selectedMode,
          protectedTerms: extractProtectedTerms(rawSource, documentProfile),
          currentDepth: humanizationDepthReport,
          candidateDepth,
          maxLocalEditRatio: 0.4,
          minLocalLengthRatio: 0.78,
          maxLocalLengthRatio: 1.22,
          allowDepthRegression: true
        })
        && preservesFinalStructure(rawSource, candidate, chunks, chunkPlan, boundaryRepair);
      if (safeCandidate) {
        outputText = candidate;
        koreanRefinementAudit = candidateKorean;
        const restoredCount = restored.restoredSentenceCount || 1;
        koreanSourceRestoreCount += restoredCount;
        finalKoreanSourceRestoreCount += restoredCount;
        finalSourceIntegrityRestoreCount += restoredCount;
        addUniqueCode(finalSourceIntegrityRestoreCodes, 'korean_source_restore');
        for (const code of restored.restoredCodes || []) {
          addUniqueCode(finalKoreanSourceRestoreCodes, code);
        }
        if (candidateDepth) humanizationDepthReport = candidateDepth;
      }
    }
  }
  // 의미 판정기의 수리도 드물게 엔진 상투구를 새로 만들 수 있다. 의미 감사
  // 뒤에는 모델을 다시 부르거나 자유 어휘 수리를 하지 않고, 원문 대응이
  // 확실한 문제 문장만 그대로 복원한다. 원문 복원 후보도 공통 비퇴행·구조
  // 감사를 다시 통과해야 하므로 다른 문장의 휴머나이징은 유지된다.
  if (selectedMode !== 'polish' && fingerprint.isEnabled()) {
    const finalFingerprintBefore = fingerprint.auditFingerprint(rawSource, outputText, documentProfile);
    if (finalFingerprintBefore.pass === false) {
      const restored = fingerprint.restoreUnsafeRelationSentences(
        rawSource,
        outputText,
        finalFingerprintBefore
      );
      if (restored.applied) {
        const candidate = restored.text;
        const candidateFingerprint = fingerprint.auditFingerprint(rawSource, candidate, documentProfile);
        const candidateDepth = humanizationDepthEnabled
          ? humanizationDepth.evaluateHumanizationDepth(rawSource, candidate, humanizationPlan)
          : null;
        const safeCandidate = fingerprint.isImproved(finalFingerprintBefore, candidateFingerprint)
          && isSafeLocalizedLanguageCandidate({
            source: rawSource,
            before: outputText,
            candidate,
            contract,
            documentProfile,
            mode: selectedMode,
            protectedTerms: extractProtectedTerms(rawSource, documentProfile),
            currentDepth: humanizationDepthReport,
            candidateDepth,
            maxLocalEditRatio: 0.4,
            minLocalLengthRatio: 0.78,
            maxLocalLengthRatio: 1.22,
            allowDepthRegression: true
          })
          && preservesFinalStructure(rawSource, candidate, chunks, chunkPlan, boundaryRepair);
        if (safeCandidate) {
          outputText = candidate;
          fingerprintAudit = candidateFingerprint;
          fingerprintSourceRestoreCount += restored.restoredSentenceCount || 1;
          finalSourceIntegrityRestoreCount += restored.restoredSentenceCount || 1;
          finalSourceIntegrityRestoreCodes.push('fingerprint_source_restore');
          if (candidateDepth) humanizationDepthReport = candidateDepth;
        }
      }
    }
  }
  let polishSpeakerRestore = { applied: false, restoredSentenceCount: 0, restoredKinds: [], reason: 'not_applicable' };
  if (selectedMode === 'polish') {
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

  // 의미 감사 뒤의 결정론적 문장 복원이 라벨·불릿·조문 접두부 앞의
  // 줄바꿈을 공백으로 바꿀 수 있다. 최종 공백 보정 전에 잠긴 구조의
  // 원래 행 위치만 다시 세우며, 이 단계에서는 어휘를 바꾸지 않는다.
  {
    const finalLockedStructure = structureChunk.restoreLockedStructureLayout({
      source: rawSource,
      outputText,
      chunks
    });
    if (finalLockedStructure.applied) outputText = finalLockedStructure.text;
    layoutRepair.finalLockedStructure = {
      applied: finalLockedStructure.applied === true,
      restoredCount: Number(finalLockedStructure.restoredCount || 0),
      missingCount: Number(finalLockedStructure.missingCount || 0),
      pass: finalLockedStructure.pass !== false
    };
  }

  // 의미 심사·동결 블록 재조립·문단 복원이 끝난 뒤에 공백만 바꾼다.
  // 원문에 이미 있던 문장 중간 잘못된 줄바꿈도 이 단계에서 합친다.
  // 논문명·인용·참고문헌·표·창작문 행갈이는 koreanRefinement 내부에서 보호한다.
  {
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
  if (humanizationDepthEnabled && selectedMode !== 'polish') {
    const postLayoutDepthFrozen = freezeLockedBlocks(rawSource, outputText, chunks);
    const postLayoutDepthSource = postLayoutDepthFrozen?.source || rawSource;
    const postLayoutDepthOutput = postLayoutDepthFrozen?.output || outputText;
    const postLayoutDepth = humanizationDepth.evaluateHumanizationDepth(
      postLayoutDepthSource,
      postLayoutDepthOutput,
      humanizationPlan
    );
    humanizationDepthStages.push(buildDepthStageSnapshot('post_layout_restore', postLayoutDepth));
    humanizationDepthReport = postLayoutDepth;
  }

  // 의미 감사 이후에는 어휘를 다시 바꾸지 않는다. 수리·동결 블록 재조립·레이아웃
  // 복원으로 실질 변화가 사라지면 아래 최종 깊이 감사가 검토 필요 상태를 기록한다.
  if (selectedMode === 'polish') {
    polishReport = qualityV2.polishEditPolicy(rawSource, outputText, { documentProfile });
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
    humanizationDepthStages.push(buildDepthStageSnapshot('final', humanizationDepthReport));
  }
  if (selectedMode !== 'polish' && fingerprint.isEnabled()) {
    fingerprintAudit = fingerprint.auditFingerprint(rawSource, outputText, documentProfile);
  }
  endingStyleAudit = endingStyle.auditEndingStyle(rawSource, outputText, documentProfile);
  resumeCoverageAudit = resumeCoverage.auditResumeCoverage(rawSource, outputText, documentProfile);
  quoteIntegrityAudit = auditDirectQuoteIntegrity(rawSource, outputText);
  {
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
  const deliveryAudit = qualityV2.buildDeterministicAudit({
    source: rawSource,
    outputText,
    mode: selectedMode,
    contract,
    voiceProfile,
    documentProfile,
    structureAudit,
    protectedTerms: extractProtectedTerms(rawSource, documentProfile),
    allowedExtra
  });
  const result = buildResult({
    source: rawSource,
    outputText,
    contract,
    mode: selectedMode,
    records,
    inputRisk,
    allowedExtra,
    niklQualityTest: niklQualityEnabled,
    structureAudit
  });
  calibrateV2RepetitionReport(result, rawSource, outputText);
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
    allowedExtra
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
          : '보존을 우선해 권장 휴머나이징 목표 강도보다 약하게 나왔습니다.',
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
  const finalEquivalent = isNoopEquivalent(rawSource, outputText, selectedMode);
  const approvedModelChunkCount = countApprovedModelChunks(records, chunks, {
    mode: selectedMode,
    documentRecoveryApplied: finalNoopRecovery.applied === true
      || generalSurfaceRetryCount > 0
      || (polishRetryCount > 0 && !polishStrictFailure)
  });
  const modelFailureChunkCount = records.filter(record => isModelFailureRecord(record)).length;
  if (finalEquivalent || approvedModelChunkCount === 0) {
    result.floorReport = result.floorReport || { status: 'blocked', criticals: [], warnings: [] };
    result.floorReport.status = 'blocked';
    result.floorReport.criticals = result.floorReport.criticals || [];
    result.floorReport.criticals.push({
      gate: finalEquivalent ? 'gpt_noop_unchanged' : 'no_approved_model_chunks',
      detail: finalEquivalent
        ? 'GPT output is equivalent to source.'
        : 'No model-authored edit passed the required audits.'
    });
  }
  const delivery = deliveryPolicy.applyDeliveryPolicy(result.floorReport, { mode: selectedMode });
  result.floorReport = delivery.report;

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
  const retryCounts = summarizeRetryCounts(records);
  const humanizationNoBenefitDelivered = selectedMode !== 'polish'
    && result.floorReport?.status !== 'blocked'
    && humanizationDepthReport?.applicable === true
    && humanizationDepthReport?.pass === false;
  const semanticQualityWarnings = qualityV2.warningsFromSemantic(semanticReport);
  const deterministicEffectNotices = [
    ...(deliveryAudit?.warnings || []),
    ...semanticQualityWarnings
  ]
    .filter(item => isEffectObservationCode(item?.code))
    .map(toEffectNotice);
  if (records.some(record => (record.warnings || []).includes('v2_residual:voice_existing_distribution_failed'))) {
    deterministicEffectNotices.push(toEffectNotice({
      code: 'sentence_distribution_shift',
      message: '원문의 장단문 분포가 결과에서 다소 평탄해졌을 수 있어요.'
    }));
  }
  if (polishReport?.needsIssueRecovery) {
    deterministicEffectNotices.push(toEffectNotice({
      code: 'polish_source_issue_remaining',
      message: '원문에서 확인된 일부 교정 항목은 안전 범위 안에서 모두 고치기 어려웠어요.'
    }));
  }
  const effectNotices = dedupeQualityWarnings([
    ...(humanizationNoBenefitDelivered ? depthEffectNotices(humanizationDepthReport) : []),
    ...deterministicEffectNotices
  ]);
  const effectStatus = effectNotices.length ? 'limited' : 'normal';
  const qualityWarnings = dedupeQualityWarnings([
        ...(deliveryAudit?.warnings || []).filter(item => !isEffectObservationCode(item?.code)),
        ...semanticQualityWarnings.filter(item => !isEffectObservationCode(item?.code)),
        ...(experienceCandidateAudit?.candidate && semanticReport?.uncertain
          ? [{ code: 'experience_novelty', severity: 'warning', message: '새 개인 경험으로 보이는 변화의 의미 심사가 불확실해 원문 대조가 필요해요.' }]
          : []),
        ...(records.some(record => (record.warnings || []).includes('v2_residual:structure_boundary_marker_failed'))
          ? [{ code: 'unsafe_chunk_boundary', severity: 'warning', message: '원문의 문장 경계 일부가 결과에서 달라졌을 수 있어요.' }]
          : []),
        ...(polishReport?.excessiveChange ? [{ code: 'polish_edit_range', severity: 'warning', message: '보존형 윤문의 권장 편집 범위를 넘었을 수 있어요.' }] : []),
        ...(structureAudit?.lostLockedCount > 0 ? [{ code: 'structure_lock_loss', severity: 'warning', message: '동결 구조 일부가 달라졌을 수 있어요.' }] : []),
        ...(inlineCodeIntegrity.pass === false
          ? [{ code: 'inline_code_changed', severity: 'warning', message: '인라인 코드 일부를 원문 그대로 복원하지 못했을 수 있어요.' }]
          : []),
        ...(fingerprintAudit?.issueCodes?.includes('engine_phrase_fingerprint')
          ? [{ code: 'engine_phrase_fingerprint', severity: 'warning', message: '엔진이 만든 상투 표현이 한 문서에서 반복됐을 수 있어요.' }]
          : []),
        ...(fingerprintAudit?.issueCodes?.includes('contrast_relation_shift')
          ? [{ code: 'contrast_relation_shift', severity: 'warning', message: '부정·배제 관계가 인정·가산 관계로 달라졌을 수 있어 원문 대조가 필요해요.' }]
          : []),
        ...(fingerprintAudit?.issueCodes?.includes('semantic_relation_shift')
          ? [{ code: 'semantic_relation_shift', severity: 'warning', message: '목적·근거·대조·가능성·행위 방향 또는 책임 범위가 원문과 달라졌을 수 있어요.' }]
          : []),
        ...(endingStyleAudit?.pass === false
          ? [{ code: 'ending_style_mixed', severity: 'warning', message: '원문에 없던 종결체가 일부 섹션에 섞였을 수 있어요.' }]
          : []),
        ...(resumeCoverageAudit?.applicable && resumeCoverageAudit?.pass === false
          ? [{ code: 'resume_claim_omission', severity: 'warning', message: '자기소개서의 행동·역량·성과·직무 연결 내용 일부가 누락됐을 수 있어요.' }]
          : []),
        ...(koreanRefinementAudit?.residualWarnings || [])
      ]);
  const strictBlocked = result.floorReport?.status === 'blocked';
  const qualityStatus = qualityWarnings.length || result.floorReport?.status === 'needs_review' ? 'needs_review' : 'clean';
  if (!strictBlocked && qualityStatus === 'needs_review' && result.floorReport?.status === 'clean') result.floorReport.status = 'needs_review';
  const finalDelivery = deliveryPolicy.reconcileFinalDelivery({
    blocked: strictBlocked,
    baseReasonCodes: delivery.reasonCodes,
    qualityWarnings
  });
  const finalDeliveryReasonCodes = safeFailureCodeList(finalDelivery.reasonCodes);
  const finalDeliveryDecision = finalDelivery.decision;
  result.qualityStatus = qualityStatus;
  result.qualityWarnings = qualityWarnings;
  result.effectStatus = effectStatus;
  result.effectNotices = effectNotices;
  // 구형 클라이언트 호환 필드일 뿐 전달·과금·후보 선택에는 사용하지 않는다.
  result.weakTransform = effectStatus === 'limited';
  result.noOpScore = humanizationDepthReport?.applicable
    ? Number(Math.max(0, 1 - Number(humanizationDepthReport.metrics?.substantiveEditRatio || 0)).toFixed(4))
    : null;
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
  const bestHumanizationDepthStage = bestDepthStageSnapshot(humanizationDepthStages);
  const finalHumanizationDepthStage = humanizationDepthStages[humanizationDepthStages.length - 1] || null;
  const finalHumanizationDepthRegression = depthStageRegression(
    bestHumanizationDepthStage,
    finalHumanizationDepthStage
  );
  result.engineMeta = {
    schemaVersion: 3,
    engineVersion: VERSION,
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
    candidateGroups: documentProfile.candidateGroups || [],
    profileGroup: documentProfile.group || 'unknown',
    safetyProfiles: documentProfile.safetyProfiles || [],
    profileMargin: documentProfile.profileMargin ?? 0,
    profileGroupMargin: documentProfile.profileGroupMargin ?? 0,
    formatProfile: documentProfile.formatProfile || { length: 'standard', primary: 'plain', flags: [] },
    lineBoundaryPolicy,
    paragraphRepairPolicy: layoutRepair?.paragraphs?.policy || 'none',
    paragraphRepairSourceCount: Number(layoutRepair?.paragraphs?.sourceCount || 0),
    paragraphRepairBeforeCount: Number(layoutRepair?.paragraphs?.beforeCount || 0),
    paragraphRepairTargetCount: Number(layoutRepair?.paragraphs?.targetCount || 0),
    paragraphRepairAfterCount: Number(layoutRepair?.paragraphs?.afterCount || 0),
    paragraphRoleBoundaryCount: Number(layoutRepair?.paragraphs?.roleBoundaryCount || 0),
    paragraphSourceBoundaryRepairCount: Number(layoutRepair?.paragraphs?.sourceBoundaryRepairCount || 0),
    paragraphBackwardConclusionRepairCount: Number(layoutRepair?.paragraphs?.backwardConclusionRepairCount || 0),
    paragraphAlignmentConfidence: Number(layoutRepair?.paragraphs?.paragraphAlignmentConfidence || 0),
    paragraphProseSplitCount: Number(layoutRepair?.paragraphs?.proseSplitCount || 0),
    paragraphVisualGapRepairCount: Number(layoutRepair?.paragraphs?.visualGapRepairCount || 0),
    explicitParagraphCountBefore: Number(layoutRepair?.paragraphs?.explicitParagraphCountBefore || 0),
    explicitParagraphCountAfter: Number(layoutRepair?.paragraphs?.explicitParagraphCountAfter || 0),
    paragraphReadability: layoutRepair?.paragraphs?.readability || null,
    riskFlags: documentProfile.riskFlags || [],
    tonePolicy: documentProfile.tonePolicy || 'source_preserve',
    targetRegister: documentProfile.targetRegister || documentProfile.tonePolicy || 'source_preserve',
    targetRegisterSource: documentProfile.targetRegisterSource || 'legacy',
    targetRegisterStrength: documentProfile.targetRegisterStrength || requestStrength,
    basicStyle: documentProfile.basicStyle || String(basicStyle || ''),
    semanticJudgeRan: semanticReport.ran === true,
    semanticViolationCount: Number((semanticReport?.violations || []).length),
    semanticOmissionCount: countSemanticViolations(semanticReport, 'omission'),
    semanticAdditionCount: countSemanticViolations(semanticReport, 'added_claim'),
    semanticDistortionCount: countSemanticViolations(semanticReport, 'distortion'),
    deterministicOmissionRestoreCount,
    deterministicOmissionRestoreRejectedCount,
    deterministicOmissionRestoreRejectionCodes: safeFailureCodeList(deterministicOmissionRestoreRejectionCodes),
    discourseAuditVersion: Number(deliveryAudit?.discourseAudit?.version || 0),
    discoursePass: deliveryAudit?.discourseAudit?.pass !== false,
    discourseWarningCodes: safeFailureCodeList(deliveryAudit?.discourseAudit?.codes),
    discourseSignalCount: Number(deliveryAudit?.discourseAudit?.violations?.length || 0),
    discourseRepairRan: (semanticReport.initialViolations || []).some(item => discourseAudit.isDiscourseViolationCode(item?.type))
      && Number(semanticReport.repairCount || 0) > 0,
    legalIntegrityPass: deliveryAudit?.legalIntegrity?.applicable
      ? deliveryAudit.legalIntegrity.pass === true
      : null,
    legalIntegrityIssueCodes: safeFailureCodeList(deliveryAudit?.legalIntegrity?.issueCodes),
    repairCount: (semanticReport.repairCount || 0)
      + polishRetryCount
      + generalSurfaceRetryCount
      + polishSpeakerRestoreCount
      + (koreanDeterministicRepairCount > 0 ? 1 : 0)
      + koreanRefinementRetryCount
      + (quoteIntegrityRestoreCount > 0 ? 1 : 0)
      + fingerprintRepairCount
      + (fingerprintSourceRestoreCount > 0 ? 1 : 0)
      + endingStyleRepairCount
      + resumeCoverageRepairCount,
    chunkCount: records.length,
    logicalChunkCount: chunkExecution.logicalChunkCount,
    editableChunkCount: chunkExecution.editableChunkCount,
    lockedChunkCount: chunkExecution.lockedChunkCount,
    skippedChunkCount: chunkExecution.skippedChunkCount,
    deferredLabelMicroChunkCount: chunkExecution.deferredLabelMicroChunkCount,
    deferredPolishMicroChunkCount: chunkExecution.deferredPolishMicroChunkCount,
    transformedChunkCount: chunkExecution.transformedChunkCount,
    chunkConcurrency,
    approvedModelChunkCount,
    modelFailureChunkCount,
    deliveryDecision: finalDeliveryDecision,
    deliveryReasonCodes: finalDeliveryReasonCodes,
    effectStatus,
    effectNoticeCodes: safeFailureCodeList(effectNotices.map(item => item.code)),
    structureSignaturePass: structureAudit?.pass === true,
    sectionPathErrorCount: Number(structureAudit?.sectionPathErrorCount || 0),
    signatureLineCount: Number(documentProfile?.formatProfile?.signatureLineCount || 0),
    clinicalStructureSignalCount: Number(documentProfile?.signals?.soapHeadingSignals || 0)
      + Number(documentProfile?.signals?.clinicalLabelSignals || 0),
    humanizeCallCount: chunkExecution.humanizeCallCount,
    semanticModelCallCount: chunkExecution.semanticModelCallCount,
    surfaceRetryCallCount: chunkExecution.surfaceRetryCallCount,
    modelCallCount: chunkExecution.modelCallCount,
    semanticSectionCount: chunkExecution.semanticSectionCount,
    chunkFailureCodes: chunkFailures.all,
    chunkPrimaryFailureCodes: chunkFailures.primary,
    chunkResidualFailureCodes: chunkFailures.residual,
    chunkFallbackReasonCodes: chunkFailures.fallback,
    retryCounts,
    fallbackCount,
    lengthRatio: Number(finalEditMetrics.lengthRatio.toFixed(4)),
    polishSpeakerRestoreCount,
    polishSpeakerRestoredSentenceCount,
    polishRetryReason,
    polishSourceIssueCount: Number(polishReport?.sourceIssueCount || 0),
    polishFixedSourceIssueCount: Number(polishReport?.fixedSourceIssueCount || 0),
    polishRemainingSourceIssueCount: Number(polishReport?.remainingSourceIssueCount || 0),
    polishUnresolvedSourceIssueCodes: safeFailureCodeList(polishReport?.unresolvedSourceIssueCodes),
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
    humanizationTargetDepthGap: humanizationDepth.targetDepthGap(humanizationDepthReport),
    humanizationDeliveryDepthBand: humanizationDepthReport?.metrics?.deliveryDepthBand || '',
    humanizationDepthRetryCount,
    humanizationDepthEscalationAttemptCount,
    humanizationNoEffectRetryAttemptCount,
    humanizationRoleRecoveryAttemptCount,
    humanizationDepthRetryApplied,
    humanizationDepthRetryTargetSentenceCount,
    humanizationDepthRetryRejectedCount,
    humanizationDepthRetryRejectionCodes,
    humanizationDepthStages,
    humanizationBestDepthStage: bestHumanizationDepthStage?.stage || '',
    humanizationBestDepthScore: Number(bestHumanizationDepthStage?.score || 0),
    humanizationFinalDepthRegression: finalHumanizationDepthRegression,
    humanizationFinalDepthRegressed: isMaterialDepthRegression(
      bestHumanizationDepthStage,
      finalHumanizationDepthStage
    ),
    sectionRecoveryEnabled: sectionRecoveryReport.metrics?.enabled === true,
    sectionRecoveryAttemptCount: Number(sectionRecoveryReport.metrics?.attempted || 0),
    sectionRecoveryPreferredSectionCount: Number(sectionRecoveryReport.metrics?.selectedPreferredSectionCount || 0),
    sectionRecoveryFragmentCount: Number(sectionRecoveryReport.metrics?.selectedFragmentCount || 0),
    sectionRecoveryTargetOnlyCount: Number(sectionRecoveryReport.metrics?.selectedTargetOnlyCount || 0),
    sectionRecoveryAppliedCount: Number(sectionRecoveryReport.metrics?.applied || 0),
    sectionRecoveryEscalationCount: Number(sectionRecoveryReport.metrics?.escalated || 0),
    sectionRecoveryEscalationEligibleCount: Number(sectionRecoveryReport.metrics?.escalationEligibleCount || 0),
    sectionRecoveryEscalationSkippedCount: Number(sectionRecoveryReport.metrics?.escalationSkippedCount || 0),
    sectionRecoveryEscalationSkipCodes: safeFailureCodeList(sectionRecoveryReport.metrics?.escalationSkipCodes),
    sectionRecoveryEscalationSkipCodeCounts: sanitizeCountMap(sectionRecoveryReport.metrics?.escalationSkipCodeCounts),
    sectionRecoveryEscalationMaximum: Number(sectionRecoveryReport.metrics?.escalationMaximum || 0),
    sectionRecoveryConcurrency: Number(sectionRecoveryReport.metrics?.concurrency || 0),
    sectionRecoveryRejectedAttemptCount: Number(sectionRecoveryReport.metrics?.rejectedAttemptCount || 0),
    sectionRecoveryRejectionCodes: safeFailureCodeList(sectionRecoveryReport.metrics?.rejectionCodes),
    sectionRecoveryRejectionCodeCounts: sanitizeCountMap(sectionRecoveryReport.metrics?.rejectionCodeCounts),
    sectionRecoveryMiniAppliedCount: Number(sectionRecoveryReport.metrics?.miniAppliedCount || 0),
    sectionRecoveryEscalationAppliedCount: Number(sectionRecoveryReport.metrics?.escalationAppliedCount || 0),
    sectionRecoveryPartialAppliedCount: Number(sectionRecoveryReport.metrics?.partialAppliedCount || 0),
    sectionRecoveryPartialAppliedSentenceCount: Number(sectionRecoveryReport.metrics?.partialAppliedSentenceCount || 0),
    sectionRecoveryPartialRejectedSentenceCount: Number(sectionRecoveryReport.metrics?.partialRejectedSentenceCount || 0),
    sectionRecoveryPartialRejectionCodes: safeFailureCodeList(sectionRecoveryReport.metrics?.partialRejectionCodes),
    safePartialCandidateAppliedCount,
    safePartialSentenceAppliedCount,
    safePartialSentenceRejectedCount,
    safePartialRejectionCodes: safeFailureCodeList(safePartialRejectionCodes),
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
    fingerprintSourceRestoreCount,
    finalSourceIntegrityRestoreCount,
    finalSourceIntegrityRestoreCodes: safeFailureCodeList(finalSourceIntegrityRestoreCodes),
    finalKoreanSourceRestoreCount,
    finalKoreanSourceRestoreCodes: safeFailureCodeList(finalKoreanSourceRestoreCodes),
    fingerprintShadow: Array.isArray(fingerprintAudit?.shadow) ? fingerprintAudit.shadow.slice(0, 8) : [],
    fingerprintShadowPositiveCodes: safeFailureCodeList((fingerprintAudit?.shadow || [])
      .filter(item => Number(item?.delta || 0) > 0)
      .map(item => item.code)),
    fingerprintShadowPositiveCount: (fingerprintAudit?.shadow || [])
      .reduce((sum, item) => sum + Math.max(0, Number(item?.delta || 0)), 0),
    lexicalTransitionCodes: safeFailureCodeList((fingerprintAudit?.lexicalTransitions || [])
      .filter(item => Number(item?.transitionCount || 0) > 0)
      .map(item => item.code)),
    lexicalTransitionCount: Number(fingerprintAudit?.lexicalTransitionCount || 0),
    endingStyleAuditVersion: Number(endingStyleAudit?.version || 0),
    endingStylePass: endingStyleAudit?.pass === true,
    endingStyleIssueCount: Number(endingStyleAudit?.issueCount || 0),
    endingStyleIntroducedOtherCount: Number(endingStyleAudit?.introducedOtherCount || 0),
    endingStyleRetryAttemptCount,
    endingStyleRepairCount,
    endingStyleRetryApplied,
    endingStyleSourceRestoreCount,
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
    studentRecordFragmentCount: Number((koreanRefinementAudit?.issues || [])
      .find(item => item.code === 'student_record_fragment')?.afterCount || 0),
    functionalGreetingDuplicationCount: Number((koreanRefinementAudit?.issues || [])
      .find(item => item.code === 'functional_greeting_duplication')?.afterCount || 0),
    adjacentSemanticRepetitionCount: Number((koreanRefinementAudit?.issues || [])
      .find(item => item.code === 'adjacent_semantic_repetition')?.afterCount || 0),
    removedAdjacentRestatementCount: Number(postprocessMeta?.dedupe?.removedAdjacentRestatementCount || 0),
    adjacentRestatementFamilies: safeFailureCodeList(postprocessMeta?.dedupe?.adjacentRestatementFamilies),
    directionalGrowthCollocationCount: Number((koreanRefinementAudit?.issues || [])
      .find(item => item.code === 'directional_growth_collocation')?.afterCount || 0),
    koreanDeterministicRepairCount,
    koreanRefinementRetryAttemptCount,
    koreanRefinementRetryCount,
    koreanRefinementRetryApplied,
    koreanSourceRestoreCount,
    quoteIntegrityAuditVersion: Number(quoteIntegrityAudit?.version || 0),
    quoteIntegrityPass: quoteIntegrityAudit?.pass === true,
    quoteCountChanged: quoteIntegrityAudit?.countChanged === true,
    quoteContentChangedCount: Number(quoteIntegrityAudit?.changedCount || 0),
    quoteIntegrityRestoreCount,
    finalQuoteIntegrityRestoreCount,
    inlineCodeSpanCount: Number(inlineCodeFreeze.count || 0),
    inlineCodeIntegrityPass: inlineCodeIntegrity.pass === true,
    inlineCodeRestoredCount: Number(inlineCodeIntegrity.restoredCount || 0),
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
    sourcePreflightIssueCodes: safeFailureCodeList(sourcePreflightAudit?.issueCodes),
    sourceLayoutRepairCount: Number((sourcePreflightAudit?.issues || [])
      .filter(item => item?.action === 'repaired')
      .reduce((sum, item) => sum + Number(item?.count || 0), 0)),
    assessmentProtectedLineCount: Number(documentProfile?.formatProfile?.assessmentProtectedLineCount || 0),
    assessmentExplanationLineCount: Number(documentProfile?.formatProfile?.assessmentExplanationLineCount || 0),
    structuralContextIssueCount: structureContextIssueCount(structureAudit)
  };
  result.humanizeMeta = {
    provider: 'openai',
    engine: VERSION,
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
    niklQuality: niklQualityEnabled ? (result.niklQualityTest || { enabled: true }) : null,
    niklQualityTest: niklQualityEnabled ? (result.niklQualityTest || { enabled: true }) : null,
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
      removedAdjacentRestatementCount: result.dedupeAudit.removedAdjacentRestatementCount || 0,
      adjacentRestatementFamilies: result.dedupeAudit.adjacentRestatementFamilies || [],
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
    effectStatus,
    effectNotices,
    sourceReviewWarnings,
    engineMeta: result.engineMeta,
    chunks: records,
    fallbackCount,
    gptEngine: result.humanizeMeta
  };
}

async function processChunk({ chunk, chunks, index, source, contract, inputRisk, sourceSurface, mode, requestStrength = '', lang, userNotes, evidence, cfg, styleProfile, documentProfile, voiceProfile, niklQualityTest = false, safetyIdentifier = '', signal }) {
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
  if (shouldDeferLabelMicroFragment({
    chunk,
    chunks,
    index,
    documentProfile,
    mode
  })) {
    // 라벨형 설문·기록표의 짧은 답변을 각각 모델 호출하면 5~6천 자 문서도
    // 수십 회 호출된다. 대표 본문만 1차 변환하고 나머지는 원문으로 보존한
    // 뒤, 절 회복·문서 단위 감사가 실제 잔여 대상을 다룬다. 라벨 접두부와
    // 행 경계는 기존 구조 잠금을 그대로 유지한다.
    chunk.outputText = original;
    return chunkRecord({
      chunk,
      outputText: original,
      skipped: true,
      warnings: [mode === 'polish'
        ? 'polish_label_micro_fragment_deferred'
        : 'label_micro_fragment_deferred']
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
  // Primary retries and quality escalation share one absolute budget. A slow
  // first model call must not grant the escalation model a fresh full window.
  const chunkDeadlineMs = Date.now()
    + Math.max(10000, Number(process.env.OPENAI_CHUNK_TOTAL_TIMEOUT_MS) || 180000);

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
    safetyIdentifier,
    chunkDeadlineMs,
    signal
  });
  if (mode === 'polish' && first.hardFail && first.record?.hardFailReason === 'noop_unchanged') {
    chunk.outputText = first.outputText;
    first.record.fallback = false;
    first.record.error = null;
    first.record.warnings = [...(first.record.warnings || []), 'polish_chunk_unchanged_allowed'];
    return first.record;
  }
  if (first.hardFail && isNonEscalatableModelFailure(first.record)) {
    chunk.outputText = original;
    return first.record;
  }
  if (!first.hardFail || cfg.escalation.enabled === false) {
    chunk.outputText = first.hardFail ? original : first.outputText;
    return first.record;
  }

  const escalationPatchTargets = buildV2EscalationPatchTargets(patchTargets, first.record);

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
    safetyIdentifier,
    chunkDeadlineMs,
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
  if (boundaryFailureReasons.includes('structure_boundary_marker_failed')
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

  if (first.record?.hardFailReason === 'voice_sparse_distribution_failed'
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

  if (isReviewableResidualPovAttempt(second)) {
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
  if (voiceReviewAttempts.length > 0
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

  if (mode !== 'polish'
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

  const safeFallbackSurfaceRetry = mode !== 'polish'
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
    niklQualityTest = false, safetyIdentifier = '', chunkDeadlineMs, signal
  } = args;
  const allowedExtra = deliveryPolicy.buildAllowedExtra({ evidence, userNotes });
  try {
    const koreanQualityHints = koreanRefinement.buildSourcePromptHints(original, {
      mode,
      documentProfile
    });
    const niklSourceQuality = niklQualityTest ? safeNiklQualityAnalysis(original, {
      mode,
      register: contract.register
    }) : null;
    const niklQualityHints = niklQualityTest ? safeNiklQualityHints(niklSourceQuality) : '';
    const niklExternalApiHints = niklQualityTest ? await safeNiklExternalApiHints(original, protectedTerms) : '';
    const riskProfile = composeRiskProfile(
      inputRisk,
      koreanQualityHints,
      [niklQualityHints, niklExternalApiHints].filter(Boolean).join('\n\n')
    );
    const chunkHumanizationPlan = isHumanizationDepthEnabled() ? humanizationDepth.buildHumanizationPlan(original, {
      requestStrength,
      documentProfile,
      inputRisk
    }) : null;
    const chunkDiscourseProfile = discourseAudit.buildDiscourseProfile(original);
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
    const promptIntegrity = prompts.validateHumanizePrompt(hp.stable);
    if (!promptIntegrity.pass) {
      const error = new Error(`humanize_prompt_integrity_failed:${promptIntegrity.errors.join(',')}`);
      error.code = 'HUMANIZE_PROMPT_INTEGRITY_FAILED';
      throw error;
    }
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
      deadlineMs: chunkDeadlineMs,
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
    outputText = chunkPostprocess(outputText, original, {
      preserveLineBreaks: voiceProfile?.lineBreakSensitive === true
    });
    const gate = evaluateChunkGate({
      outputText,
      original,
      source,
      contract,
      mode,
      protectedTerms,
      sourceSurface,
      allowedExtra,
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
    if (!gate.hardFail) {
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
    if (!gate.hardFail) {
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
    if (!gate.hardFail) {
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
    const niklQualityGate = niklQualityTest ? safeNiklQualityGate(original, outputText, {
      mode,
      register: contract.register,
      beforeAnalysis: niklSourceQuality
    }) : null;
    // NIKL은 관리자 shadow 관측값이다. 서로 다른 한국어 판정기가 같은
    // 후보를 차단하거나 다시 검토 상태로 바꾸지 않도록 gate에는 합치지 않는다.
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
        niklQuality: compactNiklQualityGate(niklQualityGate),
        selectedModel: response.model,
        retryCounts: response.retryCounts,
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
    const failureCode = modelCallFailureCode(err);
    // 결제 한도·프로젝트 쿼터 소진은 청크별 품질 실패가 아니다. 원문
    // fallback으로 다음 수십 개 청크를 계속 호출하면 같은 429만 반복하고
    // 작업 시간도 길어진다. 문서 전체 기술 오류로 즉시 올려 무차감한다.
    if (failureCode === 'openai_quota_exhausted') {
      err.code = 'OPENAI_QUOTA_EXHAUSTED';
      err.technical = true;
      throw err;
    }
    return {
      outputText: original,
      hardFail: true,
      record: chunkRecord({
        chunk,
        outputText: original,
        fallback: true,
        error: err && err.message || String(err),
        hardFailReason: failureCode,
        warnings: [failureCode],
        selectedModel: model,
        retryCounts: sanitizeRetryCounts(err?.retryCounts),
        escalated: phase === 'escalation'
      })
    };
  }
}

async function detect({ text, lang = 'ko', signal, config, route = 'detect', allowLocalFallback = true, uid = '', safetyIdentifier = '' } = {}) {
  const source = String(text || '').trim();
  const cfg = await loadConfig(config);
  const safetyId = uid
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
  const safetyId = uid
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
  const safetyId = uid
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
  if (normalizeBare(original).length > 120 && isNoopEquivalent(original, outputText, mode)) {
    warnings.push('noop_unchanged');
    violations.push({ gate: 'noop_unchanged', detail: 'output equivalent to source' });
    return { hardFail: true, reason: 'noop_unchanged', warnings, violations };
  }
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
  if (normalizeBare(source).length > 120 && isNoopEquivalent(source, outputText, mode)) {
    warnings.push('noop_unchanged');
    violations.push({ gate: 'noop_unchanged', detail: 'final output equivalent to source' });
    return { hardFail: true, reason: 'noop_unchanged', warnings, violations };
  }
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
  // Korean rewrites can consume close to one output token per character.
  // Responses reasoning tokens and the structured JSON body share this same
  // ceiling, so a text-only multiplier can still truncate medium documents.
  // Keep a fixed reasoning/JSON reserve in addition to the source-size budget.
  // The API bills actual usage, not this allowance.
  return Math.max(4000, Math.min(12000, Math.ceil(2400 + (chars * 3.2))));
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

function auditGeneralSurfaceCandidateWithStructure({
  source,
  current = '',
  candidate,
  contract,
  documentProfile,
  mode = 'assignment',
  chunks,
  plan,
  boundaryRepair,
  humanizationPlan = null
} = {}) {
  const prepared = prepareGeneralSurfaceCandidate({
    source,
    candidate,
    chunks
  });
  const preparedCandidate = prepared.text;
  const audit = auditGeneralSurfaceCandidate(
    source,
    preparedCandidate,
    contract,
    documentProfile,
    mode,
    current,
    humanizationPlan
  );
  const codes = [...(audit.codes || [])];
  if (!preservesFinalStructure(source, preparedCandidate, chunks, plan, boundaryRepair)
      && !codes.includes('structure_loss')) {
    codes.push('structure_loss');
  }
  return {
    ...audit,
    pass: codes.length === 0,
    codes,
    candidate: preparedCandidate,
    lockedLayoutRestored: prepared.applied,
    lockedLayoutRestoreCount: prepared.restoredCount
  };
}

function auditGeneralSurfaceCandidate(
  source,
  candidate,
  contract,
  documentProfile,
  mode = 'assignment',
  current = '',
  humanizationPlan = null
) {
  const before = String(source || '').trim();
  const baseline = String(current || before).trim() || before;
  const after = String(candidate || '').trim();
  const codes = [];
  const add = code => {
    if (!codes.includes(code)) codes.push(code);
  };
  if (!before || !after) return { pass: false, codes: ['empty_candidate'] };
  if (isNoopEquivalent(baseline, after, mode)) return { pass: false, codes: ['candidate_unchanged'] };
  const metrics = computeEditMetrics(before, after);
  const editLimits = generalRecoveryEditLimits(humanizationPlan);
  if (metrics.charEditRatio <= 0 || metrics.charEditRatio > editLimits.maxEdit) add('edit_range_exceeded');
  if (metrics.lengthRatio < editLimits.minLength || metrics.lengthRatio > editLimits.maxLength) {
    add('length_range_failed');
  }

  const beforeVoice = buildVoiceProfile(before, { documentProfile: documentProfile || 'unknown' });
  const baselineVoice = buildVoiceProfile(baseline, { documentProfile: documentProfile || 'unknown' });
  const afterVoice = buildVoiceProfile(after, { documentProfile: documentProfile || 'unknown' });
  if (recoveryParagraphRisk(beforeVoice, baselineVoice, afterVoice, documentProfile, mode).worsened) {
    add('structure_loss');
  }

  const baselineNovelty = floor.measureNovelty(before, baseline, '');
  const candidateNovelty = floor.measureNovelty(before, after, '');
  const baselineLostFacts = floor.measureLostFacts(before, baseline);
  const candidateLostFacts = floor.measureLostFacts(before, after);
  if (!issueItemsNotWorse(baselineNovelty, candidateNovelty)
      || !issueItemsNotWorse(baselineLostFacts, candidateLostFacts)) {
    add('semantic_shift');
  }
  const baselineNumbers = compareNumberMultiset(before, baseline);
  const candidateNumbers = compareNumberMultiset(before, after);
  if (!numberAuditNotWorse(baselineNumbers, candidateNumbers)) add('number_changed');

  const baselinePov = floor.measurePovDrift(before, baseline, contract?.povSeed);
  const candidatePov = floor.measurePovDrift(before, after, contract?.povSeed);
  if (povDriftWorsened(baselinePov, candidatePov)) add('pov_shift');

  const protectedTerms = extractProtectedTerms(before, documentProfile);
  const baselineLostTerms = new Set(protectedTerms.filter(term => !containsNormalizedValue(baseline, term)));
  if (protectedTerms.some(term => (
    !containsNormalizedValue(after, term) && !baselineLostTerms.has(term)
  ))) add('protected_term_loss');

  const beforeSentenceCount = meaningfulSentenceCount(before);
  const afterSentenceCount = meaningfulSentenceCount(after);
  const exactSentenceStructure = beforeVoice.lineBreakSensitive === true
    || beforeVoice.lineBoundaryPolicy === 'all'
    || documentProfile?.formatProfile?.flags?.some?.(flag => [
      'questionnaire',
      'assessment_item',
      'creative_lines'
    ].includes(flag));
  if (exactSentenceStructure && beforeSentenceCount !== afterSentenceCount) add('structure_loss');
  if (!exactSentenceStructure) {
    const sentenceBand = recoverySentenceCountBand(beforeSentenceCount);
    const baselineSentenceRisk = distanceToRange(
      meaningfulSentenceCount(baseline),
      sentenceBand.min,
      sentenceBand.max
    );
    const candidateSentenceRisk = distanceToRange(
      afterSentenceCount,
      sentenceBand.min,
      sentenceBand.max
    );
    if (candidateSentenceRisk > baselineSentenceRisk) add('structure_loss');
  }
  if (countDistanceWorsened(
    beforeVoice.directQuoteCount,
    baselineVoice.directQuoteCount,
    afterVoice.directQuoteCount
  )) add('quote_loss');
  if (countDistanceWorsened(
    beforeVoice.listItemCount,
    baselineVoice.listItemCount,
    afterVoice.listItemCount
  )) add('structure_loss');
  if (countDistanceWorsened(
    beforeVoice.headingCount,
    baselineVoice.headingCount,
    afterVoice.headingCount
  )) add('structure_loss');
  if (beforeVoice.lineBoundaryPolicy === 'all' && beforeVoice.lineCount !== afterVoice.lineCount) {
    add('structure_loss');
  }

  if (structuralRoleRiskWorsened(before, baseline, after)) add('structure_loss');
  if (voiceDistributionWorsened(beforeVoice, baselineVoice, afterVoice, mode)) add('voice_shift');

  const integrity = candidateIntegrity.auditCandidateIntegrity({
    source: before,
    before: baseline,
    candidate: after,
    documentProfile,
    mode
  });
  for (const reason of integrity.reasons || []) {
    const mapped = {
      empty_candidate: 'empty_candidate',
      korean_integrity_worsened: 'korean_integrity',
      semantic_relation_worsened: 'semantic_relation_shift',
      ending_style_worsened: 'ending_style_shift',
      direct_quote_worsened: 'quote_loss',
      legal_integrity_worsened: 'semantic_relation_shift',
      structure_integrity_worsened: 'structure_loss'
    }[reason] || 'safety_audit_failed';
    add(mapped);
  }
  return {
    pass: codes.length === 0,
    codes,
    metrics,
    limits: editLimits,
    integrity
  };
}

function prepareGeneralSurfaceCandidate({ source, candidate, chunks } = {}) {
  const before = String(candidate || '').trim();
  if (!before || !Array.isArray(chunks) || !chunks.length) {
    return { text: before, applied: false, restoredCount: 0 };
  }
  const restored = structureChunk.restoreLockedStructureLayout({
    source,
    outputText: before,
    chunks
  });
  if (restored.pass !== true || !String(restored.text || '').trim()) {
    return { text: before, applied: false, restoredCount: 0 };
  }
  return {
    text: String(restored.text).trim(),
    applied: restored.applied === true,
    restoredCount: Number(restored.restoredCount || 0)
  };
}

function generalRecoveryEditLimits(plan = null) {
  const targetMaximum = Number(plan?.targetSubstantiveEditMax || 0);
  const advanced = String(plan?.requestStrength || '') === 'advanced';
  const shortDocument = Number(plan?.sourceChars || 0) > 0
    && Number(plan.sourceChars) <= 120;
  return {
    // 짧은 문서는 한 문장만 제대로 다시 써도 문자 편집률이 크게 뛴다.
    // 의미·수치·화자 감사가 모두 통과한 후보를 32% 같은 장문용 상한으로
    // 버리지 않는다. 장문 고급도 목표 상단에 도달할 수 있는 여유를 둔다.
    maxEdit: shortDocument
      ? 0.62
      : (advanced
          ? Math.min(0.58, Math.max(0.52, targetMaximum + 0.24))
          : Math.min(0.50, Math.max(0.44, targetMaximum + 0.22))),
    minLength: advanced ? 0.88 : 0.90,
    maxLength: advanced ? 1.15 : 1.12
  };
}

function recoveryParagraphRisk(sourceVoice, baselineVoice, candidateVoice, documentProfile, mode) {
  const sourceCount = Number(sourceVoice?.paragraph?.count || 0);
  const baselineCount = Number(baselineVoice?.paragraph?.count || 0);
  const candidateCount = Number(candidateVoice?.paragraph?.count || 0);
  if (!sourceCount) return { worsened: false, sourceCount, baselineCount, candidateCount };
  const flags = new Set(documentProfile?.formatProfile?.flags || []);
  const exact = mode === 'polish'
    || sourceVoice?.lineBreakSensitive === true
    || sourceVoice?.lineBoundaryPolicy === 'all'
    || ['questionnaire', 'assessment_item', 'creative_lines'].some(flag => flags.has(flag));
  const minimum = exact
    ? sourceCount
    : (sourceCount === 1 ? 1 : Math.max(1, Math.floor(sourceCount * 0.60)));
  const maximum = exact
    ? sourceCount
    : Math.max(
        sourceCount,
        paragraphExpansionLimit(sourceCount, sourceVoice?.compactLength || 0),
        Number(sourceVoice?.layout?.structuralLineCount || 0)
      );
  const baselineRisk = distanceToRange(baselineCount, minimum, maximum);
  const candidateRisk = distanceToRange(candidateCount, minimum, maximum);
  return {
    worsened: candidateRisk > baselineRisk,
    sourceCount,
    baselineCount,
    candidateCount,
    minimum,
    maximum,
    baselineRisk,
    candidateRisk
  };
}

function recoverySentenceCountBand(sourceCount) {
  const count = Math.max(0, Number(sourceCount || 0));
  if (count <= 0) return { min: 0, max: 0 };
  if (count <= 2) return { min: 1, max: count + 2 };
  return {
    min: Math.max(1, Math.floor(count * 0.72)),
    max: Math.max(count + 2, Math.ceil(count * 1.35))
  };
}

function distanceToRange(value, minimum, maximum) {
  const current = Number(value || 0);
  if (current < minimum) return minimum - current;
  if (current > maximum) return current - maximum;
  return 0;
}

function issueItemsNotWorse(beforeReport, candidateReport) {
  const allowed = new Set((beforeReport?.items || []).map(normalizeAuditItem));
  return (candidateReport?.items || []).every(item => allowed.has(normalizeAuditItem(item)));
}

function normalizeAuditItem(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function povDriftWorsened(before, candidate) {
  return [
    'introducedFirstPerson',
    'introducedFirstPersonPlural',
    'introducedAnyFirstPerson',
    'droppedFirstPerson',
    'droppedFirstPersonPlural',
    'droppedAnyFirstPerson'
  ].some(key => candidate?.[key] === true && before?.[key] !== true);
}

function countDistanceWorsened(sourceCount, currentCount, candidateCount) {
  return Math.abs(Number(candidateCount || 0) - Number(sourceCount || 0))
    > Math.abs(Number(currentCount || 0) - Number(sourceCount || 0));
}

function structuralRoleRiskWorsened(source, current, candidate) {
  const currentReport = structureChunk.compareStructuralRoleSignatures(source, current);
  const candidateReport = structureChunk.compareStructuralRoleSignatures(source, candidate);
  const sourceSignature = currentReport.source || {};
  const currentSignature = currentReport.output || {};
  const candidateSignature = candidateReport.output || {};
  return Object.keys(sourceSignature).some(key => (
    Math.abs(Number(candidateSignature[key] || 0) - Number(sourceSignature[key] || 0))
      > Math.abs(Number(currentSignature[key] || 0) - Number(sourceSignature[key] || 0))
  ));
}

function voiceDistributionWorsened(sourceVoice, currentVoice, candidateVoice, mode) {
  if (mode === 'polish') return false;
  const current = sentenceDistributionShift(sourceVoice?.sentence, currentVoice?.sentence);
  const candidate = sentenceDistributionShift(sourceVoice?.sentence, candidateVoice?.sentence);
  if (!candidate.shift) return false;
  if (!current.shift) return true;
  return Number(candidate.cvLoss || 0) > Number(current.cvLoss || 0) + 0.01
    || Number(candidate.spreadLoss || 0) > Number(current.spreadLoss || 0) + 0.04;
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
  if (!original || !current || !after || isNoopEquivalent(current, after, mode)) return false;
  const localEdit = computeEditMetrics(current, after);
  if (localEdit.charEditRatio <= 0 || localEdit.charEditRatio > maxLocalEditRatio) return false;
  if (localEdit.lengthRatio < minLocalLengthRatio || localEdit.lengthRatio > maxLocalLengthRatio) return false;
  if (paragraphCount(current) !== paragraphCount(after)) return false;
  const beforeNumberAudit = compareNumberMultiset(original, current);
  const afterNumberAudit = compareNumberMultiset(original, after);
  if (!numberAuditNotWorse(beforeNumberAudit, afterNumberAudit)) return false;
  const beforeNovelty = floor.measureNovelty(original, current, '').count || 0;
  const afterNovelty = floor.measureNovelty(original, after, '').count || 0;
  const beforeLostFacts = floor.measureLostFacts(original, current).count || 0;
  const afterLostFacts = floor.measureLostFacts(original, after).count || 0;
  if (afterNovelty > beforeNovelty || afterLostFacts > beforeLostFacts) return false;
  const beforePovDrift = floor.measurePovDrift(original, current, contract?.povSeed);
  const afterPovDrift = floor.measurePovDrift(original, after, contract?.povSeed);
  if ((!beforePovDrift.introducedAnyFirstPerson && afterPovDrift.introducedAnyFirstPerson)
      || (!beforePovDrift.droppedAnyFirstPerson && afterPovDrift.droppedAnyFirstPerson)) return false;
  if ((protectedTerms || []).some(term => (
    containsNormalizedValue(current, term) && !containsNormalizedValue(after, term)
  ))) return false;

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
  const integrity = candidateIntegrity.auditCandidateIntegrity({
    source: original,
    before: current,
    candidate: after,
    documentProfile,
    mode
  });
  if (!integrity.pass) return false;

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
    const policy = qualityV2.polishEditPolicy(original, after, { documentProfile });
    const padding = qualityV2.comparePolishEvaluativePadding(original, after);
    if (policy.noSafeChange || policy.excessiveChange || policy.needsIssueRecovery || padding.increased) return false;
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
  return (audit.lostLockedCount || 0) === 0
    && audit.lockedOrderChanged !== true
    && audit.structureSignaturePass !== false;
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

function chunkPostprocess(text, original, { preserveLineBreaks = false } = {}) {
  let out = String(text || '').trim();
  if (preserveLineBreaks) return out;
  try { out = spacing.fixSpacing(out).text; } catch {}
  try { out = spacing.restoreUrls(out, original).text; } catch {}
  try { out = spacing.stripAiUrlParams(out).text; } catch {}
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
    // 문단·레이아웃 결정권은 구조 모듈 하나에 둔다. 업종별 고정 문장을
    // 주입하던 basicblogtone과 실질 no-op flowCohesion은 운영 경로에서 제외한다.
    try {
      const dedupeResult = dedupe.dedupeSentences(out);
      out = dedupeResult.text;
      const blockDedupe = dedupe.removeNewExactDuplicateBlocks(source, out);
      out = blockDedupe.text;
      const seamDedupe = dedupe.removeGeneratedAdjacentRestatements(source, out);
      out = seamDedupe.text;
      meta.dedupe = {
        removedExactCount: (dedupeResult.removed || 0) + (blockDedupe.removedSentenceCount || 0),
        removedBlockCount: blockDedupe.removedBlockCount || 0,
        removedBlockSentenceCount: blockDedupe.removedSentenceCount || 0,
        removedAdjacentRestatementCount: seamDedupe.removedCount || 0,
        adjacentRestatementFamilies: seamDedupe.families || [],
        fuzzyWarningCount: dedupeResult.fuzzyWarnings?.length || 0,
        fuzzyWarnings: dedupeResult.fuzzyWarnings || []
      };
    } catch {}
  } else {
    meta.dedupe = { skipped: true, reason: 'creative_line_structure' };
  }
  try { out = spacing.restoreUrls(out, source).text; } catch {}
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

const EFFECT_OBSERVATION_CODES = new Set([
  // 문장 길이 분포 변화는 의미·사실·구조 손상이 아니라 자연성/효과
  // 관측이다. 최종 전달 검토 상태와 분리해 관리자에게는 계속 남긴다.
  'sentence_distribution_shift',
  // 문단 내용·순서·구조 토큰이 보존된 상태에서 남은 길이 경고는 전달
  // 안전 문제가 아니라 읽기 효과 관측이다. 실제 문단 구조 변화는 별도의
  // paragraph_structure_changed가 계속 품질 경고를 소유한다.
  'paragraph_readability',
  // 결론 표지·성찰 공식·완벽한 인과 종결의 반복은 의미·사실 손상이
  // 아니라 휴머나이징 효과와 자연성의 문제다. 실제 새 평가·범위 확장·
  // 강도 변화·문단 역할 변화는 별도 안전 코드로 계속 품질 경고를 만든다.
  'duplicate_conclusion',
  'repeated_reflection_conclusion',
  'overstructured_causality'
]);

function isEffectObservationCode(code) {
  return EFFECT_OBSERVATION_CODES.has(String(code || ''));
}

function toEffectNotice(item) {
  return {
    code: String(item?.code || 'effect_observation'),
    severity: 'info',
    message: String(item?.message || '결과의 문장 리듬을 확인해 주세요.')
  };
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
    const minimumEffectFailed = report?.minimumEffectPass === false;
    warnings.push({
      code: minimumEffectFailed
        ? 'humanization_depth_below_minimum'
        : 'humanization_depth_below_target',
      severity: 'warning',
      message: minimumEffectFailed
        ? '실질 변화가 안전 최소선보다 약하게 나왔어요. 결과를 확인해 주세요.'
        : '원문 보존을 우선해 권장 목표 강도보다 약하게 변환됐어요. 결과를 확인해 주세요.'
    });
  }
  const minimumEffectFailed = report?.minimumEffectPass === false;
  return warnings.length ? warnings : [{
    code: minimumEffectFailed
      ? 'humanization_depth_below_minimum'
      : 'humanization_depth_below_target',
    severity: 'warning',
    message: minimumEffectFailed
      ? '안전 최소 강도에 미달해 결과 확인이 필요해요.'
      : '권장 휴머나이징 목표 강도에 일부 미달해 결과 확인이 필요해요.'
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

function buildResult({ source, outputText, contract, mode, records, inputRisk, allowedExtra = '', niklQualityTest = false, structureAudit = null }) {
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
  try { result.floorNovelty = floor.measureNovelty(source, outputText, allowedExtra); } catch {}
  try { result.floorLength = floor.measureLength(source, outputText, mode); } catch {}
  try { result.repetition = floor.measureRepetition(outputText); } catch {}
  try { result.lostFacts = floor.measureLostFacts(source, outputText); } catch {}
  try { result.surface = surfaceguard.buildSurfaceReport(outputText); } catch {}
  // v2의 전달 상태는 deliveryPolicy와 finalQualityV2만 소유한다. 레거시
  // buildFloorReport를 다시 호출하면 conclusion_drift·experience_novelty
  // 같은 구형 휴리스틱이 새 의미 감사와 중복되어 clean 결과를 review로
  // 뒤집는다. 호환 측정값은 남기되 판정 배열은 비어 있는 단일 기준으로 시작한다.
  result.floorReport = buildV2BaseFloorReport(result, contract);
  if (niklQualityTest) {
    try {
      result.niklQualityTest = compactNiklQualityGate(safeNiklQualityGate(source, outputText, {
        mode,
        register: contract.register
      }));
    } catch {}
    result.niklQuality = result.niklQualityTest || null;
  }
  return result;
}

function buildV2BaseFloorReport(result, contract) {
  const length = result?.floorLength || {};
  const pov = result?.povDrift || {};
  return {
    status: 'clean',
    criticals: [],
    warnings: [],
    metrics: {
      lengthRatio: Number(length.ratio) || 0,
      novelty: Number(result?.floorNovelty?.count) || 0,
      lostFacts: Number(result?.lostFacts?.count) || 0,
      repetition: Number(result?.repetition?.total) || 0,
      povInject: Boolean(pov.introducedAnyFirstPerson && contract?.optIn !== true),
      judge: null
    }
  };
}

function depthEffectNotices(report) {
  return depthQualityWarnings(report).map(item => ({
    ...item,
    severity: 'info',
    message: String(item.message || '')
      .replace(/결과를 확인해 주세요\.?$/u, '안전하게 바꿀 수 있는 범위가 제한적이었어요.')
      .replace(/결과 확인이 필요해요\.?$/u, '안전하게 바꿀 수 있는 범위가 제한적이었어요.')
  }));
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
  if (audit.sectionPathErrorCount > 0) {
    additions.push({
      gate: 'section_path_mismatch',
      action: 'needs_review',
      count: audit.sectionPathErrorCount,
      samples: audit.sectionPathErrors || []
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
  const deferredPolishMicroChunkCount = rows.filter(record => (
    (record.warnings || []).includes('polish_label_micro_fragment_deferred')
  )).length;
  const deferredLabelMicroChunkCount = rows.filter(record => (
    (record.warnings || []).includes('polish_label_micro_fragment_deferred')
      || (record.warnings || []).includes('label_micro_fragment_deferred')
  )).length;
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
    editableChunkCount: transformed.length,
    lockedChunkCount,
    skippedChunkCount,
    deferredLabelMicroChunkCount,
    deferredPolishMicroChunkCount,
    transformedChunkCount: transformed.length,
    humanizeCallCount,
    semanticModelCallCount,
    surfaceRetryCallCount,
    modelCallCount: humanizeCallCount + semanticModelCallCount + surfaceRetryCallCount,
    semanticSectionCount: Number(semanticReport?.sectionCount) || 0
  };
}

function configuredChunkConcurrency() {
  // v2.5 운영 무차감 실호출 검증을 마친 기본값. 환경변수로 1까지 즉시
  // 낮출 수 있으며, 잘못된 값도 검증된 기본 동시성 2로 복귀한다.
  const value = Number(process.env.HUMANIZE_CHUNK_CONCURRENCY || 2);
  return Math.max(1, Math.min(3, Number.isFinite(value) ? Math.floor(value) : 2));
}

async function mapWithConcurrency(items, concurrency, worker, signal) {
  const rows = Array.isArray(items) ? items : [];
  const results = new Array(rows.length);
  let cursor = 0;
  const runWorker = async () => {
    while (true) {
      if (signal?.aborted) throw abortError();
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      results[index] = await worker(rows[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rows.length)) }, runWorker));
  return results;
}

function abortError() {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function countApprovedModelChunks(records, chunks, { documentRecoveryApplied = false, mode = '' } = {}) {
  const chunkByIndex = new Map((chunks || []).map(chunk => [chunk.index, chunk]));
  let count = 0;
  for (const record of records || []) {
    if (record?.locked || record?.skipped || record?.fallback) continue;
    const chunk = chunkByIndex.get(record.index);
    if (!chunk) continue;
    if (!isNoopEquivalent(chunk.text, chunk.outputText, mode)) count += 1;
  }
  if (count === 0 && documentRecoveryApplied) return 1;
  return count;
}

function isModelFailureRecord(record) {
  if (!record || record.locked || record.skipped) return false;
  if (record.fallback === true) return true;
  const values = [
    record.error,
    record.hardFailReason,
    ...(record.primaryFailureCodes || []),
    ...(record.warnings || [])
  ];
  return values.some(value => /gpt_call_failed|openai_(?:timeout|network|schema)|refus(?:al|ed)/iu.test(String(value || '')));
}

function modelCallFailureCode(error) {
  return classifyModelFailure(error);
}

function isNonEscalatableModelFailure(record) {
  return isNonEscalatableModelFailureCode(record?.hardFailReason);
}

function sanitizeRetryCounts(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    rateLimit: Math.max(0, Number(source.rateLimit) || 0),
    server: Math.max(0, Number(source.server) || 0),
    network: Math.max(0, Number(source.network) || 0),
    timeout: Math.max(0, Number(source.timeout) || 0),
    schema: Math.max(0, Number(source.schema) || 0)
  };
}

function summarizeRetryCounts(records) {
  return (records || []).reduce((total, record) => {
    const counts = sanitizeRetryCounts(record?.retryCounts);
    for (const key of Object.keys(total)) total[key] += counts[key];
    return total;
  }, sanitizeRetryCounts(null));
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
  niklQuality = null,
  retryCounts = null
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
    niklQuality,
    selectedModel,
    retryCounts: sanitizeRetryCounts(retryCounts)
  };
}

function deterministicDetectFallback(text, err) {
  const ir = safeInputRisk(text);
  const ratio = Number(ir?.abstractRiskRatio) || 0;
  const probability = Math.round(Math.min(92, Math.max(15, 22 + 70 * ratio)));
  return applyDetectNarrativePolicy({
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
  });
}

function normalizeDetectResult(json) {
  const probability = Math.max(0, Math.min(100, Math.round(Number(json.probability) || 0)));
  return applyDetectNarrativePolicy({
    probability,
    summary: String(json.summary || '').trim() || '분석 결과를 생성했습니다.',
    detail: String(json.detail || '').trim(),
    signals: Array.isArray(json.signals) ? json.signals.slice(0, 12) : [],
    confidence: ['low', 'medium', 'high'].includes(json.confidence) ? json.confidence : 'medium'
  });
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

function safeNiklQualityAnalysis(text, opts = {}) {
  try { return optionalNiklLab()?.niklTest?.analyzeNiklQuality(text, opts) || null; } catch { return null; }
}

function safeNiklQualityHints(analysis) {
  try { return analysis ? optionalNiklLab()?.niklTest?.buildNiklPromptHints(analysis, { max: 6 }) || '' : ''; } catch { return ''; }
}

async function safeNiklExternalApiHints(text, protectedTerms = []) {
  try {
    if (process.env.GPT_NIKL_EXTERNAL_API_ENABLED !== '1') return '';
    const api = optionalNiklLab()?.officialApi;
    if (!api) return '';
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
  try { return optionalNiklLab()?.niklTest?.evaluateNiklQuality(source, output, opts) || null; } catch { return null; }
}

function compactNiklQualityGate(gate) {
  try { return optionalNiklLab()?.niklTest?.compactNiklReport(gate) || null; } catch { return null; }
}

let optionalNiklLabModule = null;
function optionalNiklLab() {
  if (optionalNiklLabModule) return optionalNiklLabModule;
  // 관리자 shadow 도구는 명시적으로 켠 요청에서만 로드한다. 런타임 경로를
  // 조합해 production import graph와 일반 서버 시작 경로에서도 격리한다.
  optionalNiklLabModule = {
    niklTest: module.require(['..', 'engine', 'koreanQuality', 'niklTest'].join('/')),
    officialApi: module.require(['..', 'engine', 'koreanQuality', 'officialApi'].join('/'))
  };
  return optionalNiklLabModule;
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

const POLISH_LABEL_FRAGMENT_MODEL_BUDGET = 8;
const GENERAL_LABEL_FRAGMENT_MODEL_BUDGET = 12;

function shouldDeferLabelMicroFragment({
  chunk,
  chunks,
  index,
  documentProfile,
  mode = ''
} = {}) {
  const flags = new Set(documentProfile?.formatProfile?.flags || []);
  if (!flags.has('label_heavy') || chunk?.locked) return false;
  const editable = (chunks || [])
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(entry => !entry.item?.locked && String(entry.item?.text || '').trim());
  const polish = mode === 'polish';
  const activationThreshold = polish ? 12 : 18;
  if (editable.length <= activationThreshold) return false;
  const modelBudget = polish
    ? POLISH_LABEL_FRAGMENT_MODEL_BUDGET
    : GENERAL_LABEL_FRAGMENT_MODEL_BUDGET;

  const ranked = editable
    .map(entry => {
      const text = String(entry.item.text || '').trim();
      const compactLength = text.replace(/\s+/gu, '').length;
      const hasRepairHint = Boolean(koreanRefinement.buildSourcePromptHints(text, {
        documentProfile,
        mode: polish ? 'polish' : mode
      }));
      const completeSentence = /[.!?。！？]\s*[”’"'」』》〉)\]]*$/u.test(text)
        || /(?:다|요|죠|니다|니까|까요|함|임|음)$/u.test(text);
      return {
        ...entry,
        score: (hasRepairHint ? 10000 : 0)
          + (completeSentence ? 1000 : 0)
          + Math.min(500, compactLength)
      };
    })
    .sort((left, right) => right.score - left.score || left.itemIndex - right.itemIndex);
  const selected = new Set(
    ranked
      .slice(0, Math.min(modelBudget, ranked.length))
      .map(entry => entry.itemIndex)
  );
  return !selected.has(Number(index));
}

function shouldDeferPolishLabelMicroFragment(options = {}) {
  return shouldDeferLabelMicroFragment({ ...options, mode: 'polish' });
}

function reconcileSemanticOmissionRestores(report, restored) {
  const restoredKeys = new Set(restored?.restoredViolationKeys || []);
  const keyOf = item => `${item?.type || ''}\u0000${item?.span || ''}\u0000${item?.detail || ''}`;
  const reports = (report?.reports || []).map(section => {
    const violations = (section?.violations || []).filter(item => !restoredKeys.has(keyOf(item)));
    const uncertain = section?.uncertain === true || section?.skipped === true;
    return {
      ...section,
      violations,
      pass: violations.length === 0 && !uncertain
    };
  });
  const remainingViolations = Array.isArray(restored?.remainingViolations)
    ? restored.remainingViolations
    : (report?.violations || []).filter(item => !restoredKeys.has(keyOf(item)));
  const uncertain = reports.length
    ? reports.some(section => section.uncertain === true || section.skipped === true)
    : report?.uncertain === true;
  return {
    ...report,
    outputText: restored?.text || report?.outputText || '',
    reports,
    violations: remainingViolations,
    pass: remainingViolations.length === 0 && !uncertain,
    uncertain,
    deterministicOmissionRestoreCount: Number(report?.deterministicOmissionRestoreCount || 0)
      + Number(restored?.restoredCount || 0)
  };
}

function numberAuditRisk(value) {
  return Number(value?.addedCount || 0) + Number(value?.removedCount || 0);
}

function numberAuditNotWorse(before, candidate) {
  const countByToken = values => new Map((values || []).map(item => [
    String(item?.token || ''),
    Number(item?.count || 0)
  ]));
  const beforeRemoved = countByToken(before?.removedTokens);
  const beforeAdded = countByToken(before?.addedTokens);
  return !(candidate?.removedTokens || []).some(item => (
    Number(item?.count || 0) > Number(beforeRemoved.get(String(item?.token || '')) || 0)
  )) && !(candidate?.addedTokens || []).some(item => (
    Number(item?.count || 0) > Number(beforeAdded.get(String(item?.token || '')) || 0)
  ));
}

function structureAuditNotWorse(before, candidate) {
  const booleanWorsened = before?.lockedOrderChanged !== true && candidate?.lockedOrderChanged === true;
  if (booleanWorsened) return false;
  for (const key of [
    'lostLockedCount',
    'lockedOutOfOrderCount',
    'unsafeBoundaryCount',
    'sectionPathErrorCount'
  ]) {
    if (Number(candidate?.[key] || 0) > Number(before?.[key] || 0)) return false;
  }
  return true;
}

function structureContextIssueCount(value) {
  return Number(value?.lostLockedCount || 0)
    + Number(value?.lockedOutOfOrderCount || 0)
    + Number(value?.unsafeBoundaryCount || 0)
    + Number(value?.sectionPathErrorCount || 0);
}

function countSemanticViolations(report, type) {
  return (report?.violations || []).filter(item => item?.type === type).length;
}

function buildDepthStageSnapshot(stage, report) {
  const metrics = report?.metrics || {};
  return {
    stage: String(stage || '').slice(0, 48),
    pass: report?.pass === true,
    minimumEffectPass: report?.minimumEffectPass === true,
    targetDepthMet: metrics.targetDepthMet === true,
    score: Number(humanizationDepth.humanizationCandidateScore(report).toFixed(4)),
    substantiveEditRatio: Number(Number(metrics.substantiveEditRatio || 0).toFixed(4)),
    changedSentenceRatio: Number(Number(metrics.substantiveChangedSentenceRatio || 0).toFixed(4)),
    targetCoverage: Number(Number(metrics.targetCoverage || 0).toFixed(4)),
    structuralChangedCount: Number(
      metrics.effectiveStructuralChangedSentenceCount
        ?? metrics.structurallyChangedSentenceCount
        ?? 0
    ),
    carryoverRatio: Number(Number(metrics.substantiveCarryoverRatio || 0).toFixed(4))
  };
}

function bestDepthStageSnapshot(values) {
  const stages = Array.isArray(values) ? values.filter(Boolean) : [];
  return stages.reduce((best, current) => {
    if (!best) return current;
    if (current.pass === true && best.pass !== true) return current;
    if (current.pass !== true && best.pass === true) return best;
    if (current.targetDepthMet === true && best.targetDepthMet !== true) return current;
    if (current.targetDepthMet !== true && best.targetDepthMet === true) return best;
    if (Number(current.score || 0) > Number(best.score || 0)) return current;
    if (Number(current.score || 0) === Number(best.score || 0)
        && Number(current.substantiveEditRatio || 0) > Number(best.substantiveEditRatio || 0)) return current;
    return best;
  }, null);
}

function depthStageRegression(best, current) {
  if (!best || !current) return 0;
  return Number(Math.max(0, Number(best.score || 0) - Number(current.score || 0)).toFixed(4));
}

function isMaterialDepthRegression(best, current) {
  if (!best || !current) return false;
  if (best.pass === true && current.pass !== true) return true;
  // 의미 수리가 안전성을 회복하는 과정에서 최소 체감선까지 다시 무너진
  // 경우는 점수 하락 폭이 작아도 마지막 회복을 실행한다. 이전에는 목표
  // 깊이가 애초부터 미달이던 문서가 `minimum=true → false`로 내려가도
  // pass 값이 계속 false라 재시도를 건너뛰었다.
  if (best.minimumEffectPass === true && current.minimumEffectPass !== true) return true;
  if (best.targetDepthMet === true
      && current.targetDepthMet !== true
      && Number(best.substantiveEditRatio || 0) - Number(current.substantiveEditRatio || 0) >= 0.01) {
    return true;
  }
  const scoreDrop = depthStageRegression(best, current);
  const editDrop = Number(best.substantiveEditRatio || 0) - Number(current.substantiveEditRatio || 0);
  const structuralDrop = Number(best.structuralChangedCount || 0) - Number(current.structuralChangedCount || 0);
  return scoreDrop >= 0.04 && (editDrop >= 0.012 || structuralDrop >= 1);
}

function isSevereHumanizationNoEffect(report) {
  if (!report?.applicable) return false;
  const metrics = report.metrics || {};
  return report.minimumEffectPass === false
    || Number(metrics.substantiveEditRatio || 0) < 0.03
    || Number(metrics.substantiveChangedSentenceCount || 0) === 0
    || (Number(metrics.substantiveChangedSentenceRatio || 0) < 0.15
      && Number(metrics.substantiveEditRatio || 0) < 0.05);
}

function normalizeBare(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function normalizeLiteralSurface(text) {
  return String(text || '').normalize('NFC').replace(/\r\n?/gu, '\n').trim();
}

function isNoopEquivalent(source, outputText, mode = '') {
  if (String(mode || '').toLowerCase() === 'polish') {
    return normalizeLiteralSurface(source) === normalizeLiteralSurface(outputText);
  }
  return normalizeBare(source) === normalizeBare(outputText);
}

module.exports = {
  VERSION,
  PROFILE,
  run,
  detect,
  rewriteSentence,
  suggestEvidence,
  normalizeMode,
  effectiveModeForProfile,
  configuredChunkConcurrency,
  mapWithConcurrency,
  depthQualityWarnings,
  shouldDeferLabelMicroFragment,
  shouldDeferPolishLabelMicroFragment,
  auditGeneralSurfaceCandidate,
  auditGeneralSurfaceCandidateWithStructure,
  prepareGeneralSurfaceCandidate,
  isSafeLocalizedLanguageCandidate,
  isMaterialDepthRegression,
  isNoopEquivalent,
  countApprovedModelChunks
};
