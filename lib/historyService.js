'use strict';

const { admin, db } = require('../config');
const historyLinkIntegrity = require('./historyLinkIntegrity');
const { accountDeletionBlocksWrites } = require('./accountActivityClaims');
const { normalizeSignalEvidence } = require('./detectSignalPolicy');
const sourceScores = require('./detectSourceScore');

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
  auditPipelineErrorCode: 80
});

const NUMBER_FIELDS = Object.freeze([
  'schemaVersion', 'profileConfidence', 'detectedProfileConfidence', 'profileMargin', 'profileGroupMargin',
  'repairCount', 'chunkCount', 'logicalChunkCount', 'editableChunkCount', 'lockedChunkCount',
  'skippedChunkCount', 'transformedChunkCount', 'primaryApprovedModelChunkCount',
  'approvedModelChunkCount', 'modelFailureChunkCount',
  'textualRefusalAttemptCount', 'textualRefusalChunkCount',
  'textualRefusalRecoveredChunkCount', 'textualRefusalUnrecoveredChunkCount',
  'humanizeCallCount', 'semanticModelCallCount', 'surfaceRetryCallCount', 'modelCallCount',
  'semanticSectionCount', 'fallbackCount', 'lengthRatio', 'substantiveEditRatio',
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
  'sourcePreflightNoticeCount', 'sectionPathErrorCount', 'signatureLineCount',
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
  'recoveryBudgetSkippedCallCount', 'sectionRecoveryBudgetSkippedCount'
]);

const BOOLEAN_FIELDS = Object.freeze([
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
  for (const field of NUMBER_FIELDS) {
    if (meta[field] == null) continue;
    const value = Number(meta[field]);
    compact[field] = Number.isFinite(value) ? Math.max(0, value) : null;
  }
  for (const field of BOOLEAN_FIELDS) compact[field] = meta[field] === true;
  for (const field of ARRAY_FIELDS) compact[field] = cleanStringArray(meta[field], 20, 80);
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

function safeDetectResponseCache(value) {
  if (!value || typeof value !== 'object') return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 500_000) {
    throw Object.assign(new Error('DETECT_RESPONSE_CACHE_TOO_LARGE'), {
      code: 'DETECT_RESPONSE_CACHE_TOO_LARGE',
      status: 503
    });
  }
  return JSON.parse(serialized);
}

async function getDetectHistoryIdempotency({ uid, requestId, needed, requestPayloadFingerprint }) {
  if (!db || !uid || !requestId) return { state: 'NOT_FOUND' };
  if (!DETECT_REQUEST_FINGERPRINT_RE.test(String(requestPayloadFingerprint || ''))) {
    return { state: 'MISMATCH' };
  }
  try {
    const snapshot = await db.collection('users').doc(uid).collection('history').doc(requestId).get();
    if (!snapshot.exists) return { state: 'NOT_FOUND' };
    const row = snapshot.data() || {};
    if (!detectHistoryBindingMatches(row, { needed, requestPayloadFingerprint })) {
      return { state: 'MISMATCH' };
    }
    const response = safeDetectResponseCache(row.detectResponseCache);
    return response ? { state: 'READY', response } : { state: 'INCOMPLETE' };
  } catch (error) {
    return { state: 'UNAVAILABLE', error };
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
  qualityStatus,
  billingDisposition,
  qualityWarningCodes,
  sourceReviewWarningCodes,
  requestPayloadFingerprint,
  detectResponseCache,
  sourceProbability,
  sourceEvidence
}) {
  if (!db) return;
  const isDetect = opType === 'detect';
  const doc = {
    type: isDetect ? 'detect' : 'humanize',
    mode: isDetect ? 'detect' : normalizeStoredHumanizeMode(mode),
    inputText: text || '',
    credits: typeof needed === 'number' ? needed : 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    savedBy: 'server'
  };
  if (isDetect) {
    const fingerprint = String(requestPayloadFingerprint || '');
    if (DETECT_REQUEST_FINGERPRINT_RE.test(fingerprint)) {
      doc.requestPayloadFingerprintVersion = DETECT_REQUEST_FINGERPRINT_VERSION;
      doc.requestPayloadFingerprint = fingerprint;
      const cachedResponse = safeDetectResponseCache(detectResponseCache);
      if (cachedResponse) doc.detectResponseCache = cachedResponse;
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
    const causeEvidence = normalizeSignalEvidence(result?.signalEvidence)
      .filter(item => item.format === 'structured')
      .map(item => ({ category: item.category, strength: item.strength, scope: item.scope }))
      .slice(0, 8);
    if (causeEvidence.length) doc.detectCauseEvidence = causeEvidence;
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
  } else {
    doc.modeSource = modeSource === 'defaulted' ? 'defaulted' : 'provided';
    if (qualityStatus === 'clean' || qualityStatus === 'needs_review') doc.qualityStatus = qualityStatus;
    if (CURRENT_BILLING_DISPOSITIONS.has(billingDisposition)) doc.billingDisposition = billingDisposition;
    doc.qualityWarningCodes = cleanStringArray(qualityWarningCodes, 30, 80);
    doc.sourceReviewWarningCodes = cleanStringArray(sourceReviewWarningCodes, 30, 80);
    if (engineMeta && typeof engineMeta === 'object') doc.engineMeta = compactHistoryEngineMeta(engineMeta);
    doc.outputText = result?.outputText || '';
    // Clear stale merge fields as well as distinguishing missing scores from 0.
    // A handoff ceiling must be measured for this input by our server; the
    // browser scalar and old unsigned history values cannot establish it.
    doc.sourceProbability = null;
    doc.historySourceScoreIntegrity = null;
    if (sourceScores.optionalScore(sourceProbability) !== null) {
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
    if (sourceEvidence && typeof sourceEvidence === 'object') {
      doc.sourceEvidence = {
        lived: Math.max(0, Math.round(Number(sourceEvidence.lived) || 0)),
        specific: Math.max(0, Math.round(Number(sourceEvidence.specific) || 0)),
        total: Math.max(0, Math.round(Number(sourceEvidence.total) || 0))
      };
    }
    const linkIntegrity = historyLinkIntegrity.sign(uid, doc.outputText, doc);
    if (linkIntegrity) doc.historyLinkIntegrity = linkIntegrity;
    doc.humanSummary = result?.summary || '';
    doc.humanDetail = result?.detail || '';
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
      const existingResponse = safeDetectResponseCache(existing.detectResponseCache);
      if (existingResponse) {
        return { saved: true, id: historyRef.id, duplicate: true, response: existingResponse };
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
  getDetectHistoryIdempotency
};
