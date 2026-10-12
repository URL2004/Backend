'use strict';

const { admin, db } = require('../config');
const historyLinkIntegrity = require('./historyLinkIntegrity');
const { accountDeletionBlocksWrites } = require('./accountActivityClaims');
const sourceScores = require('./detectSourceScore');
const { storedDetectInterpretation } = require('./detectHistoryPresentation');
const codec = require('./detectResponseCodec');

const CURRENT_BILLING_DISPOSITIONS = new Set([
  'charged',
  'plan_unlimited',
  'admin_no_charge',
  // 결과는 전달됐지만 Firestore/원장 차감이 실패한 운영 사고다.
  // `charged`로 위장하지 않고 관리자 재정산 대상으로 남긴다.
  'charge_failed'
]);
const HISTORY_BILLING_DISPOSITIONS = new Set([
  ...CURRENT_BILLING_DISPOSITIONS,
  'waived_quality_shortfall',
  'waived_repeat_low_benefit'
]);
const DETECT_REQUEST_FINGERPRINT_VERSION = 'credit-request-v1';
const DETECT_REQUEST_FINGERPRINT_RE = /^[a-f0-9]{64}$/u;

const STRING_FIELDS = Object.freeze({
  engineVersion: 60,
  requestedMode: 20,
  requestStrength: 20,
  effectiveMode: 20,
  documentProfile: 40,
  profileGroup: 48,
  profileDecisionSource: 40,
  requestedDocumentProfile: 40,
  profileOverrideIgnoredReason: 48,
  tonePolicy: 30,
  targetRegister: 40,
  targetRegisterSource: 40,
  basicStyle: 20,
  niklAdvisorVersion: 40,
  humanizationDeliveryDepthBand: 24,
  effectExpectation: 20,
  effectNoticeCode: 80,
  effectStatus: 20,
  deliveryDecision: 32,
  fallbackFromMode: 24,
  billingDisposition: 48,
  auditPipelineErrorCode: 80,
  semanticValidationStatus: 24,
  structureAuditScope: 32,
  sourceLayoutStatus: 32,
  semanticValidationVersion: 48,
  semanticRelationContract: 48,
  semanticValidationMaterialization: 32,
  finalSemanticRevalidationReason: 80,
  finalSemanticStateReason: 80,
  finalSemanticRevalidationPriorStatus: 24,
  finalRelationPatchReason: 80,
  preFinalRelationPatchReason: 80,
  finalCandidateDigest: 64,
  sourceToolRequestRemovalCode: 80,
  rewriteEscalationEffort: 12
});

const NUMBER_FIELDS = Object.freeze([
  'semanticSourceIssueCount', 'finalRelationRestoredCount',
  'preFinalRelationPatchedCount',
  'finalSemanticRevalidationElapsedMs', 'finalSemanticRevalidationJudgeCallCount',
  'finalSemanticExpectedSections', 'finalSemanticStartedSections', 'finalSemanticCompletedSections', 'finalSemanticUnfinishedSections',
  'structureCredits', 'structurePlanningUsd', 'structureAttemptModelCalls',
  'schemaVersion', 'profileConfidence', 'detectedProfileConfidence', 'profileMargin', 'profileGroupMargin',
  'repairCount', 'chunkCount', 'logicalChunkCount', 'editableChunkCount', 'lockedChunkCount',
  'skippedChunkCount', 'transformedChunkCount', 'primaryApprovedModelChunkCount',
  'primaryEligibleChunkCount', 'primaryAttemptedChunkCount', 'primaryUnattemptedChunkCount',
  'approvedModelChunkCount', 'modelFailureChunkCount',
  'textualRefusalAttemptCount', 'textualRefusalChunkCount',
  'textualRefusalRecoveredChunkCount', 'textualRefusalUnrecoveredChunkCount',
  'humanizeCallCount', 'semanticModelCallCount', 'surfaceRetryCallCount', 'modelCallCount',
  'semanticSectionCount', 'semanticUnchangedRepairCount', 'fallbackCount', 'lengthRatio', 'substantiveEditRatio',
  'substantiveChangedSentenceRatio', 'substantiveCarryoverCount', 'substantiveCarryoverRatio',
  'substantiveCarryoverEligibleSentenceCount', 'substantiveCarryoverMaximum',
  'humanizationTargetCoverage', 'humanizationTargetDepthGap', 'structuralChangedSentenceCount', 'structuralChangedSentenceRatio',
  'materiallyRecastSentenceCount', 'effectiveStructuralChangedSentenceCount',
  'humanizationTargetParagraphCount', 'humanizationTargetChangedParagraphCount',
  'humanizationTargetParagraphCoverage', 'humanizationDepthEscalationAttemptCount',
  'humanizationNoEffectRetryAttemptCount', 'humanizationRoleRecoveryAttemptCount',
  'conservativeSentenceRetryAttemptCount', 'conservativeSentenceRetryModelCallCount',
  'conservativeSentenceRetryAppliedCount',
  'humanizationDepthRetryRejectedCount', 'rhetoricalRemediationTargetCount',
  'rhetoricalRemediationAchievedCount', 'rhetoricalRemediationCoverage',
  'macroDiscourseScore', 'macroDiscourseSourceParagraphCount',
  'macroDiscourseOutputParagraphCount', 'macroDiscourseRecomposedParagraphCount',
  'macroDiscourseRepeatedEvaluationReduction', 'macroDiscourseRoleOrderRetention',
  'macroDiscourseIdeaOrderRetention',
  'resumeRepetitionAuditVersion', 'resumeRepetitionThemeCount', 'resumeRepetitionSourcePairCount',
  'resumeRepetitionResidualPairCount', 'resumeRepetitionRequiredReduction',
  'resumeRepetitionAchievedReduction', 'resumeRepetitionCoverage',
  'sourceRedundancyAuditVersion', 'sourceRedundancySourceSentenceCount',
  'sourceRedundancyOutputSentenceCount', 'sourceRedundancyRequiredReduction',
  'sourceRedundancyAchievedReduction', 'sectionRecoverySelectedCount', 'sectionRecoveryAttemptCount',
  'sectionRecoveryTargetOnlyCount', 'sectionRecoveryAppliedCount', 'sectionRecoveryEscalationCount', 'sectionRecoveryRejectedAttemptCount',
  'sectionRecoveryMiniAppliedCount', 'sectionRecoveryEscalationAppliedCount',
  'fingerprintIntroducedCount', 'fingerprintRepairCount', 'fingerprintSourceRestoreCount', 'fingerprintShadowPositiveCount',
  'finalSourceIntegrityRestoreCount',
  'deterministicOmissionRestoreCount', 'confirmedCompoundClauseRestoreCount',
  'finalLayoutMidSentenceParagraphRepairCount',
  'deliveredIncompleteParagraphCount', 'deliveredNewIncompleteParagraphCount', 'deliveredMaxParagraphChars',
  'deliveredReadableParagraphCount', 'deliveredExplicitParagraphCount', 'deliveredMaxReadableParagraphChars',
  'deliveredOverlongReadableParagraphCount', 'deliveredWordSeamRepairCount',
  'unsupportedSpecificityAuditVersion', 'unsupportedSpecificityIssueCount',
  'unsupportedSpecificityRestorableCount', 'unsupportedSpecificityResidualCount',
  'unsupportedSpecificityRestoreCount', 'unsupportedSpecificityRemovalCount',
  'unsupportedSpecificityRestoreRejectedCount',
  'lexicalTransitionCount',
  'semanticRelationShiftCount', 'endingStyleIssueCount', 'endingStyleIntroducedOtherCount',
  'resumeClaimCount', 'resumeCoveredClaimCount', 'resumeCoverageRatio',
  'koreanDeterministicRepairCount', 'koreanRefinementRetryCount', 'koreanSourceRestoreCount', 'formalRegisterResidualCount',
  'quoteContentChangedCount', 'quoteIntegrityRestoreCount', 'quoteDuplicateReductionCount',
  'quoteMissingUniqueCount', 'sourceArtifactRemovedCount',
  'sourcePreflightNoticeCount', 'sectionPathErrorCount', 'signatureLineCount', 'fragmentIntegrityIssueCount',
  'clinicalStructureSignalCount', 'studentRecordFragmentCount',
  'functionalGreetingDuplicationCount', 'adjacentSemanticRepetitionCount',
  'directionalGrowthCollocationCount', 'finalGeneratedDedupeBlockCount',
  'finalGeneratedDedupeSentenceCount', 'chunkConcurrency',
  'inlineCodeTokenCount', 'inlineCodeRestoreFailureCount',
  'inlineCodeSpanCount', 'inlineCodeRestoredCount',
  'inlineMathSpanCount', 'inlineMathRestoredCount', 'inlineMathFixedPointRestoreCount',
  'paragraphRepairSourceCount', 'paragraphRepairBeforeCount',
  'paragraphRepairTargetCount', 'paragraphRepairAfterCount',
  'inlineLabelBodyRepairCount', 'inlineLabelBodyApplicableCount', 'inlineLabelBodySplitCount',
  'niklLocalCandidateCount', 'niklLocalAppliedCount', 'niklLocalErrorCount',
  'niklExternalProviderCount', 'niklExternalCandidateCount', 'niklExternalLookupCount',
  'niklExternalHitCount', 'niklExternalAppliedCount', 'niklExternalCacheHitCount',
  'niklExternalErrorCount', 'niklExternalTimeoutCount',
  'recoveryBudgetLimitUsd', 'recoveryBudgetSpentUsd', 'recoveryBudgetAttemptedCallCount',
  'recoveryBudgetSkippedCallCount', 'sectionRecoveryBudgetSkippedCount',
  'ordinalMarkerRestoreCount', 'sourceToolRequestRemovedChars',
  'endingPastVariantSourceLongCount', 'endingPastVariantSourceShortCount',
  'endingPastVariantOutputLongCount', 'endingPastVariantOutputShortCount',
  'endingPastVariantMixIntroduced', 'endingRegisterMixIntroduced', 'endingVariantMixIntroduced',
  'objectMarkedIntransitiveSourceCount', 'objectMarkedIntransitiveOutputCount', 'objectMarkedIntransitiveIntroducedCount',
  'leadingConnectorSourceCount', 'leadingConnectorRemovedCount', 'leadingConnectorReplacedCount',
  'wordEditRatio', 'wordReplacementRatio', 'sourceWordRetainedRatio',
  'deepRewrittenSentenceRatio', 'sentenceWordEditMedian',
  // v2.5.107 관측값. 작업 문서는 몇 시간 뒤 지워지므로 이력에 남겨야
  // 호출 시간 창과 배제 약화 복원이 실제로 얼마나 일어났는지 나중에 셀 수 있다.
  'callWindowCompletedCount', 'callWindowOverrunMs', 'callWindowMaxOverrunMs',
  'callHttpCeilingTimeoutCount', 'callAdmissionSkippedCount',
  'contrastRelationDetectedSentenceCount', 'contrastRelationRetryResolvedSentenceCount',
  'contrastRelationResidualSentenceCount', 'contrastRelationSourceRestoreSentenceCount',
  // v2.5.109 원문 정리 진단값(값이 있는 작업에만 남는다).
  'sourceInvisibleCharRemovedCount', 'sourceWideGapParagraphRestoreCount'
]);

// 건수 지도(코드 → 횟수)로 오는 관측값. 값이 온 작업에만 남긴다.
const CODE_COUNT_MAP_FIELDS = Object.freeze([
  'callAdmissionSkippedReasonCounts', 'contrastRelationPatternCounts'
]);

const BOOLEAN_FIELDS = Object.freeze([
  'finalSemanticRevalidationAttempted', 'finalSemanticRevalidationApplied',
  'finalRelationRestorationAttempted', 'finalRelationRestorationRejected',
  'finalRelationPatchAttempted',
  'preFinalRelationPatchAttempted',
  'structureApplied', 'structureFallback',
  'profileOverrideApplied', 'semanticJudgeRan', 'humanizationDepthPass',
  'humanizationOverallDepthPass', 'humanizationTargetDepthMet', 'humanizationEditTargetMet',
  'humanizationDepthSoftDelivered', 'humanizationNoBenefitDelivered',
  'clauseLevelStructuralAlternative', 'humanizationParagraphCoverageApplicable',
  'resumeRepetitionApplicable', 'resumeRepetitionPass',
  'sourceRedundancyApplicable', 'sourceRedundancyPass', 'endingStylePass',
  'resumeCoverageApplicable', 'resumeCoveragePass', 'koreanRefinementPass',
  'macroDiscourseApplicable', 'macroDiscoursePass', 'macroDiscourseOrderPass',
  'quoteIntegrityPass', 'quoteCountChanged', 'quoteDuplicateReductionBenign', 'sourcePreflightChanged',
  'structureSignaturePass', 'inlineLabelBodyLayoutPass', 'inlineCodeIntegrityPass', 'inlineMathIntegrityPass', 'inlineMathOrderPass', 'legalIntegrityPass',
  'finalGeneratedDedupeApplied', 'finalGeneratedDedupeRejected',
  'unsupportedSpecificityPass',
  'niklLocalResourceEnabled', 'niklLocalResourceApplied', 'niklExternalApiEnabled',
  'recoveryBudgetEnabled', 'recoveryBudgetEnforced', 'recoveryBudgetExhausted'
]);

const ARRAY_FIELDS = Object.freeze([
  'semanticRepairStyleWarnings',
  'fragmentIntegrityCodes',
  'safetyProfiles', 'riskFlags', 'humanizationDepthRetryRejectionCodes',
  'conservativeSentenceRetryRejectionCodes',
  'sectionRecoveryRejectionCodes', 'fingerprintShadowPositiveCodes',
  'lexicalTransitionCodes',
  'fingerprintIssueCodes', 'semanticRelationShiftFamilies', 'koreanRefinementIssueCodes',
  'sourcePreflightIssueCodes', 'sourceReviewWarningCodes', 'deliveryReasonCodes',
  'effectNoticeCodes', 'legalIntegrityIssueCodes', 'finalSourceIntegrityRestoreCodes',
  'unsupportedSpecificityRestoreRejectionCodes',
  'finalGeneratedDedupeReasonCodes',
  'recoveryBudgetSkippedCodes', 'sectionRecoveryBudgetSkippedCodes'
]);

function normalizeStoredHumanizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['blog', 'basic', '기본 피하기'].includes(mode)) return 'blog';
  if (['polish', 'preserve', '그대로 다듬기'].includes(mode)) return 'polish';
  return 'formal';
}

function compactCodeCountMap(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source).slice(0, 20).map(([code, count]) => [
    String(code || '').replace(/[^a-z0-9_.:-]/giu, '_').slice(0, 80),
    Math.max(0, Number(count) || 0)
  ]).filter(([code, count]) => code && count > 0));
}

function compactHistoryEngineMeta(meta = {}) {
  const compact = {
    ...require('../engine-gpt-prod/auditTrace').compactAuditTrace(meta),
    schemaVersion: Math.max(0, Number(meta.schemaVersion) || 2),
    documentProfile: String(meta.documentProfile || 'unknown').slice(0, 40),
    detectedDocumentProfile: String(meta.detectedDocumentProfile || meta.documentProfile || 'unknown').slice(0, 40),
    formatProfile: {
      length: String(meta.formatProfile?.length || 'standard').slice(0, 20),
      primary: String(meta.formatProfile?.primary || 'plain').slice(0, 30),
      flags: cleanStringArray(meta.formatProfile?.flags, 12, 40)
    },
    retryCounts: compactCodeCountMap(meta.retryCounts),
    sectionRecoveryRejectionCodeCounts: compactCodeCountMap(meta.sectionRecoveryRejectionCodeCounts)
  };
  for (const [field, limit] of Object.entries(STRING_FIELDS)) {
    if (meta[field] != null) compact[field] = String(meta[field]).slice(0, limit);
  }
  if (['verified_pass', 'verified_fail', 'incomplete', 'uncertain', 'stale', 'unconfirmed', 'not_run',
    'confirmation_pending'].includes(meta.finalSemanticState)) compact.finalSemanticState = meta.finalSemanticState;
  if (Number.isSafeInteger(meta.httpAttemptCount) && meta.httpAttemptCount >= 0) compact.httpAttemptCount = meta.httpAttemptCount;
  const finalSchedule = require('../engine-gpt-prod/semanticAuditSchedule').sanitizeScheduleDiagnostics(meta.finalSemanticScheduleDiagnostics);
  if (finalSchedule) compact.finalSemanticScheduleDiagnostics = finalSchedule;
  const omissionGate = require('../engine-gpt-prod/confirmedDeliveryIntegrity').sanitizeOmissionGateDiagnostics(meta.confirmedOmissionGate);
  if (omissionGate) compact.confirmedOmissionGate = omissionGate;
  const modelCost = require('../engine-gpt-prod/modelCostSummary').sanitize(meta.modelCost);
  if (modelCost) compact.modelCost = modelCost;
  for (const field of NUMBER_FIELDS) {
    if (meta[field] == null) continue;
    const value = Number(meta[field]);
    compact[field] = Number.isFinite(value) ? Math.max(0, value) : null;
  }
  for (const field of CODE_COUNT_MAP_FIELDS) {
    if (meta[field] != null) compact[field] = compactCodeCountMap(meta[field]);
  }
  for (const field of BOOLEAN_FIELDS) {
    // The legal audit emits null when it is not applicable. Keep that third
    // state (including absent legacy values) distinct from a failed audit.
    compact[field] = field === 'legalIntegrityPass'
      ? (typeof meta[field] === 'boolean' ? meta[field] : null)
      : meta[field] === true;
  }
  for (const field of ARRAY_FIELDS) compact[field] = cleanStringArray(meta[field], 20, 80);
  // Older jobs were never checked for fragment integrity. Absence must remain
  // unknown, not become a false failure or a fabricated pass on readback.
  if (typeof meta.fragmentIntegrityPass === 'boolean') compact.fragmentIntegrityPass = meta.fragmentIntegrityPass;
  for (const field of ['finalLayoutStructuralPass', 'finalLayoutReadabilityPass']) {
    if (typeof meta[field] === 'boolean') compact[field] = meta[field];
  }
  compact.fragmentIntegrityCodes = compact.fragmentIntegrityCodes.filter(value => [
    'introduced_orphan_ending', 'introduced_duplicate_predicate_tail', 'introduced_dependent_tail_owner_shift', 'introduced_furniture_body_fusion'
  ].includes(value));
  if (compact.fragmentIntegrityIssueCount != null) {
    compact.fragmentIntegrityIssueCount = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(compact.fragmentIntegrityIssueCount));
  }
  compact.humanizationDepthRetryRejectionCodes = compact.humanizationDepthRetryRejectionCodes
    .filter(value => [
      'candidate_unchanged',
      'safety_audit_failed',
      'depth_not_improved',
      'retry_error',
      'sentence_alignment_unavailable',
      'protected_or_structural_sentence',
      'model_reported_no_safe_change',
      'sentence_change_too_shallow',
      'sentence_change_too_large',
      'sentence_length_shift',
      'sentence_count_changed',
      'number_changed',
      'recovery_budget_exhausted'
    ].includes(value));
  if (meta.depthTugOfWar && typeof meta.depthTugOfWar === 'object') {
    compact.depthTugOfWar = {
      rounds: Math.max(0, Number(meta.depthTugOfWar.rounds) || 0),
      semanticRepairRounds: Math.max(0, Number(meta.depthTugOfWar.semanticRepairRounds) || 0),
      rejudgeCount: Math.max(0, Number(meta.depthTugOfWar.rejudgeCount) || 0),
      finalSide: ['depth', 'source'].includes(meta.depthTugOfWar.finalSide)
        ? meta.depthTugOfWar.finalSide
        : 'source',
      usdSpent: Math.max(0, Number(meta.depthTugOfWar.usdSpent) || 0)
    };
  }
  if (meta.pipelineFixedPoint && typeof meta.pipelineFixedPoint === 'object') {
    compact.pipelineFixedPoint = {
      safetyPass: meta.pipelineFixedPoint.safetyPass === true,
      depthHardMinimumPass: meta.pipelineFixedPoint.depthHardMinimumPass === true,
      structurePass: meta.pipelineFixedPoint.structurePass === true,
      quotePass: meta.pipelineFixedPoint.quotePass === true,
      inlineCodePass: meta.pipelineFixedPoint.inlineCodePass === true,
      reasonCodes: cleanStringArray(meta.pipelineFixedPoint.reasonCodes, 12, 80)
    };
  }
  compact.recoveryBudgetStageUsageUsd = compactCodeCountMap(meta.recoveryBudgetStageUsageUsd);
  if (!['normal', 'limited'].includes(compact.effectExpectation)) compact.effectExpectation = 'normal';
  if (!HISTORY_BILLING_DISPOSITIONS.has(compact.billingDisposition)) compact.billingDisposition = '';
  return compact;
}

function cleanStringArray(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || '').slice(0, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function detectHistoryBindingMatches(row, { needed, requestPayloadFingerprint }) {
  return row?.type === 'detect'
    && Math.max(0, Math.floor(Number(row?.credits) || 0)) === Math.max(0, Math.floor(Number(needed) || 0))
    && row?.requestPayloadFingerprintVersion === DETECT_REQUEST_FINGERPRINT_VERSION
    && row?.requestPayloadFingerprint === requestPayloadFingerprint;
}

function detectIdempotencyError() {
  return Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), {
    code: 'IDEMPOTENCY_KEY_REUSED',
    status: 409
  });
}

// 감지 응답 캐시는 요청 캐시와 같은 codec을 쓴다. 500KB 이하는 기존 plain 맵 그대로,
// 초과분만 압축해 inputText 등 나머지 필드와 함께 문서 한도 안에 둔다.
const DETECT_RESPONSE_CACHE_ENCODED_MAX_BYTES = 700_000;
const HISTORY_DOCUMENT_MAX_BYTES = codec.DOCUMENT_MAX_BYTES;

function storedDetectResponseCache(row) {
  return codec.decode({
    plain: row?.detectResponseCache,
    encoded: row?.detectResponseCacheEncoded
  }, { encodedMaxBytes: DETECT_RESPONSE_CACHE_ENCODED_MAX_BYTES });
}

async function detectResponseCacheFields(value) {
  if (!value || typeof value !== 'object') return {};
  // JSON은 500KB 이하여도 숫자가 많은 결과는 plain 맵이 압축본 한도보다 커진다. 그런 결과만 압축본으로 둔다.
  const packed = await codec.encode(value, {
    encodedMaxBytes: DETECT_RESPONSE_CACHE_ENCODED_MAX_BYTES,
    inlineStoredMaxBytes: DETECT_RESPONSE_CACHE_ENCODED_MAX_BYTES
  });
  return packed.encoded ? { detectResponseCacheEncoded: packed.encoded } : { detectResponseCache: packed.inline };
}

const HISTORY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
// 차감·잔액·첫 사용 기록은 최초 요청의 영수증이다. 다시 여는 화면에는 싣지 않는다.
const DETECT_RECEIPT_FIELDS = Object.freeze(['charged', 'remainingCredits', 'activation', 'idempotentReplay']);

function historyReportError(code, status, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function displayedScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

// 저장된 감지 결과 화면을 본인 이력에서만 되읽는다. 읽기 전용이며 모델·과금·이력 쓰기를 거치지 않는다.
// 경로가 인증된 uid 아래로 고정되므로 다른 계정의 기록 번호는 없는 기록과 구분되지 않는다.
async function readDetectHistoryReport({ uid, historyId, store = db }) {
  const id = typeof historyId === 'string' ? historyId : '';
  if (!uid || !HISTORY_ID_RE.test(id)) throw historyReportError('HISTORY_ID_INVALID', 400);
  if (!store) throw historyReportError('HISTORY_READ_UNAVAILABLE', 503, true);
  let snapshot;
  try {
    snapshot = await store.collection('users').doc(uid).collection('history').doc(id).get();
  } catch (cause) {
    throw Object.assign(historyReportError('HISTORY_READ_UNAVAILABLE', 503, true), { cause });
  }
  if (!snapshot.exists) throw historyReportError('HISTORY_NOT_FOUND', 404);
  const row = snapshot.data() || {};
  if (row.type !== 'detect' || !(row.detectResponseCache || row.detectResponseCacheEncoded)) {
    throw historyReportError('DETECT_REPORT_NOT_SAVED', 404);
  }
  let report;
  try {
    report = storedDetectResponseCache(row);
  } catch (error) {
    throw historyReportError(error?.code === 'DETECT_RESPONSE_CACHE_TOO_LARGE'
      ? 'DETECT_REPORT_TOO_LARGE' : 'DETECT_REPORT_UNREADABLE', 422);
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw historyReportError('DETECT_REPORT_UNREADABLE', 422);
  }
  // 화면이 확인하는 조건(점수·감지기 버전·원문)을 서버에서도 먼저 본다. 어긋난 보관본은 내보내지 않는다.
  const score = displayedScore(row.probability);
  const input = typeof row.inputText === 'string' ? row.inputText : '';
  if (report.ok !== true || score === null || displayedScore(report.probability) !== score
      || (row.detectorVersion && report.detectorVersion !== row.detectorVersion)
      || !input.trim() || (report.inputText && report.inputText !== input)
      || (row.detectInputHash && row.detectInputHash !== sourceScores.inputHash(input))) {
    throw historyReportError('DETECT_REPORT_MISMATCH', 409);
  }
  for (const field of DETECT_RECEIPT_FIELDS) delete report[field];
  return { id, report };
}

async function getDetectHistoryIdempotency({ uid, requestId, needed, requestPayloadFingerprint }) {
  if (!db || !uid || !requestId) return { state: 'NOT_FOUND' };
  if (!DETECT_REQUEST_FINGERPRINT_RE.test(String(requestPayloadFingerprint || ''))) {
    return { state: 'MISMATCH' };
  }
  let snapshot;
  try {
    snapshot = await db.collection('users').doc(uid).collection('history').doc(requestId).get();
  } catch (error) {
    return { state: 'UNAVAILABLE', error };
  }
  if (!snapshot.exists) return { state: 'NOT_FOUND' };
  const row = snapshot.data() || {};
  if (!detectHistoryBindingMatches(row, { needed, requestPayloadFingerprint })) {
    return { state: 'MISMATCH' };
  }
  // 읽을 수 없는 보관본은 저장소 장애가 아니다. 다시 읽어도 같으므로 재시도 대상(UNAVAILABLE)과 구분한다.
  try {
    const response = storedDetectResponseCache(row);
    return response ? { state: 'READY', response } : { state: 'INCOMPLETE' };
  } catch (error) {
    return { state: 'UNREADABLE', error };
  }
}

async function saveAnalyzeHistory({
  uid,
  requestId,
  opType,
  text,
  needed,
  result,
  mode,
  modeSource,
  engineMeta,
  engineVersion,
  auditScope,
  auditVersion,
  refinementAudit,
  qualityStatus,
  billingDisposition,
  qualityWarningCodes,
  sourceReviewWarningCodes,
  requestPayloadFingerprint,
  detectResponseCache,
  sourceProbability,
  sourceEvidence,
  sourceBand = null,
  sourceDetectorVersion = null
}) {
  if (!db) return;
  const isDetect = opType === 'detect';
  let cachedDetectResponse = false;
  const doc = {
    type: isDetect ? 'detect' : 'humanize',
    mode: isDetect ? 'detect' : normalizeStoredHumanizeMode(mode),
    inputText: text || '',
    credits: typeof needed === 'number' ? needed : 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    savedBy: 'server'
  };
  if (isDetect) {
    doc.detectInputHash = sourceScores.inputHash(text);
    const fingerprint = String(requestPayloadFingerprint || '');
    if (DETECT_REQUEST_FINGERPRINT_RE.test(fingerprint)) {
      doc.requestPayloadFingerprintVersion = DETECT_REQUEST_FINGERPRINT_VERSION;
      doc.requestPayloadFingerprint = fingerprint;
      Object.assign(doc, await detectResponseCacheFields(detectResponseCache));
      // 캐시와 나머지 필드를 합친 문서가 1MiB를 넘으면 Firestore가 쓰기를 통째로 거절한다.
      // 본문 필드가 채워진 뒤 같은 통제된 오류로 먼저 닫도록 표시해 둔다.
      cachedDetectResponse = !!(doc.detectResponseCache || doc.detectResponseCacheEncoded);
    }
    doc.probability = typeof result?.probability === 'number' ? result.probability : null;
    if (['low', 'moderate', 'high'].includes(result?.riskLevel)) doc.riskLevel = result.riskLevel;
    if (typeof result?.riskLabel === 'string') doc.riskLabel = result.riskLabel.slice(0, 40);
    if (['llm', 'cached_llm'].includes(result?.probSource)) doc.probSource = result.probSource;
    if (['low', 'medium', 'high'].includes(result?.confidence)) doc.detectConfidence = result.confidence;
    if (typeof result?.gptMeta?.selectedModel === 'string') {
      doc.detectModel = result.gptMeta.selectedModel.slice(0, 80);
    }
    if (typeof result?.gptMeta?.engine === 'string') {
      doc.detectorVersion = result.gptMeta.engine.slice(0, 80);
    }
    if (typeof result?.gptMeta?.escalated === 'boolean') {
      doc.detectEscalated = result.gptMeta.escalated;
    }
    if (typeof result?.gptMeta?.detectPromptVersion === 'string') {
      doc.detectPromptVersion = result.gptMeta.detectPromptVersion.slice(0, 80);
    }
    if (typeof result?.gptMeta?.detectCacheVariant === 'string') {
      doc.detectCacheVariant = result.gptMeta.detectCacheVariant.slice(0, 120);
    }
    if (typeof result?.gptMeta?.detectCacheHit === 'boolean') {
      doc.detectCacheHit = result.gptMeta.detectCacheHit;
    }
    if (['live', 'memory', 'firestore', 'inflight'].includes(result?.gptMeta?.detectCacheSource)) {
      doc.detectCacheSource = result.gptMeta.detectCacheSource;
    }
    if (typeof result?.rawProbability === 'number') doc.rawProbability = result.rawProbability;
    if (typeof result?.modelProbability === 'number') doc.modelProbability = result.modelProbability;
    const detectDiagnostics = require('./detectDiagnostics').sanitizeDiagnostics(result?.detectDiagnostics);
    if (detectDiagnostics) doc.detectDiagnostics = detectDiagnostics;
    const statisticalSupport = require('./detectStatisticalAssist').sanitizeSupport(result?.statisticalSupport);
    if (statisticalSupport) doc.detectStatisticalSupport = statisticalSupport;
    const statisticalReference = require('./detectStatisticalAssist').sanitizeReference(result?.statisticalReference);
    if (statisticalReference) doc.detectStatisticalReference = statisticalReference;
    const statisticalProvenance = require('./detectStatisticalAssist').projectProvenance(result);
    if (statisticalProvenance.statisticalStages) doc.detectStatisticalStages = statisticalProvenance.statisticalStages;
    if (statisticalProvenance.classifierReference) doc.detectClassifierReference = statisticalProvenance.classifierReference;
    const scoreAdjustment = require('./detectScorePresentation').sanitizeAdjustment(result?.scoreAdjustment, result?.probability);
    if (scoreAdjustment) {
      doc.scoreAdjustment = scoreAdjustment;
      doc.scoreKind = 'ai_style';
      doc.scoreLabel = 'AI식 문체 점수';
    }
    if (typeof result?.causeScoreAdjusted === 'boolean') doc.detectCauseScoreAdjusted = result.causeScoreAdjusted;
    if (typeof result?.causeScoreCeiling === 'number') doc.detectCauseScoreCeiling = result.causeScoreCeiling;
    if (typeof result?.causeScoreAdjustmentCode === 'string') {
      doc.detectCauseScoreAdjustmentCode = result.causeScoreAdjustmentCode.slice(0, 60);
    }
    if (typeof result?.documentProfile === 'string') doc.detectDocumentProfile = result.documentProfile.slice(0, 40);
    if (Number.isFinite(Number(result?.profileConfidence))) {
      doc.detectProfileConfidence = Math.max(0, Math.min(1, Number(result.profileConfidence)));
    }
    if (Number.isFinite(Number(result?.profileMargin))) {
      doc.detectProfileMargin = Math.max(0, Number(result.profileMargin));
    }
    if (typeof result?.profileAmbiguous === 'boolean') doc.detectProfileAmbiguous = result.profileAmbiguous;
    if (result?.probabilityCalibration) doc.probabilityCalibration = result.probabilityCalibration;
    if (result?.historyComparison) doc.historyComparison = result.historyComparison;
    const causeEvidence = require('./detectEvidenceHistory').historyEvidence(result?.signalEvidence, doc.inputText);
    if (causeEvidence.evidence.length) {
      doc.detectCauseEvidence = causeEvidence.evidence;
      doc.detectEvidenceProvenance = causeEvidence.provenance;
    }
    const causeAnalysis = result?.reportView?.causeAnalysis;
    if (['aligned', 'partial', 'limited'].includes(causeAnalysis?.status)) {
      doc.detectCauseAlignment = {
        version: String(causeAnalysis.version || '').slice(0, 40),
        status: causeAnalysis.status,
        coverage: Math.max(0, Math.min(1, Number(causeAnalysis.coverage) || 0)),
        codes: cleanStringArray(causeAnalysis.codes, 8, 60)
      };
    }
    doc.summary = result?.summary || '';
    doc.detail = result?.detail || '';
    doc.interpretation = storedDetectInterpretation(result || {}, doc.inputText);
  } else {
    doc.modeSource = modeSource === 'defaulted' ? 'defaulted' : 'provided';
    if (qualityStatus === 'clean' || qualityStatus === 'needs_review') doc.qualityStatus = qualityStatus;
    if (CURRENT_BILLING_DISPOSITIONS.has(billingDisposition)) doc.billingDisposition = billingDisposition;
    doc.qualityWarningCodes = cleanStringArray(qualityWarningCodes, 30, 80);
    doc.sourceReviewWarningCodes = cleanStringArray(sourceReviewWarningCodes, 30, 80);
    const lineageVersion = engineMeta?.engineVersion || engineVersion || refinementAudit?.parentEngineVersion;
    if (typeof lineageVersion === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(lineageVersion)) doc.engineVersion = lineageVersion;
    if (engineMeta && typeof engineMeta === 'object') doc.engineMeta = compactHistoryEngineMeta(engineMeta);
    // Firestore merge must not retain the old whole-document pass after a
    // paragraph-only rewrite explicitly invalidated its engine metadata.
    if (engineMeta === null) {
      doc.engineMeta = null;
      doc.historyLinkIntegrity = null;
      doc.calibrationTextHash = null;
    }
    if (auditScope === 'refined_paragraph' && Number.isSafeInteger(auditVersion) && auditVersion > 0) {
      doc.auditScope = auditScope;
      doc.auditVersion = auditVersion;
      doc.refinementAudit = require('./refinementAudit').sanitizeRefinementAudit(refinementAudit);
    } else if (auditScope === null) {
      doc.auditScope = null;
      doc.auditVersion = null;
      doc.refinementAudit = null;
    }
    doc.outputText = result?.outputText || '';
    // Clear stale merge fields as well as distinguishing missing scores from 0.
    // A handoff ceiling must be measured for this input by our server; the
    // browser scalar and old unsigned history values cannot establish it.
    doc.sourceProbability = null;
    doc.historySourceScoreIntegrity = null;
    {
      try {
        const verified = await sourceScores.resolveSourceScore({ db, uid, text, claimedScore: sourceProbability });
        const proof = sourceScores.signSourceScore(uid, doc.outputText, verified);
        if (proof) {
          doc.sourceProbability = verified;
          doc.historySourceScoreIntegrity = proof;
        }
      } catch {
        // Optional source evidence must not block saving or invent a ceiling.
      }
    }
    // 퍼널 계측 — 어느 감지 밴드(·감지기 버전)에서 넘어온 작업인지. 재생성·환불 집계에서 밴드별로 나눈다.
    if (['low', 'moderate', 'high'].includes(sourceBand)) doc.sourceBand = sourceBand;
    if (typeof sourceDetectorVersion === 'string' && /^[A-Za-z0-9._-]{1,40}$/u.test(sourceDetectorVersion)) {
      doc.sourceDetectorVersion = sourceDetectorVersion;
    }
    if (sourceEvidence && typeof sourceEvidence === 'object') {
      doc.sourceEvidence = {
        lived: Math.max(0, Math.round(Number(sourceEvidence.lived) || 0)),
        specific: Math.max(0, Math.round(Number(sourceEvidence.specific) || 0)),
        total: Math.max(0, Math.round(Number(sourceEvidence.total) || 0))
      };
    }
    const linkIntegrity = historyLinkIntegrity.sign(uid, doc.outputText, doc);
    if (linkIntegrity) {
      doc.historyLinkIntegrity = linkIntegrity;
      doc.calibrationTextHash = require('./detectCalibration').lookupHash(doc.outputText);
    }
    doc.humanSummary = result?.summary || '';
    doc.humanDetail = result?.detail || '';
  }
  if (cachedDetectResponse && codec.firestoreBytes(doc, HISTORY_DOCUMENT_MAX_BYTES) > HISTORY_DOCUMENT_MAX_BYTES) {
    throw Object.assign(new Error('DETECT_RESPONSE_CACHE_TOO_LARGE'), {
      code: 'DETECT_RESPONSE_CACHE_TOO_LARGE',
      status: 503
    });
  }
  const collection = db.collection('users').doc(uid).collection('history');
  const historyRef = requestId ? collection.doc(requestId) : collection.doc();
  const userRef = db.collection('users').doc(uid);
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  return db.runTransaction(async transaction => {
    const boundDetectHistory = isDetect
      && requestId
      && DETECT_REQUEST_FINGERPRINT_RE.test(String(requestPayloadFingerprint || ''));
    const [userSnapshot, deletionSnapshot, existingHistorySnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(deletionRef),
      boundDetectHistory ? transaction.get(historyRef) : Promise.resolve(null)
    ]);
    if (!userSnapshot.exists) return { saved: false, reason: 'user_missing' };
    if (deletionSnapshot.exists
      && accountDeletionBlocksWrites(deletionSnapshot.data() || {})) {
      return { saved: false, reason: 'account_deletion' };
    }
    if (existingHistorySnapshot?.exists) {
      const existing = existingHistorySnapshot.data() || {};
      if (!detectHistoryBindingMatches(existing, { needed, requestPayloadFingerprint })) {
        throw detectIdempotencyError();
      }
      // 읽을 수 없는 기존 보관본은 없는 것으로 보고, 같은 요청에 고정된 결과로 다시 채운다.
      let existingResponse = null;
      let unreadable = false;
      try {
        existingResponse = storedDetectResponseCache(existing);
      } catch {
        unreadable = true;
      }
      if (existingResponse) {
        return { saved: true, id: historyRef.id, duplicate: true, response: existingResponse };
      }
      if (unreadable) {
        // merge는 map 안의 이전 key를 남긴다. 손상된 쪽 표현을 지워 새 보관본만 읽히게 한다.
        for (const field of ['detectResponseCache', 'detectResponseCacheEncoded']) {
          if (!Object.hasOwn(doc, field)) doc[field] = admin.firestore.FieldValue.delete();
        }
      }
    }
    transaction.set(historyRef, doc, { merge: true });
    return { saved: true, id: historyRef.id };
  });
}

module.exports = {
  CURRENT_BILLING_DISPOSITIONS,
  HISTORY_BILLING_DISPOSITIONS,
  normalizeStoredHumanizeMode,
  compactCodeCountMap,
  compactHistoryEngineMeta,
  saveAnalyzeHistory,
  getDetectHistoryIdempotency,
  readDetectHistoryReport
};
