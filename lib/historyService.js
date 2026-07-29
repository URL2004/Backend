'use strict';

const { admin, db } = require('../config');

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
  deliveryDecision: 32,
  billingDisposition: 48,
  auditPipelineErrorCode: 80
});

const NUMBER_FIELDS = Object.freeze([
  'schemaVersion', 'profileConfidence', 'detectedProfileConfidence', 'profileMargin', 'profileGroupMargin',
  'repairCount', 'chunkCount', 'logicalChunkCount', 'editableChunkCount', 'lockedChunkCount',
  'skippedChunkCount', 'transformedChunkCount', 'primaryApprovedModelChunkCount',
  'approvedModelChunkCount', 'modelFailureChunkCount',
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
  'lexicalTransitionCount',
  'semanticRelationShiftCount', 'endingStyleIssueCount', 'endingStyleIntroducedOtherCount',
  'resumeClaimCount', 'resumeCoveredClaimCount', 'resumeCoverageRatio',
  'koreanDeterministicRepairCount', 'koreanRefinementRetryCount', 'koreanSourceRestoreCount', 'formalRegisterResidualCount',
  'quoteContentChangedCount', 'quoteIntegrityRestoreCount', 'sourceArtifactRemovedCount',
  'sourcePreflightNoticeCount', 'sectionPathErrorCount', 'signatureLineCount',
  'clinicalStructureSignalCount', 'studentRecordFragmentCount',
  'functionalGreetingDuplicationCount', 'adjacentSemanticRepetitionCount',
  'directionalGrowthCollocationCount', 'chunkConcurrency',
  'inlineCodeTokenCount', 'inlineCodeRestoreFailureCount',
  'paragraphRepairSourceCount', 'paragraphRepairBeforeCount',
  'paragraphRepairTargetCount', 'paragraphRepairAfterCount',
  'niklLocalCandidateCount', 'niklLocalAppliedCount', 'niklLocalErrorCount',
  'niklExternalProviderCount', 'niklExternalCandidateCount', 'niklExternalLookupCount',
  'niklExternalHitCount', 'niklExternalAppliedCount', 'niklExternalCacheHitCount',
  'niklExternalErrorCount', 'niklExternalTimeoutCount',
  'recoveryBudgetLimitUsd', 'recoveryBudgetSpentUsd', 'recoveryBudgetAttemptedCallCount',
  'recoveryBudgetSkippedCallCount', 'sectionRecoveryBudgetSkippedCount'
]);

const BOOLEAN_FIELDS = Object.freeze([
  'profileOverrideApplied', 'semanticJudgeRan', 'humanizationDepthPass',
  'humanizationTargetDepthMet',
  'humanizationDepthSoftDelivered', 'humanizationNoBenefitDelivered',
  'clauseLevelStructuralAlternative', 'humanizationParagraphCoverageApplicable',
  'resumeRepetitionApplicable', 'resumeRepetitionPass',
  'sourceRedundancyApplicable', 'sourceRedundancyPass', 'endingStylePass',
  'resumeCoverageApplicable', 'resumeCoveragePass', 'koreanRefinementPass',
  'quoteIntegrityPass', 'quoteCountChanged', 'sourcePreflightChanged',
  'structureSignaturePass', 'inlineCodeIntegrityPass', 'legalIntegrityPass',
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
  sourceReviewWarningCodes
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
    doc.probability = typeof result?.probability === 'number' ? result.probability : null;
    if (['low', 'moderate', 'high'].includes(result?.riskLevel)) doc.riskLevel = result.riskLevel;
    if (typeof result?.riskLabel === 'string') doc.riskLabel = result.riskLabel.slice(0, 40);
    if (typeof result?.rawProbability === 'number') doc.rawProbability = result.rawProbability;
    if (result?.probabilityCalibration) doc.probabilityCalibration = result.probabilityCalibration;
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
    doc.humanSummary = result?.summary || '';
    doc.humanDetail = result?.detail || '';
  }
  const collection = db.collection('users').doc(uid).collection('history');
  if (requestId) await collection.doc(requestId).set(doc, { merge: true });
  else await collection.add(doc);
}

module.exports = {
  CURRENT_BILLING_DISPOSITIONS,
  HISTORY_BILLING_DISPOSITIONS,
  normalizeStoredHumanizeMode,
  compactCodeCountMap,
  compactHistoryEngineMeta,
  saveAnalyzeHistory
};
