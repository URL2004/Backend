'use strict';

const { computeEditMetrics, levenshteinDistance, splitSentences } = require('../engine/koreanText');
const { buildRemediationPlan, compareRemediationTargets } = require('./discourseAudit');
const { splitLogicalProseParagraphs } = require('./proseParagraphs');
const { alignSourceSentence } = require('./sentenceAlignment');
const resumeRepetitionAudit = require('./resumeRepetitionAudit');
const commercialSignals = require('./commercialSignals');
const sourceRedundancy = require('./sourceRedundancy');

const CONNECTOR_START = /^(?:또한|따라서|이에\s*따라|이러한|이를\s*통해|나아가|한편|결론적으로|즉|첫째|둘째|셋째|하지만|그러나|반면|결국)(?=$|[\s,])/u;
const STOCK_PHRASE = /(?:할\s*수\s*있(?:다|습니다)|볼\s*수\s*있(?:다|습니다)|필요가\s*있(?:다|습니다)|중요(?:하|한)\s*(?:의미|역할|요인)?|의미를\s*가진(?:다|다고)|긍정적인\s*영향|체계적으로\s*(?:정리|분석|관리|운영)|기반으로\s*(?:한|하여|한다|합니다)|핵심\s*인프라|전략적\s*이점)/u;
const ABSTRACT_WORD = /(?:중요|필요|효율|전략|체계|역할|경험|가치|역량|기반|영향|과정|측면|요인|문제|개선|확대|강화|가능성|방향성|의미)/gu;
const DENSE_CONNECTOR = /(?:또한|따라서|하지만|그러나|반면|결국|때문에|통해|위해|이에\s*따라)/gu;
const LOCK_TOKEN = /ZXQLOCK\d+QXZ/giu;
const PLAN_VERSION = 13;
const POLICY_VERSION = 'perceived-v2.5.24';
const PLAN_SIGNAL_SOURCE = 'deterministic_targets_input_risk';
const HARD_DELIVERY_EDIT_FLOOR = 0.04;
const HARD_DELIVERY_EDIT_FACTOR = 0.40;
const HARD_DELIVERY_SENTENCE_FACTOR = 0.50;

const CAUTIOUS_PROFILES = new Set([
  'academic_paper',
  'report_assignment',
  'clinical_record',
  'student_record_teacher',
  'student_self_assessment',
  'resume_application',
  'mail_notice',
  'short_phrase'
]);

// 최소선은 품질 경고 기준, 목표 범위는 모델이 실제로 노리는 체감 강도다.
// 별도의 hard delivery floor보다 낮은 무효 수준만 차단하고, 그 이상은 경고와 함께
// 결과를 전달한다. 기본은 눈에 띄는 재구성, 고급은 더 넓은 재구성을 전제로 한다.
const PERCEIVED_POLICY = Object.freeze({
  basic: Object.freeze({
    low: Object.freeze({ minEdit: 0.11, targetMin: 0.13, targetMax: 0.17, minSentence: 0.40, minTarget: 0.55 }),
    medium: Object.freeze({ minEdit: 0.13, targetMin: 0.16, targetMax: 0.20, minSentence: 0.50, minTarget: 0.70 }),
    high: Object.freeze({ minEdit: 0.15, targetMin: 0.18, targetMax: 0.22, minSentence: 0.60, minTarget: 0.80 })
  }),
  advanced: Object.freeze({
    low: Object.freeze({ minEdit: 0.15, targetMin: 0.18, targetMax: 0.22, minSentence: 0.55, minTarget: 0.70 }),
    medium: Object.freeze({ minEdit: 0.18, targetMin: 0.21, targetMax: 0.26, minSentence: 0.65, minTarget: 0.82 }),
    high: Object.freeze({ minEdit: 0.21, targetMin: 0.24, targetMax: 0.30, minSentence: 0.75, minTarget: 0.90 })
  })
});

const CREATIVE_POLICY = Object.freeze({
  low: Object.freeze({ minEdit: 0.04, targetMin: 0.05, targetMax: 0.08, minSentence: 0.16, minTarget: 0.30 }),
  medium: Object.freeze({ minEdit: 0.055, targetMin: 0.07, targetMax: 0.10, minSentence: 0.22, minTarget: 0.40 }),
  high: Object.freeze({ minEdit: 0.075, targetMin: 0.09, targetMax: 0.13, minSentence: 0.32, minTarget: 0.50 })
});

function buildHumanizationPlan(source, {
  requestStrength = 'basic',
  documentProfile = null,
  inputRisk = null
} = {}) {
  const rawStrength = String(requestStrength || 'basic');
  const strength = rawStrength === 'advanced' ? 'advanced' : (rawStrength === 'polish' ? 'polish' : 'basic');
  if (strength === 'polish') {
    return {
      version: PLAN_VERSION,
      policyVersion: POLICY_VERSION,
      applicable: false,
      requestStrength: strength,
      riskLevel: 'polish',
      signalSource: PLAN_SIGNAL_SOURCE,
      targetSentenceCount: 0,
      requiredChangedSentenceCount: 0,
      hardRequiredChangedSentenceCount: 0,
      minSubstantiveEditRatio: 0,
      hardMinimumSubstantiveEditRatio: 0,
      targetSubstantiveEditMin: 0,
      targetSubstantiveEditMax: 0,
      minTargetCoverage: 0,
      paragraphCoverageApplicable: false,
      eligibleParagraphCount: 0,
      targetParagraphCount: 0,
      requiredTargetChangedParagraphCount: 0,
      minTargetParagraphCoverage: 0,
      carryoverApplicable: false,
      maxSubstantiveCarryoverRatio: 1,
      requiredStructuralChangedSentenceCount: 0,
      minRemediationCoverage: 0,
      rhetoricalRemediationPlan: { applicable: false, targetCount: 0, categoryCount: 0, categories: [] },
      resumeRepetitionPlan: { version: resumeRepetitionAudit.VERSION, applicable: false },
      sourceRedundancyPlan: { version: sourceRedundancy.VERSION, applicable: false }
    };
  }

  const text = stripLockTokens(source);
  const sentences = meaningfulSentences(text);
  const profile = String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
  const rhetoricalRemediationPlan = buildRemediationPlan(text);
  const resumeRepetitionPlan = resumeRepetitionAudit.buildResumeRepetitionPlan(text, documentProfile);
  const sourceRedundancyPlan = sourceRedundancy.buildSourceRedundancyPlan(text, documentProfile);
  const commercialTargetPlan = commercialSignals.detectCommercialSentenceTargets(sentences, documentProfile);
  let target = mergeCommercialTargets(
    mergeSourceRedundancyTargets(
      mergeResumeRepetitionTargets(
        mergeRemediationTargets(detectTargetSentences(sentences), rhetoricalRemediationPlan),
        resumeRepetitionPlan
      ),
      sourceRedundancyPlan
    ),
    commercialTargetPlan
  );
  const sentenceCount = sentences.length;
  const targetRatio = sentenceCount ? target.indices.length / sentenceCount : 0;
  const abstractRiskRatio = finite(inputRisk?.abstractRiskRatio);
  // 자연성 shadow는 결과 선택·재시도·차단에 관여하면 안 된다. 깊이 강도는
  // 운영용 결정론 대상 문장과 원문 입력 위험 신호만으로 정한다.
  const riskScore = clamp(Math.max(
    targetRatio * 0.64,
    abstractRiskRatio * 0.34
  ));
  const riskLevel = riskScore >= 0.36 || targetRatio >= 0.62
    ? 'high'
    : (riskScore >= 0.18 || targetRatio >= 0.30 || target.indices.length >= 2 ? 'medium' : 'low');

  const creative = profile === 'creative' || documentProfile?.formatProfile?.flags?.includes?.('creative_lines') === true;
  const cautious = CAUTIOUS_PROFILES.has(profile);
  const sourceChars = normalizeSubstantive(text).length;
  const eligibleCarryoverSentenceCount = eligibleProseSentences(text).length;
  target = ensureBasicParagraphDistributionTargets(text, target, {
    strength,
    riskLevel,
    creative
  });
  const paragraphCoveragePlan = buildParagraphCoveragePlan(text, target.indices, {
    strength,
    creative,
    riskLevel,
    resumeRepetitionApplicable: resumeRepetitionPlan.applicable === true
  });

  const basePolicy = PERCEIVED_POLICY[strength][riskLevel];
  let minSubstantiveEditRatio = basePolicy.minEdit;
  let targetSubstantiveEditMin = basePolicy.targetMin;
  let targetSubstantiveEditMax = basePolicy.targetMax;
  let minChangedSentenceRatio = basePolicy.minSentence;
  let minTargetCoverage = basePolicy.minTarget;
  let structuralCoverageFactor = strength === 'advanced' ? 0.60 : 0.48;
  let minRemediationCoverage = rhetoricalRemediationPlan.targetCount > 0
    ? (strength === 'advanced' ? 0.65 : 0.50)
    : 0;

  // 민감 장르는 의미 안전 여유를 최소선에만 작게 주고, 모델이 실제로 노리는
  // 체감 목표는 일반 글과 거의 동일하게 유지한다. 이전의 일괄 3%p 완화는
  // 학술·지원서 대부분을 다듬기 수준에서 멈추게 했다.
  if (cautious) {
    minSubstantiveEditRatio = Math.max(strength === 'advanced' ? 0.13 : 0.09, minSubstantiveEditRatio - 0.02);
    targetSubstantiveEditMin = Math.max(minSubstantiveEditRatio + 0.02, targetSubstantiveEditMin - 0.01);
    targetSubstantiveEditMax = Math.max(targetSubstantiveEditMin + 0.03, targetSubstantiveEditMax - 0.01);
    minChangedSentenceRatio = Math.max(strength === 'advanced' ? 0.50 : 0.35, minChangedSentenceRatio - 0.05);
    // 대상 문장이 4개일 때 3개를 충분히 재구성한 강한 후보까지 불필요하게
    // 미달 처리하지 않도록 75% 경계는 유지한다.
    minTargetCoverage = Math.max(strength === 'advanced' ? 0.65 : 0.50, minTargetCoverage - 0.07);
    structuralCoverageFactor = strength === 'advanced' ? 0.56 : 0.44;
    minRemediationCoverage = rhetoricalRemediationPlan.targetCount > 0
      ? (strength === 'advanced' ? 0.60 : 0.46)
      : 0;
  }
  if (creative) {
    const creativePolicy = CREATIVE_POLICY[riskLevel];
    minSubstantiveEditRatio = creativePolicy.minEdit;
    targetSubstantiveEditMin = creativePolicy.targetMin;
    targetSubstantiveEditMax = creativePolicy.targetMax;
    minChangedSentenceRatio = creativePolicy.minSentence;
    minTargetCoverage = creativePolicy.minTarget;
    structuralCoverageFactor = 0;
    minRemediationCoverage = 0;
  }
  if (sourceChars <= 120) {
    const shortMin = creative ? 0.04 : (strength === 'advanced' ? 0.12 : 0.09);
    const shortTarget = creative ? 0.05 : (strength === 'advanced' ? 0.14 : 0.11);
    minSubstantiveEditRatio = Math.max(shortMin, minSubstantiveEditRatio);
    targetSubstantiveEditMin = Math.max(shortTarget, targetSubstantiveEditMin);
    targetSubstantiveEditMax = Math.max(targetSubstantiveEditMin + 0.02, targetSubstantiveEditMax);
    minChangedSentenceRatio = sentenceCount ? 1 / sentenceCount : 1;
  }

  const requiredChangedSentenceCount = sentenceCount
    ? Math.max(1, Math.min(sentenceCount, Math.ceil(sentenceCount * minChangedSentenceRatio)))
    : 0;
  const requiredTargetChangedCount = target.indices.length
    ? Math.max(1, Math.min(target.indices.length, Math.ceil(target.indices.length * minTargetCoverage)))
    : 0;
  const hardMinimumSubstantiveEditRatio = Math.min(
    minSubstantiveEditRatio,
    Math.max(HARD_DELIVERY_EDIT_FLOOR, minSubstantiveEditRatio * HARD_DELIVERY_EDIT_FACTOR)
  );
  const hardRequiredChangedSentenceCount = requiredChangedSentenceCount
    ? Math.max(1, Math.min(requiredChangedSentenceCount, Math.ceil(requiredChangedSentenceCount * HARD_DELIVERY_SENTENCE_FACTOR)))
    : 0;
  const requiredStructuralChangedSentenceCount = structuralCoverageFactor > 0 && requiredChangedSentenceCount > 0
    ? Math.max(1, Math.min(requiredChangedSentenceCount, Math.ceil(requiredChangedSentenceCount * structuralCoverageFactor)))
    : 0;
  // 제품의 2,000자 기준은 입력창과 과금에서 쓰는 공백 포함 글자 수와 맞춘다.
  // substantive 길이를 쓰면 2,000~2,400자대 장문이 정책에서 빠질 수 있다.
  const carryoverApplicable = !creative && text.length >= 2000 && eligibleCarryoverSentenceCount >= 12;
  const maxSubstantiveCarryoverRatio = carryoverApplicable
    ? Math.min(1, (strength === 'advanced' ? 0.20 : 0.30) + (cautious ? 0.05 : 0))
    : 1;

  return {
    version: PLAN_VERSION,
    policyVersion: POLICY_VERSION,
    applicable: sourceChars >= 30 && sentenceCount > 0,
    requestStrength: strength,
    profile,
    cautious,
    creative,
    riskLevel,
    riskScore: round4(riskScore),
    signalSource: PLAN_SIGNAL_SOURCE,
    sourceChars,
    sourceSentenceCount: sentenceCount,
    eligibleCarryoverSentenceCount,
    targetSentenceCount: target.indices.length,
    targetReasonCounts: target.reasonCounts,
    targetIndices: target.indices,
    requiredChangedSentenceCount,
    hardRequiredChangedSentenceCount,
    requiredTargetChangedCount,
    requiredStructuralChangedSentenceCount,
    minChangedSentenceRatio: round4(minChangedSentenceRatio),
    minSubstantiveEditRatio: round4(minSubstantiveEditRatio),
    hardMinimumSubstantiveEditRatio: round4(hardMinimumSubstantiveEditRatio),
    targetSubstantiveEditMin: round4(targetSubstantiveEditMin),
    targetSubstantiveEditMax: round4(targetSubstantiveEditMax),
    minTargetCoverage: round4(minTargetCoverage),
    ...paragraphCoveragePlan,
    carryoverApplicable,
    maxSubstantiveCarryoverRatio: round4(maxSubstantiveCarryoverRatio),
    minRemediationCoverage: round4(minRemediationCoverage),
    rhetoricalRemediationPlan,
    resumeRepetitionPlan,
    sourceRedundancyPlan,
    commercialTargetSentenceCount: Number(commercialTargetPlan.indices?.length || 0),
    commercialTargetReasonCounts: commercialTargetPlan.reasonCounts || {}
  };
}

/**
 * 문서 전체에서 계산한 문장 번호와 목표량을 실제 GPT 청크에 나눠 준다.
 *
 * 과거에는 각 청크가 자기 텍스트만 보고 low/medium/high와 목표 문장 수를
 * 독립적으로 정한 뒤, 병합 결과를 별도의 문서 전체 계획으로 채점했다. 문서
 * 전체에서만 드러나는 반복·균일성 대상이 청크 지시에서 빠지고 정책 band도
 * 달라져, 각 청크가 지시를 지켜도 최종 문서가 미달하는 구조였다.
 */
function buildDistributedHumanizationPlans(chunks, documentPlan, {
  requestStrength = 'basic',
  documentProfile = null,
  inputRisk = null,
  editableChunkIndices = null
} = {}) {
  const constrainedEditableChunks = editableChunkIndices instanceof Set;
  const rows = [];
  const targets = new Set((documentPlan?.targetIndices || []).filter(Number.isInteger));
  let sentenceCursor = 0;

  for (const [arrayIndex, chunk] of (chunks || []).entries()) {
    const text = String(chunk?.text || '');
    const locked = chunk?.locked === true;
    const primaryEditable = !locked && (
      !constrainedEditableChunks
      || editableChunkIndices.has(Number.isInteger(chunk?.index) ? chunk.index : arrayIndex)
    );
    const localPlan = buildHumanizationPlan(text, {
      requestStrength,
      documentProfile,
      inputRisk
    });
    const sourceSentenceCount = locked ? 0 : Number(localPlan.sourceSentenceCount || 0);
    const globalStart = sentenceCursor;
    const globalEnd = globalStart + sourceSentenceCount;
    const localTargetIndices = [];
    for (const index of targets) {
      if (index >= globalStart && index < globalEnd) localTargetIndices.push(index - globalStart);
    }
    if (!locked) sentenceCursor = globalEnd;
    const paragraphCoverage = buildParagraphCoveragePlan(text, localTargetIndices, {
      strength: localPlan.requestStrength,
      creative: localPlan.creative === true,
      riskLevel: documentPlan?.riskLevel || localPlan.riskLevel,
      resumeRepetitionApplicable: localPlan.resumeRepetitionPlan?.applicable === true
    });
    rows.push({
      arrayIndex,
      chunkIndex: Number.isInteger(chunk?.index) ? chunk.index : arrayIndex,
      locked,
      primaryEditable,
      localPlan,
      localTargetIndices,
      paragraphCoverage,
      sourceSentenceCount,
      globalStart,
      globalEnd
    });
  }

  const activeRows = rows.filter(row => row.primaryEditable && row.sourceSentenceCount > 0);
  const aligned = Number(documentPlan?.sourceSentenceCount || 0) === sentenceCursor;
  const changedMinimumTotal = Math.min(
    activeRows.reduce((sum, row) => sum + row.sourceSentenceCount, 0),
    Math.max(
      Number(documentPlan?.requiredChangedSentenceCount || 0),
      activeRows.length
    )
  );
  const targetRows = activeRows.filter(row => row.localTargetIndices.length > 0);
  const targetMinimumTotal = Math.min(
    targetRows.reduce((sum, row) => sum + row.localTargetIndices.length, 0),
    Math.max(
      Number(documentPlan?.requiredTargetChangedCount || 0),
      targetRows.length
    )
  );
  const paragraphRows = activeRows.filter(row => Number(row.paragraphCoverage.targetParagraphCount || 0) > 0);
  const paragraphMinimumTotal = Math.min(
    paragraphRows.reduce((sum, row) => sum + Number(row.paragraphCoverage.targetParagraphCount || 0), 0),
    Math.max(
      Number(documentPlan?.requiredTargetChangedParagraphCount || 0),
      paragraphRows.length
    )
  );
  const structuralTotal = Math.min(
    changedMinimumTotal,
    Number(documentPlan?.requiredStructuralChangedSentenceCount || 0)
  );

  const changedAllocations = distributeIntegerGoal(
    changedMinimumTotal,
    activeRows.map(row => row.sourceSentenceCount),
    activeRows.map(row => row.localTargetIndices.length * 2 + row.sourceSentenceCount)
  );
  const targetAllocations = distributeIntegerGoal(
    targetMinimumTotal,
    targetRows.map(row => row.localTargetIndices.length),
    targetRows.map(row => row.localTargetIndices.length)
  );
  const paragraphAllocations = distributeIntegerGoal(
    paragraphMinimumTotal,
    paragraphRows.map(row => Number(row.paragraphCoverage.targetParagraphCount || 0)),
    paragraphRows.map(row => Number(row.paragraphCoverage.targetParagraphCount || 0))
  );
  const structuralAllocations = distributeIntegerGoal(
    structuralTotal,
    activeRows.map(row => row.sourceSentenceCount),
    activeRows.map((row, index) => changedAllocations[index] || row.sourceSentenceCount)
  );
  const changedByChunk = new Map(activeRows.map((row, index) => [row.chunkIndex, changedAllocations[index] || 0]));
  const targetByChunk = new Map(targetRows.map((row, index) => [row.chunkIndex, targetAllocations[index] || 0]));
  const paragraphByChunk = new Map(paragraphRows.map((row, index) => [row.chunkIndex, paragraphAllocations[index] || 0]));
  const structuralByChunk = new Map(activeRows.map((row, index) => [row.chunkIndex, structuralAllocations[index] || 0]));
  const plans = new Map();

  for (const row of rows) {
    if (row.locked || row.sourceSentenceCount <= 0) {
      plans.set(row.chunkIndex, row.localPlan);
      continue;
    }
    if (!row.primaryEditable) {
      plans.set(row.chunkIndex, {
        ...row.localPlan,
        signalSource: `${documentPlan?.signalSource || PLAN_SIGNAL_SOURCE}:document_distributed_deferred`,
        targetIndices: row.localTargetIndices,
        targetSentenceCount: row.localTargetIndices.length,
        requiredChangedSentenceCount: 0,
        hardRequiredChangedSentenceCount: 0,
        requiredTargetChangedCount: 0,
        requiredStructuralChangedSentenceCount: 0,
        requiredTargetChangedParagraphCount: 0,
        distribution: {
          version: 1,
          aligned,
          primaryEditable: false,
          chunkIndex: row.chunkIndex,
          globalSentenceStart: row.globalStart,
          globalSentenceEnd: row.globalEnd,
          documentSourceSentenceCount: Number(documentPlan?.sourceSentenceCount || 0)
        }
      });
      continue;
    }
    const localTargetCount = row.localTargetIndices.length;
    const requiredChangedSentenceCount = changedByChunk.get(row.chunkIndex) || 0;
    const hardRequiredChangedSentenceCount = requiredChangedSentenceCount
      ? Math.max(1, Math.min(
        requiredChangedSentenceCount,
        Math.ceil(requiredChangedSentenceCount * HARD_DELIVERY_SENTENCE_FACTOR)
      ))
      : 0;
    plans.set(row.chunkIndex, {
      ...row.localPlan,
      riskLevel: documentPlan?.riskLevel || row.localPlan.riskLevel,
      riskScore: documentPlan?.riskScore ?? row.localPlan.riskScore,
      signalSource: `${documentPlan?.signalSource || PLAN_SIGNAL_SOURCE}:document_distributed`,
      targetIndices: row.localTargetIndices,
      targetSentenceCount: localTargetCount,
      requiredChangedSentenceCount,
      hardRequiredChangedSentenceCount,
      requiredTargetChangedCount: targetByChunk.get(row.chunkIndex) || 0,
      requiredStructuralChangedSentenceCount: structuralByChunk.get(row.chunkIndex) || 0,
      minChangedSentenceRatio: documentPlan?.minChangedSentenceRatio ?? row.localPlan.minChangedSentenceRatio,
      minSubstantiveEditRatio: documentPlan?.minSubstantiveEditRatio ?? row.localPlan.minSubstantiveEditRatio,
      hardMinimumSubstantiveEditRatio: documentPlan?.hardMinimumSubstantiveEditRatio
        ?? row.localPlan.hardMinimumSubstantiveEditRatio,
      targetSubstantiveEditMin: documentPlan?.targetSubstantiveEditMin
        ?? row.localPlan.targetSubstantiveEditMin,
      targetSubstantiveEditMax: documentPlan?.targetSubstantiveEditMax
        ?? row.localPlan.targetSubstantiveEditMax,
      minTargetCoverage: documentPlan?.minTargetCoverage ?? row.localPlan.minTargetCoverage,
      ...row.paragraphCoverage,
      requiredTargetChangedParagraphCount: paragraphByChunk.get(row.chunkIndex) || 0,
      distribution: {
        version: 1,
        aligned,
        primaryEditable: true,
        chunkIndex: row.chunkIndex,
        globalSentenceStart: row.globalStart,
        globalSentenceEnd: row.globalEnd,
        documentSourceSentenceCount: Number(documentPlan?.sourceSentenceCount || 0),
        documentRequiredChangedSentenceCount: Number(documentPlan?.requiredChangedSentenceCount || 0),
        distributedRequiredChangedSentenceCount: changedMinimumTotal,
        documentTargetSentenceCount: Number(documentPlan?.targetSentenceCount || 0),
        documentRequiredTargetChangedCount: Number(documentPlan?.requiredTargetChangedCount || 0)
      }
    });
  }

  return {
    version: 1,
    aligned,
    documentSourceSentenceCount: Number(documentPlan?.sourceSentenceCount || 0),
    mappedSourceSentenceCount: sentenceCursor,
    primaryEditableChunkCount: activeRows.length,
    plans
  };
}

function distributeIntegerGoal(total, capacities, weights) {
  const safeCapacities = (capacities || []).map(value => Math.max(0, Math.floor(Number(value) || 0)));
  const maximum = safeCapacities.reduce((sum, value) => sum + value, 0);
  let remaining = Math.max(0, Math.min(maximum, Math.floor(Number(total) || 0)));
  const result = safeCapacities.map(() => 0);
  if (!remaining || !result.length) return result;
  const safeWeights = (weights || []).map((value, index) => (
    safeCapacities[index] > 0 ? Math.max(0, Number(value) || 0) : 0
  ));
  while (remaining > 0) {
    let selected = -1;
    let selectedScore = -1;
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] >= safeCapacities[index]) continue;
      const weight = safeWeights[index] || safeCapacities[index] || 1;
      const score = weight / (result[index] + 1);
      if (score > selectedScore) {
        selected = index;
        selectedScore = score;
      }
    }
    if (selected < 0) break;
    result[selected] += 1;
    remaining -= 1;
  }
  return result;
}

function evaluateHumanizationDepth(source, output, planOrOptions = {}) {
  const plan = Number(planOrOptions?.version) >= 1
    ? planOrOptions
    : buildHumanizationPlan(source, planOrOptions);
  const metrics = measureSubstantiveEdit(source, output);
  if (!plan.applicable) return {
    version: PLAN_VERSION,
    applicable: false,
    pass: true,
    minimumEffectPass: true,
    effectStatus: 'not_applicable',
    userReviewRequired: false,
    userReviewReasons: [],
    shadowReasons: [],
    reasons: [],
    blockingReasons: [],
    plan: publicPlan(plan),
    metrics
  };

  const targetIndices = new Set(plan.targetIndices || []);
  const targetChangedCount = metrics.sentenceEdits.filter(row => targetIndices.has(row.index) && row.substantiveChanged).length;
  const targetCoverage = plan.targetSentenceCount ? targetChangedCount / plan.targetSentenceCount : 1;
  const materiallyRecastSentenceCount = metrics.sentenceEdits
    .filter(row => row.substantiveChanged && Number(row.ratio || 0) >= 0.11)
    .length;
  const targetParagraphIndices = new Set((plan.targetParagraphIndices || []).filter(Number.isInteger));
  const targetChangedParagraphIndices = new Set(metrics.sentenceEdits
    .filter(row => row.substantiveChanged
      && targetParagraphIndices.has(row.sourceParagraphIndex))
    .map(row => row.sourceParagraphIndex));
  const targetChangedParagraphCount = targetChangedParagraphIndices.size;
  const targetParagraphCoverage = Number(plan.targetParagraphCount || 0) > 0
    ? targetChangedParagraphCount / Number(plan.targetParagraphCount)
    : 1;
  const untouchedTargetParagraphIndices = [...targetParagraphIndices]
    .filter(index => !targetChangedParagraphIndices.has(index));
  const reasons = [];
  if (metrics.substantiveEditRatio + 1e-9 < plan.minSubstantiveEditRatio) reasons.push('substantive_edit_ratio_low');
  if (metrics.substantiveChangedSentenceCount < plan.requiredChangedSentenceCount) reasons.push('substantive_sentence_coverage_low');
  if (plan.requiredTargetChangedCount > 0 && targetChangedCount < plan.requiredTargetChangedCount) reasons.push('risk_target_coverage_low');
  const requiredStructuralCount = Number(plan.requiredStructuralChangedSentenceCount || 0);
  // 기본 결과가 어순 역전이나 쉼표 변화는 없더라도 여러 문장을 절 단위로
  // 충분히 다시 썼다면 구조 0건 하나만으로 미달 처리하지 않는다. 고급은
  // 실제 구조 변화 기준을 그대로 유지한다.
  const clauseLevelStructuralAlternative = plan.requestStrength === 'basic'
    && requiredStructuralCount > 0
    && metrics.substantiveEditRatio + 1e-9 >= Number(plan.minSubstantiveEditRatio || 0)
    && metrics.substantiveChangedSentenceCount >= Number(plan.requiredChangedSentenceCount || 0)
    && targetCoverage + 1e-9 >= Number(plan.minTargetCoverage || 0)
    && materiallyRecastSentenceCount >= requiredStructuralCount;
  const effectiveStructuralChangedSentenceCount = clauseLevelStructuralAlternative
    ? Math.max(metrics.structurallyChangedSentenceCount, materiallyRecastSentenceCount)
    : metrics.structurallyChangedSentenceCount;
  if (requiredStructuralCount > 0
      && effectiveStructuralChangedSentenceCount < requiredStructuralCount) {
    reasons.push('structural_rewrite_coverage_low');
  }
  if (plan.paragraphCoverageApplicable === true
      && targetChangedParagraphCount < Number(plan.requiredTargetChangedParagraphCount || 0)) {
    reasons.push('paragraph_rewrite_coverage_low');
  }
  if (plan.carryoverApplicable === true
      && metrics.substantiveCarryoverRatio > Number(plan.maxSubstantiveCarryoverRatio || 1) + 1e-9) {
    reasons.push('substantive_carryover_high');
  }
  const remediation = compareRemediationTargets(source, output, plan.rhetoricalRemediationPlan || null);
  if (Number(plan.minRemediationCoverage || 0) > 0
      && remediation.coverage + 1e-9 < Number(plan.minRemediationCoverage)) {
    reasons.push('rhetorical_remediation_low');
  }
  const resumeRepetition = resumeRepetitionAudit.compareResumeRepetition(output, plan.resumeRepetitionPlan || null);
  if (resumeRepetition.applicable === true && resumeRepetition.pass !== true) {
    reasons.push('resume_semantic_repetition_low');
  }
  const sourceRedundancyReport = sourceRedundancy.compareSourceRedundancy(
    output,
    plan.sourceRedundancyPlan || null
  );
  if (sourceRedundancyReport.applicable === true && sourceRedundancyReport.pass !== true) {
    reasons.push('source_semantic_redundancy_low');
  }
  if (metrics.trivialOnly) reasons.push('punctuation_or_surface_only');
  const hardMinimumEdit = Number(plan.hardMinimumSubstantiveEditRatio ?? Math.max(
    HARD_DELIVERY_EDIT_FLOOR,
    Number(plan.minSubstantiveEditRatio || 0) * HARD_DELIVERY_EDIT_FACTOR
  ));
  const hardRequiredSentences = Number(plan.hardRequiredChangedSentenceCount ?? Math.max(
    1,
    Math.ceil(Number(plan.requiredChangedSentenceCount || 1) * HARD_DELIVERY_SENTENCE_FACTOR)
  ));
  const blockingReasons = [];
  if (metrics.substantiveEditRatio + 1e-9 < hardMinimumEdit) blockingReasons.push('substantive_effect_too_low');
  if (metrics.substantiveChangedSentenceCount < hardRequiredSentences) blockingReasons.push('substantive_sentence_effect_too_low');
  if (metrics.trivialOnly) blockingReasons.push('punctuation_or_surface_only');
  const targetDepthMet = metrics.substantiveEditRatio + 1e-9 >= Number(plan.targetSubstantiveEditMin || 0);
  const aboveTargetRange = Number(plan.targetSubstantiveEditMax || 0) > 0
    && metrics.substantiveEditRatio > Number(plan.targetSubstantiveEditMax) + 1e-9;
  const deliveryDepthBand = reasons.length
    ? 'below_minimum'
    : (aboveTargetRange ? 'above_target' : (targetDepthMet ? 'target' : 'minimum'));
  const reviewAssessment = assessDepthReview(reasons, blockingReasons, plan);

  return {
    version: PLAN_VERSION,
    applicable: true,
    pass: reasons.length === 0,
    minimumEffectPass: blockingReasons.length === 0,
    effectStatus: reviewAssessment.effectStatus,
    userReviewRequired: reviewAssessment.userReviewRequired,
    userReviewReasons: reviewAssessment.userReviewReasons,
    shadowReasons: reviewAssessment.shadowReasons,
    reasons,
    blockingReasons,
    plan: publicPlan(plan),
    metrics: {
      ...metrics,
      sentenceEdits: undefined,
      targetChangedCount,
      targetCoverage: round4(targetCoverage),
      materiallyRecastSentenceCount,
      effectiveStructuralChangedSentenceCount,
      clauseLevelStructuralAlternative,
      targetChangedParagraphCount,
      targetParagraphCoverage: round4(targetParagraphCoverage),
      untouchedTargetParagraphIndices,
      remediation,
      resumeRepetition,
      sourceRedundancy: sourceRedundancyReport,
      targetDepthMet,
      aboveTargetRange,
      minimumEffectPass: blockingReasons.length === 0,
      deliveryDepthBand
    }
  };
}

function humanizationCandidateScore(report) {
  if (!report?.applicable) return report?.pass === true ? 1 : 0;
  if (report.metrics?.trivialOnly) return 0;
  const plan = report.plan || {};
  const metrics = report.metrics || {};
  const editProgress = progress(metrics.substantiveEditRatio, plan.minSubstantiveEditRatio);
  const sentenceProgress = progress(metrics.substantiveChangedSentenceCount, plan.requiredChangedSentenceCount);
  const targetProgress = Number(plan.requiredTargetChangedCount || 0) > 0
    ? progress(metrics.targetChangedCount, plan.requiredTargetChangedCount)
    : 1;
  const structuralProgress = Number(plan.requiredStructuralChangedSentenceCount || 0) > 0
    ? progress(
        metrics.effectiveStructuralChangedSentenceCount ?? metrics.structurallyChangedSentenceCount,
        plan.requiredStructuralChangedSentenceCount
      )
    : 1;
  const paragraphProgress = plan.paragraphCoverageApplicable === true
    ? progress(metrics.targetChangedParagraphCount, plan.requiredTargetChangedParagraphCount)
    : 1;
  const remediationProgress = Number(plan.minRemediationCoverage || 0) > 0
    ? progress(metrics.remediation?.coverage, plan.minRemediationCoverage)
    : 1;
  const carryoverProgress = plan.carryoverApplicable === true
    ? (finite(metrics.substantiveCarryoverRatio) <= finite(plan.maxSubstantiveCarryoverRatio) ? 1 : 0)
    : 1;
  const baseScore = (editProgress * 0.32)
    + (sentenceProgress * 0.20)
    + (targetProgress * 0.14)
    + (structuralProgress * 0.10)
    + (paragraphProgress * 0.10)
    + (remediationProgress * 0.07)
    + (carryoverProgress * 0.07);
  let score = baseScore;
  if (metrics.sourceRedundancy?.applicable === true) {
    const redundancyProgress = progress(
      metrics.sourceRedundancy.achievedReduction,
      metrics.sourceRedundancy.requiredReduction
    );
    score = (score * 0.94) + (redundancyProgress * 0.06);
  }
  if (metrics.resumeRepetition?.applicable !== true) return round4(score);
  const repetitionProgress = progress(
    metrics.resumeRepetition.achievedReduction,
    metrics.resumeRepetition.requiredReduction
  );
  return round4((score * 0.90) + (repetitionProgress * 0.10));
}

function isBetterHumanizationCandidate(current, candidate) {
  if (!candidate?.applicable || candidate.metrics?.trivialOnly) return false;
  if (candidate.pass === true && current?.pass !== true) return true;
  const currentScore = humanizationCandidateScore(current);
  const candidateScore = humanizationCandidateScore(candidate);
  const currentEdit = finite(current?.metrics?.substantiveEditRatio);
  const candidateEdit = finite(candidate?.metrics?.substantiveEditRatio);
  const currentSentences = finite(current?.metrics?.substantiveChangedSentenceCount);
  const candidateSentences = finite(candidate?.metrics?.substantiveChangedSentenceCount);
  const currentStructural = finite(current?.metrics?.structurallyChangedSentenceCount);
  const candidateStructural = finite(candidate?.metrics?.structurallyChangedSentenceCount);
  const currentRemediation = finite(current?.metrics?.remediation?.coverage);
  const candidateRemediation = finite(candidate?.metrics?.remediation?.coverage);
  const currentParagraphs = finite(current?.metrics?.targetChangedParagraphCount);
  const candidateParagraphs = finite(candidate?.metrics?.targetChangedParagraphCount);
  const currentRepetition = finite(current?.metrics?.resumeRepetition?.achievedReduction);
  const candidateRepetition = finite(candidate?.metrics?.resumeRepetition?.achievedReduction);
  const currentSourceRedundancy = finite(current?.metrics?.sourceRedundancy?.achievedReduction);
  const candidateSourceRedundancy = finite(candidate?.metrics?.sourceRedundancy?.achievedReduction);
  const currentTargets = finite(current?.metrics?.targetChangedCount);
  const candidateTargets = finite(candidate?.metrics?.targetChangedCount);
  // 안전 감사를 통과한 국소 후보가 여러 번 누적될 수 있도록 1.5%p의
  // 순개선부터 채택한다. 단, 대상·문장·구조·문단 지표를 맞바꾸는 후보는
  // 허용하지 않아 변화량만 커지고 실제 품질은 떨어지는 회귀를 막는다.
  const noCoreRegression = candidateSentences >= currentSentences
    && candidateTargets >= currentTargets
    && candidateStructural >= currentStructural
    && candidateParagraphs >= currentParagraphs
    && candidateRemediation + 1e-9 >= currentRemediation;
  if (candidateScore >= currentScore + 0.015 && noCoreRegression) return true;
  if (candidate.metrics?.targetDepthMet === true
      && current?.metrics?.targetDepthMet !== true
      && candidateEdit >= currentEdit - 0.002) return true;
  if (candidateRepetition > currentRepetition && candidateEdit >= currentEdit - 0.005) return true;
  if (candidateSourceRedundancy > currentSourceRedundancy && candidateEdit >= currentEdit - 0.005) return true;
  if (candidateParagraphs > currentParagraphs && candidateEdit >= currentEdit - 0.005) return true;
  if (candidateStructural > currentStructural && candidateEdit >= currentEdit - 0.005) return true;
  if (candidateRemediation >= currentRemediation + 0.25 && candidateEdit >= currentEdit - 0.005) return true;
  return candidateEdit >= currentEdit + 0.015 && candidateSentences >= currentSentences;
}

function targetDepthGap(report) {
  if (!report?.applicable || report.metrics?.targetDepthMet === true) return 0;
  return round4(Math.max(
    0,
    Number(report.plan?.targetSubstantiveEditMin || 0)
      - Number(report.metrics?.substantiveEditRatio || 0)
  ));
}

function needsHumanizationRecovery(report, { targetTolerance = 0.01 } = {}) {
  if (!report?.applicable) return false;
  if (report.pass !== true) return true;
  return targetDepthGap(report) >= Math.max(0, Number(targetTolerance || 0));
}

function measureSubstantiveEdit(source, output) {
  const fromRaw = stripLockTokens(source);
  const toRaw = stripLockTokens(output);
  const fromLiteral = normalizeSubstantive(fromRaw);
  const toLiteral = normalizeSubstantive(toRaw);
  const from = normalizePerceivedSubstantive(fromRaw);
  const to = normalizePerceivedSubstantive(toRaw);
  const substantiveDistance = levenshteinDistance(from, to);
  const substantiveBase = Math.max(from.length, to.length, 1);
  const literalDistance = levenshteinDistance(fromLiteral, toLiteral);
  const literalBase = Math.max(fromLiteral.length, toLiteral.length, 1);
  const raw = computeEditMetrics(fromRaw, toRaw);
  const sourceSentences = meaningfulSentences(fromRaw);
  const outputSentences = meaningfulSentences(toRaw);
  const sentenceEdits = alignSentenceEdits(sourceSentences, outputSentences);
  const paragraphMap = buildSentenceParagraphMap(fromRaw);
  for (const row of sentenceEdits) {
    row.sourceParagraphIndex = Number.isInteger(paragraphMap.sentenceParagraphIndices[row.index])
      ? paragraphMap.sentenceParagraphIndices[row.index]
      : -1;
  }
  const substantiveChangedSentenceCount = sentenceEdits.filter(row => row.substantiveChanged).length;
  const surfaceOnlySentenceCount = sentenceEdits.filter(row => row.surfaceOnly).length;
  const substantiveChangedSentenceRatio = sourceSentences.length
    ? substantiveChangedSentenceCount / sourceSentences.length
    : 0;
  const substantiveEditRatio = Math.min(
    substantiveDistance / substantiveBase,
    literalDistance / literalBase
  );
  const structurallyChangedSentenceCount = sentenceEdits.filter(row => row.structuralChanged).length;
  const clauseBoundaryChangeCount = sentenceEdits.filter(row => row.clauseBoundaryChanged).length;
  const contentOrderChangeCount = sentenceEdits.filter(row => row.contentOrderChanged).length;
  const sentenceBoundaryDelta = Math.abs(sourceSentences.length - outputSentences.length);
  const structuralChangeCount = Math.max(
    structurallyChangedSentenceCount,
    sentenceBoundaryDelta > 0 ? Math.min(sourceSentences.length, sentenceBoundaryDelta) : 0
  );
  const carryover = measureSubstantiveCarryover(fromRaw, toRaw);
  const changedParagraphIndices = [...new Set(sentenceEdits
    .filter(row => row.substantiveChanged && row.sourceParagraphIndex >= 0)
    .map(row => row.sourceParagraphIndex))];
  return {
    rawCharEditRatio: round4(raw.charEditRatio),
    substantiveDistance,
    substantiveEditRatio: round4(substantiveEditRatio),
    literalNormalizedDistance: literalDistance,
    literalNormalizedEditRatio: round4(literalDistance / literalBase),
    substantiveChangedSentenceCount,
    surfaceOnlySentenceCount,
    substantiveChangedSentenceRatio: round4(substantiveChangedSentenceRatio),
    sourceSentenceCount: sourceSentences.length,
    outputSentenceCount: outputSentences.length,
    structurallyChangedSentenceCount: structuralChangeCount,
    structuralChangedSentenceRatio: round4(sourceSentences.length ? structuralChangeCount / sourceSentences.length : 0),
    clauseBoundaryChangeCount,
    contentOrderChangeCount,
    sentenceBoundaryDelta,
    sentenceBoundaryChanged: sentenceBoundaryDelta > 0,
    substantiveCarryoverCount: carryover.count,
    substantiveCarryoverRatio: carryover.ratio,
    substantiveCarryoverEligibleSentenceCount: carryover.eligibleSentenceCount,
    eligibleParagraphCount: paragraphMap.eligibleParagraphCount,
    substantiveChangedParagraphCount: changedParagraphIndices.length,
    substantiveChangedParagraphRatio: round4(paragraphMap.eligibleParagraphCount
      ? changedParagraphIndices.length / paragraphMap.eligibleParagraphCount
      : 0),
    trivialOnly: raw.charEditRatio > 0 && substantiveEditRatio < 0.012,
    sentenceEdits
  };
}

function buildHumanizationPromptBlock(plan) {
  if (!plan?.applicable) return '';
  const labels = {
    connector: '기계적으로 반복되는 접속어',
    stock_phrase: '상투적인 보고서 표현',
    abstract_density: '추상명사 과밀',
    dense_sentence: '과밀한 장문',
    repeated_ending: '연속된 동일 종결',
    repeated_opening: '반복되는 문장 시작',
    uniform_rhythm: '균일한 문장 호흡',
    commercial_promotional_hype: '과도한 추천·감탄 표현',
    commercial_call_to_action: '반복되는 행동 요청',
    commercial_absolute_claim: '절대적 서비스 주장',
    commercial_health_claim: '효능 단정 표현',
    commercial_offer_frame: '혜택 나열 중심 문장',
    source_semantic_redundancy: '원문 내 연속 설명 중복'
  };
  const reasons = Object.entries(plan.targetReasonCounts || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${labels[key] || key} ${count}곳`)
    .join(', ');
  const strengthLabel = plan.requestStrength === 'advanced' ? '고급' : '기본';
  const targetOrdinals = (plan.targetIndices || []).slice(0, 20).map(index => index + 1);
  return [
    '[실질 휴머나이징 계약]',
    '이 모드는 교정·다듬기가 아니다. 원문의 뜻과 사실은 그대로 두되, AI식으로 반복되는 어순·상투어·추상명사·접속 방식·균일한 호흡을 사람이 직접 쓴 문장처럼 다시 구성한다.',
    '띄어쓰기, 쉼표, 인용부호, 조사 한 곳, 단순 축약이나 동의어 한두 개만 바꾼 결과는 실패다.',
    `${strengthLabel} 강도는 서버가 결과에서 별도로 계산한다. 변화량을 맞추기 위해 새 설명·평가·결론을 붙이지 말고, 같은 주장 안의 절·어순·연결·호흡으로 차이를 만든다.`,
    plan.distribution
      ? `문서 전체 계획을 청크에 분배했다. 이 청크는 전체 ${plan.distribution.documentSourceSentenceCount}문장 중 ${plan.distribution.globalSentenceStart + 1}~${plan.distribution.globalSentenceEnd}번 범위이며, 아래 최소 개수는 이 청크가 맡은 몫이다.`
      : '',
    `원문 위험도=${plan.riskLevel}; 이미 자연스러운 문장은 남기고 아래 우선 대상 문장을 구조적으로 다시 쓴다.`,
    plan.targetSentenceCount
      ? `우선 대상 문장 번호=${targetOrdinals.join(',') || '서버선정'}${reasons ? `; 원인=${reasons}` : ''}. 문장 번호는 편집 위치일 뿐 새 문장을 만들라는 뜻이 아니다.`
      : '특정 위험 표현이 적더라도 일반 문장의 흐름과 어순을 국소적으로 재구성해 다듬기와 구분되는 결과를 만든다.',
    plan.sourceSentenceCount > 0
      ? `변화 분포 목표: 편집 가능한 일반 문장 ${plan.sourceSentenceCount}개 가운데 최소 ${plan.requiredChangedSentenceCount}개를 한 문단에 몰지 말고 고르게 재구성한다. 우선 대상이 이 수보다 적으면 잠기지 않은 일반 문장 중 기계적인 어순·연결·호흡이 남은 문장을 추가로 고른다.`
      : '',
    plan.targetSentenceCount > 0
      ? `우선 대상 이행 목표: 표시된 ${plan.targetSentenceCount}개 가운데 최소 ${plan.requiredTargetChangedCount}개는 단순 교정이 아니라 같은 뜻 안의 절 배치·주어 위치·연결·호흡을 실제로 다시 구성한다.`
      : '',
    plan.requiredStructuralChangedSentenceCount > 0
      ? `구조 변화 목표: 전체 수정 문장 중 최소 ${plan.requiredStructuralChangedSentenceCount}개는 동의어 치환에 머물지 않고 절 순서·내용어 순서·문장 경계 중 하나가 분명히 달라져야 한다.`
      : '',
    plan.paragraphCoverageApplicable === true
      ? `문단 분포 목표: 우선 대상이 있는 ${plan.targetParagraphCount}개 일반 산문 문단 가운데 최소 ${plan.requiredTargetChangedParagraphCount}개 문단에서 실질 변화를 만든다. 한 문단만 크게 고치고 나머지를 복사하지 않는다.`
      : '',
    '문장마다 억지로 다른 단어를 끼워 넣지 말고, 바꿀 문장은 충분히 바꾸며 이미 자연스러운 문장은 남긴다.',
    '변화량을 채우려고 “뒤·후·다음·이후” 같은 순차 접속 표현만 새로 반복하지 않는다. 같은 과업·근거 묶음은 핵심어 응집을 유지하고 실제 주제·역할이 바뀌는 곳에서만 문단을 나눈다.',
    '문장을 나누거나 합친 뒤에도 각 문장의 주어, 지시 대상, 연구 주체와 결론의 근거가 독립적으로 분명해야 한다.',
    plan.rhetoricalRemediationPlan?.targetCount > 0
      ? '원문 담화 계약에 표시된 정형 성찰·반복 결론·과도하게 완결된 인과 구조는 그대로 복사하지 말고, 사실을 삭제하지 않는 범위에서 직접적인 문장으로 풀어 쓴다.'
      : '',
    plan.resumeRepetitionPlan?.applicable === true
      ? '지원서에서 같은 지원 전제·진로 고민·탐색 의도가 여러 문단에 반복되면 동의어만 바꾸지 않는다. 첫 문단에는 지원 동기를 온전히 두고, 뒤 문단에서는 같은 전제를 짧게 받으면서 각 문단에 원래 있던 어려움·확인할 내용·실행 계획을 앞세운다. SOURCE에 없는 학교 프로그램, 관심 전공, 과거 경험은 만들지 않는다.'
      : '',
    plan.sourceRedundancyPlan?.applicable === true
      ? `원문에 같은 설명이 연속해서 되풀이된 구간 ${plan.sourceRedundancyPlan.repeatedRunCount}곳이 있다. 후반 반복 구간을 앞 구간과 동의어만 바꿔 다시 쓰지 말고, 원문에 있는 고유 사실·수치·전문 용어는 모두 남기면서 각 문단의 기능이 겹치지 않도록 한 번의 자연스러운 설명 흐름으로 재구성한다. 결정론적으로 문장을 삭제하지 말고 문맥 안에서 중복을 해소한다.`
      : '',
    Number(plan.commercialTargetSentenceCount || 0) > 0
      ? '후기·광고 혼합 글에서는 가격·할인·무료 제공·서비스 범위 같은 사실은 그대로 두고, 반복 감탄·과도한 추천·혜택 나열·행동 요청의 문장 구조를 직접적이고 덜 정형적으로 다시 쓴다. 원문 주장 강도를 임의로 보장이나 조건부 주장으로 바꾸지 않는다.'
      : '',
    '원문에 없는 경험·감정·수치·기관·인용·주장·예시는 절대 추가하지 않는다.'
  ].filter(Boolean).join('\n');
}

// 목표선은 회복 후보 선택과 운영 관측에는 계속 엄격하게 사용하되, 한 가지
// 세부 지표만 살짝 모자란 안전한 결과까지 모두 사용자 "검토 필요"로 올리지
// 않는다. 실제 체감 부족 가능성이 큰 복합 미달과 최소 효과 실패만 외부 경고다.
function assessDepthReview(reasons = [], blockingReasons = [], plan = {}) {
  const set = new Set(reasons || []);
  const hard = (blockingReasons || []).length > 0;
  const coreReasons = [
    'substantive_edit_ratio_low',
    'substantive_sentence_coverage_low'
  ].filter(code => set.has(code));
  const distributionReasons = [
    'risk_target_coverage_low',
    'structural_rewrite_coverage_low',
    'paragraph_rewrite_coverage_low'
  ].filter(code => set.has(code));
  const roleFailure = set.has('resume_semantic_repetition_low');
  const carryoverWithWeakCoverage = set.has('substantive_carryover_high')
    && (coreReasons.length > 0 || distributionReasons.length > 0);
  const combinedDepthFailure = coreReasons.length >= 2
    || (coreReasons.length >= 1 && distributionReasons.length >= 1)
    || (String(plan.requestStrength || '') === 'advanced'
      && distributionReasons.includes('structural_rewrite_coverage_low')
      && distributionReasons.includes('paragraph_rewrite_coverage_low'));
  const userReviewRequired = hard || roleFailure || carryoverWithWeakCoverage || combinedDepthFailure;
  const userReviewReasons = userReviewRequired
    ? [...new Set([
        ...(hard ? blockingReasons : []),
        ...(roleFailure ? ['resume_semantic_repetition_low'] : []),
        ...(carryoverWithWeakCoverage ? ['substantive_carryover_high'] : []),
        ...(combinedDepthFailure ? [...coreReasons, ...distributionReasons] : [])
      ])]
    : [];
  return {
    effectStatus: hard
      ? 'no_effect'
      : (reasons.length ? (userReviewRequired ? 'below_target_review' : 'below_target_shadow') : 'effective'),
    userReviewRequired,
    userReviewReasons,
    shadowReasons: (reasons || []).filter(code => !userReviewReasons.includes(code))
  };
}

function measureSubstantiveCarryover(source, output) {
  const sourceSentences = eligibleProseSentences(source);
  const outputSentences = eligibleProseSentences(output);
  const available = new Map();
  for (const sentence of outputSentences) {
    const key = normalizeCarryoverSentence(sentence);
    if (key) available.set(key, (available.get(key) || 0) + 1);
  }
  let count = 0;
  for (const sentence of sourceSentences) {
    const key = normalizeCarryoverSentence(sentence);
    if (!key || (available.get(key) || 0) <= 0) continue;
    count += 1;
    available.set(key, available.get(key) - 1);
  }
  return {
    count,
    ratio: round4(sourceSentences.length ? count / sourceSentences.length : 0),
    eligibleSentenceCount: sourceSentences.length
  };
}

function buildParagraphCoveragePlan(source, targetIndices, {
  strength = 'basic',
  creative = false,
  riskLevel = 'low',
  resumeRepetitionApplicable = false
} = {}) {
  const mapping = buildSentenceParagraphMap(source);
  const detectedTargetParagraphIndices = [...new Set((targetIndices || [])
    .map(index => mapping.sentenceParagraphIndices[index])
    .filter(index => Number.isInteger(index) && index >= 0))]
    .sort((a, b) => a - b);
  const targetParagraphIndices = detectedTargetParagraphIndices;
  const advancedOrResume = strength === 'advanced' || resumeRepetitionApplicable === true;
  const basicMultiParagraph = strength === 'basic'
    && mapping.eligibleParagraphCount >= 3
    && targetParagraphIndices.length >= 2;
  const paragraphCoverageApplicable = (advancedOrResume || basicMultiParagraph)
    && creative !== true
    && mapping.eligibleParagraphCount >= 2
    && targetParagraphIndices.length >= 2;
  const minTargetParagraphCoverage = paragraphCoverageApplicable
    ? (strength === 'advanced'
        ? (riskLevel === 'high' ? 1 : 0.75)
        : (strength === 'basic'
            ? (riskLevel === 'high' ? 0.67 : 0.50)
            : (riskLevel === 'high' ? 0.75 : 0.67)))
    : 0;
  const requiredTargetChangedParagraphCount = paragraphCoverageApplicable
    ? Math.max(2, Math.ceil(targetParagraphIndices.length * minTargetParagraphCoverage))
    : 0;
  return {
    paragraphCoverageApplicable,
    eligibleParagraphCount: mapping.eligibleParagraphCount,
    targetParagraphCount: targetParagraphIndices.length,
    targetParagraphIndices,
    requiredTargetChangedParagraphCount,
    minTargetParagraphCoverage: round4(minTargetParagraphCoverage)
  };
}

// 문단 수 자체가 아니라 일반 산문 문단의 편집 분포를 본다. 제목·목록·표·인용처럼
// 잠긴 단독 블록은 모수에서 제외하고, 라벨 행은 라벨 뒤 본문만 산문으로 센다.
// 각 문단을 따로 분리해도 splitSentences 순서는 문서 전체 순서와 같으므로 문장
// 인덱스를 모델 프롬프트의 문장 번호와 그대로 연결할 수 있다.
function buildSentenceParagraphMap(value) {
  const blocks = splitLogicalProseParagraphs(stripLockTokens(value));
  const sentenceParagraphIndices = [];
  let eligibleParagraphCount = 0;
  let references = false;
  for (const block of blocks) {
    const blockSentences = meaningfulSentences(block);
    const editableLines = [];
    for (const rawLine of block.split('\n')) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (/^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|References|Bibliography|Works\s+Cited)$/iu.test(line)) {
        references = true;
        continue;
      }
      if (references && /^(?:부록|Appendix)(?:\s|$)/iu.test(line)) references = false;
      if (references) continue;
      const labelBody = editableLabelBody(line);
      if (labelBody) editableLines.push(labelBody);
      else if (!isProtectedCarryoverLine(line)) editableLines.push(line);
    }
    const eligible = normalizeSubstantive(editableLines.join(' ')).length >= 8;
    const paragraphIndex = eligible ? eligibleParagraphCount++ : -1;
    for (let index = 0; index < blockSentences.length; index += 1) {
      sentenceParagraphIndices.push(paragraphIndex);
    }
  }
  return { sentenceParagraphIndices, eligibleParagraphCount };
}

function eligibleProseSentences(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const prose = [];
  let references = false;
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    if (/^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|References|Bibliography|Works\s+Cited)$/iu.test(line)) {
      references = true;
      continue;
    }
    if (references && /^(?:부록|Appendix)(?:\s|$)/iu.test(line)) references = false;
    if (references) continue;
    const labelBody = editableLabelBody(line);
    if (labelBody) {
      prose.push(labelBody);
      continue;
    }
    if (isProtectedCarryoverLine(line)) continue;
    prose.push(line);
  }
  return meaningfulSentences(prose.join('\n'));
}

function editableLabelBody(line) {
  const match = String(line || '').match(/^[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()（）-]{0,30}:\s*(\S[\s\S]*)$/u);
  if (!match || /^(?:https?|ftp|file|mailto):/iu.test(String(line || ''))) return '';
  return match[1].trim();
}

function isProtectedCarryoverLine(line) {
  if (LOCK_TOKEN.test(line)) {
    LOCK_TOKEN.lastIndex = 0;
    return true;
  }
  LOCK_TOKEN.lastIndex = 0;
  if (/^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d{1,3}[.)]|[①-⑳]|[A-Za-z][.)])\s+/u.test(line)) return true;
  if (/^>\s*\S/u.test(line) || /^\|.+\|$/u.test(line) || /\t/u.test(line)) return true;
  if (/^["'“‘「『《〈].+["'”’」』》〉]$/u.test(line) && line.length <= 180) return true;
  if (/^#{1,6}\s+/u.test(line)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?\s*\S/u.test(line) && line.length <= 140) return true;
  if (/^제\s*\d{1,3}\s*(?:장|절|항)(?:\s|$)/u.test(line)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S/u.test(line) && line.length <= 140) return true;
  if (/^[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()（）-]{0,30}:\s*\S/u.test(line)) return true;
  const numericCells = line.match(/-?\d+(?:\.\d+)?%?/gu) || [];
  return numericCells.length >= 4 && line.length <= 220;
}

function normalizeCarryoverSentence(value) {
  return stripLockTokens(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function classifyEffectExpectation(planOrSource, options = {}) {
  const plan = typeof planOrSource === 'string'
    ? buildHumanizationPlan(planOrSource, options)
    : (planOrSource || {});
  const targetRatio = Number(plan.sourceSentenceCount) > 0
    ? Number(plan.targetSentenceCount || 0) / Number(plan.sourceSentenceCount)
    : 0;
  const limited = plan.applicable === true
    && ['basic', 'advanced'].includes(String(plan.requestStrength || ''))
    && plan.riskLevel === 'low'
    && targetRatio <= 0.15 + 1e-9
    && Number(plan.rhetoricalRemediationPlan?.targetCount || 0) === 0;
  return {
    effectExpectation: limited ? 'limited' : 'normal',
    effectNoticeCode: limited ? 'LOW_RISK_SOURCE_LIMITED_EFFECT' : null,
    requiresEffectConfirmation: limited,
    targetSentenceRatio: round4(targetRatio)
  };
}

function alignSentenceEdits(sourceSentences, outputSentences) {
  if (!sourceSentences.length) return [];
  return sourceSentences.map((sentence, index) => {
    const sourceNorm = normalizePerceivedSubstantive(sentence);
    if (!outputSentences.length) {
      return { index, outputIndex: -1, distance: sourceNorm.length, ratio: 1, substantiveChanged: true };
    }
    const sentenceCountChanged = sourceSentences.length !== outputSentences.length;
    let alignment = alignSourceSentence(
      sentence,
      index,
      sourceSentences.length,
      outputSentences,
      {
        window: sentenceCountChanged ? 3 : 2,
        maxOutputGroup: sentenceCountChanged ? 2 : 1
      }
    );
    // 문장 수가 같아도 한 곳에서 분리되고 다른 곳에서 결합되면 전체 개수만
    // 보고는 알 수 없다. 단일 문장 정렬 신뢰도가 낮은 문장에만 1:2 후보를
    // 추가 탐색해, 모든 문장에 비싼 그룹 정렬을 수행하지 않는다.
    if (!sentenceCountChanged && Number(alignment?.score || 0) < 0.48) {
      alignment = alignSourceSentence(
        sentence,
        index,
        sourceSentences.length,
        outputSentences,
        { window: 2, maxOutputGroup: 2 }
      ) || alignment;
    }
    const outputSentence = alignment?.text || outputSentences[Math.min(index, outputSentences.length - 1)] || '';
    const outputNorm = normalizePerceivedSubstantive(outputSentence);
    const sourceLiteral = normalizeSubstantive(sentence);
    const outputLiteral = normalizeSubstantive(outputSentence);
    const distance = levenshteinDistance(sourceNorm, outputNorm);
    const base = Math.max(sourceNorm.length, outputNorm.length, 1);
    const perceivedRatio = distance / base;
    const literalDistance = levenshteinDistance(sourceLiteral, outputLiteral);
    const literalRatio = literalDistance / Math.max(sourceLiteral.length, outputLiteral.length, 1);
    const ratio = Math.min(perceivedRatio, literalRatio);
    const substantiveChanged = distance >= 3 && ratio >= 0.065;
    const structure = compareSentenceStructure(sentence, outputSentence, {
      substantiveChanged,
      editRatio: ratio,
      outputGroupSize: Number(alignment?.sentences?.length || 1)
    });
    return {
      index,
      outputIndex: Number(alignment?.start ?? 0),
      outputEndIndex: Number(alignment?.end ?? 1),
      alignmentScore: round4(alignment?.score || 0),
      distance,
      ratio: round4(ratio),
      literalDistance,
      literalRatio: round4(literalRatio),
      surfaceOnly: literalRatio >= 0.065 && perceivedRatio < 0.065,
      substantiveChanged,
      ...structure
    };
  });
}

function mergeRemediationTargets(target, remediationPlan) {
  const reasonsByIndex = new Map();
  const reasonCounts = { ...(target?.reasonCounts || {}) };
  for (const index of target?.indices || []) reasonsByIndex.set(index, new Set());
  for (const category of remediationPlan?.categories || []) {
    const reason = `source_rhetoric_${category.code}`;
    for (const ordinal of category.sentenceOrdinals || []) {
      const index = Number(ordinal) - 1;
      if (index < 0 || !Number.isFinite(index)) continue;
      if (!reasonsByIndex.has(index)) reasonsByIndex.set(index, new Set());
      reasonsByIndex.get(index).add(reason);
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  return { indices: [...reasonsByIndex.keys()].sort((a, b) => a - b), reasonCounts };
}

function mergeResumeRepetitionTargets(target, repetitionPlan) {
  if (repetitionPlan?.applicable !== true) return target;
  const indices = new Set((target?.indices || []).filter(Number.isInteger));
  let added = 0;
  for (const index of repetitionPlan.targetIndices || []) {
    if (!Number.isInteger(index) || index < 0) continue;
    if (!indices.has(index)) added += 1;
    indices.add(index);
  }
  const reasonCounts = { ...(target?.reasonCounts || {}) };
  reasonCounts.resume_semantic_repetition = Number(repetitionPlan.targetSentenceCount || added || 0);
  return { indices: [...indices].sort((a, b) => a - b), reasonCounts };
}

function ensureBasicParagraphDistributionTargets(source, target, {
  strength = 'basic',
  riskLevel = 'low',
  creative = false
} = {}) {
  if (strength !== 'basic' || creative === true) return target;
  const mapping = buildSentenceParagraphMap(source);
  if (mapping.eligibleParagraphCount < 3) return target;
  const indices = new Set((target?.indices || []).filter(Number.isInteger));
  const covered = new Set([...indices]
    .map(index => mapping.sentenceParagraphIndices[index])
    .filter(index => Number.isInteger(index) && index >= 0));
  const desiredParagraphCount = Math.max(
    2,
    Math.ceil(mapping.eligibleParagraphCount * (riskLevel === 'high' ? 0.67 : 0.50))
  );
  if (covered.size >= desiredParagraphCount) return target;

  const sentences = meaningfulSentences(source);
  let added = 0;
  for (let paragraphIndex = 0;
    paragraphIndex < mapping.eligibleParagraphCount && covered.size < desiredParagraphCount;
    paragraphIndex += 1) {
    if (covered.has(paragraphIndex)) continue;
    const candidates = sentences
      .map((sentence, sentenceIndex) => ({ sentence, sentenceIndex }))
      .filter(item => mapping.sentenceParagraphIndices[item.sentenceIndex] === paragraphIndex)
      .sort((a, b) => normalizeSubstantive(b.sentence).length - normalizeSubstantive(a.sentence).length);
    const selected = candidates[0];
    if (!selected) continue;
    indices.add(selected.sentenceIndex);
    covered.add(paragraphIndex);
    added += 1;
  }
  if (!added) return target;
  return {
    ...target,
    indices: [...indices].sort((a, b) => a - b),
    reasonCounts: {
      ...(target?.reasonCounts || {}),
      basic_paragraph_distribution: Number(target?.reasonCounts?.basic_paragraph_distribution || 0) + added
    }
  };
}

function mergeSourceRedundancyTargets(target, redundancyPlan) {
  if (redundancyPlan?.applicable !== true) return target;
  const indices = new Set((target?.indices || []).filter(Number.isInteger));
  for (const index of redundancyPlan.targetIndices || []) {
    if (Number.isInteger(index) && index >= 0) indices.add(index);
  }
  return {
    indices: [...indices].sort((left, right) => left - right),
    reasonCounts: {
      ...(target?.reasonCounts || {}),
      source_semantic_redundancy: Number(redundancyPlan.targetSentenceCount || 0)
    }
  };
}

function mergeCommercialTargets(target, commercialPlan) {
  if (commercialPlan?.applicable !== true) return target;
  const indices = new Set((target?.indices || []).filter(Number.isInteger));
  for (const index of commercialPlan.indices || []) {
    if (Number.isInteger(index) && index >= 0) indices.add(index);
  }
  return {
    indices: [...indices].sort((left, right) => left - right),
    reasonCounts: {
      ...(target?.reasonCounts || {}),
      ...(commercialPlan.reasonCounts || {})
    }
  };
}

function compareSentenceStructure(source, output, {
  substantiveChanged = false,
  editRatio = 0,
  outputGroupSize = 1
} = {}) {
  const before = String(source || '');
  const after = String(output || '');
  const beforeClause = clauseSignature(before);
  const afterClause = clauseSignature(after);
  const clauseBoundaryChanged = beforeClause.punctuation !== afterClause.punctuation
    || beforeClause.connectorSequence !== afterClause.connectorSequence
    || beforeClause.subordinateCount !== afterClause.subordinateCount;
  const orderChangeRatio = contentTokenOrderChange(before, after);
  const contentOrderChanged = orderChangeRatio >= 0.18;
  const beforeTokens = contentTokens(before);
  const afterTokens = contentTokens(after);
  const shared = intersectionCount(beforeTokens, afterTokens);
  const sharedRatio = Math.min(beforeTokens.length, afterTokens.length)
    ? shared / Math.min(beforeTokens.length, afterTokens.length)
    : 1;
  const deepRecast = substantiveChanged
    && Math.min(beforeTokens.length, afterTokens.length) >= 4
    && editRatio >= 0.14
    && sharedRatio < 0.58;
  const sentenceGroupChanged = substantiveChanged && Number(outputGroupSize || 1) > 1;
  return {
    clauseBoundaryChanged,
    contentOrderChanged,
    sentenceGroupChanged,
    contentOrderChangeRatio: round4(orderChangeRatio),
    sharedContentTokenRatio: round4(sharedRatio),
    structuralChanged: substantiveChanged
      && (clauseBoundaryChanged || contentOrderChanged || deepRecast || sentenceGroupChanged)
  };
}

function clauseSignature(value) {
  const text = String(value || '');
  const punctuation = (text.match(/[,;:，；：]/gu) || []).map(char => char === '，' ? ',' : char).join('');
  const connectors = text.match(/(?:그럼에도|반면에|따라서|그러므로|하지만|그러나|반면|한편|또한|결국|때문에|덕분에|이를\s*통해|이로\s*인해)/gu) || [];
  const subordinateCount = (text.match(/(?:지만|는데|면서|므로|기에|더라도|반면|때문에|덕분에|[가-힣]+[은한]\s*(?:뒤|후)|[가-힣]+하기\s*전에)/gu) || []).length;
  return {
    punctuation,
    connectorSequence: connectors.join('|'),
    subordinateCount
  };
}

function contentTokenOrderChange(source, output) {
  const before = contentTokens(source);
  const after = contentTokens(output);
  const afterPositions = new Map();
  after.forEach((token, index) => {
    if (!afterPositions.has(token)) afterPositions.set(token, index);
  });
  const sequence = before.filter(token => afterPositions.has(token)).map(token => afterPositions.get(token));
  if (sequence.length < 3) return 0;
  let inversions = 0;
  let pairs = 0;
  for (let left = 0; left < sequence.length; left += 1) {
    for (let right = left + 1; right < sequence.length; right += 1) {
      pairs += 1;
      if (sequence[left] > sequence[right]) inversions += 1;
    }
  }
  return pairs ? inversions / pairs : 0;
}

function contentTokens(value) {
  const stop = new Set(['그리고', '그러나', '하지만', '따라서', '또한', '이러한', '그러한', '것이다', '있습니다', '했습니다', '합니다']);
  return (String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}/gu) || [])
    .map(token => token.toLowerCase().replace(/(?:에서는|으로는|에게는|이라는|으로|에서|에게|보다|처럼|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u, ''))
    .filter(token => token.length >= 2 && !stop.has(token));
}

function intersectionCount(left, right) {
  const available = new Map();
  for (const token of right) available.set(token, (available.get(token) || 0) + 1);
  let count = 0;
  for (const token of left) {
    if ((available.get(token) || 0) <= 0) continue;
    count += 1;
    available.set(token, available.get(token) - 1);
  }
  return count;
}

function detectTargetSentences(sentences) {
  const reasonsByIndex = new Map();
  const add = (index, reason) => {
    if (!reasonsByIndex.has(index)) reasonsByIndex.set(index, new Set());
    reasonsByIndex.get(index).add(reason);
  };
  const lengths = sentences.map(sentence => normalizeSubstantive(sentence).length).filter(Boolean);
  const avg = mean(lengths);
  const cv = coefficientOfVariation(lengths);
  const openings = new Map();
  const endings = new Map();

  sentences.forEach((sentence, index) => {
    const clean = String(sentence || '').trim();
    if (CONNECTOR_START.test(clean)) add(index, 'connector');
    if (STOCK_PHRASE.test(clean)) add(index, 'stock_phrase');
    if ((clean.match(ABSTRACT_WORD) || []).length >= 2) add(index, 'abstract_density');
    if (normalizeSubstantive(clean).length >= Math.max(68, avg * 1.45)
        && ((clean.match(DENSE_CONNECTOR) || []).length >= 2 || (clean.match(/[,，]/gu) || []).length >= 3)) {
      add(index, 'dense_sentence');
    }
    const normalized = normalizeSubstantive(clean);
    const opening = normalized.slice(0, 8);
    const ending = normalized.slice(-6);
    if (opening.length >= 6) (openings.get(opening) || openings.set(opening, []).get(opening)).push(index);
    if (ending.length >= 4) (endings.get(ending) || endings.set(ending, []).get(ending)).push(index);
  });

  for (const rows of openings.values()) {
    if (rows.length < 2 || allExactSameSentences(sentences, rows)) continue;
    rows.forEach(index => add(index, 'repeated_opening'));
  }
  for (const rows of endings.values()) {
    if (rows.length < 3 || allExactSameSentences(sentences, rows)) continue;
    rows.forEach(index => add(index, 'repeated_ending'));
  }
  if (sentences.length >= 4 && cv < 0.34) {
    sentences.forEach((_sentence, index) => {
      if (index % 2 === 1) add(index, 'uniform_rhythm');
    });
  }

  const reasonCounts = {};
  for (const reasons of reasonsByIndex.values()) {
    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  return { indices: [...reasonsByIndex.keys()].sort((a, b) => a - b), reasonCounts };
}

function meaningfulSentences(value) {
  return splitSentences(stripLockTokens(value))
    .map(sentence => String(sentence || '').trim())
    .filter(sentence => normalizeSubstantive(sentence).length >= 3);
}

function allExactSameSentences(sentences, indices) {
  const values = indices.map(index => normalizeSubstantive(sentences[index])).filter(Boolean);
  return values.length > 1 && new Set(values).size === 1;
}

function normalizeSubstantive(value) {
  return stripLockTokens(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/통하여/gu, '통해')
    .replace(/대하여/gu, '대해')
    .replace(/위하여/gu, '위해')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function normalizePerceivedSubstantive(value) {
  return stripLockTokens(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/통하여/gu, '통해')
    .replace(/대하여/gu, '대해')
    .replace(/위하여/gu, '위해')
    .replace(/(?:그\s*다음|그\s*뒤|이후|그\s*후)/gu, '후')
    .replace(
      /(설계|검토|시험|분석|작성|구현|개발|확인|완료)(?:이|가|을|를)?\s*(?:완료된\s*)?(?:뒤|후|다음)/gu,
      '$1후'
    )
    .replace(/(?:그리고|또한|아울러|더불어)(?=$|[\s,])/gu, '연결')
    .replace(/(?:따라서|그러므로|이에\s*따라)(?=$|[\s,])/gu, '인과')
    .replace(/(?:하였습니다|했습니다|하였다|했다)/gu, '하다')
    .replace(/(?:되었습니다|됐습니다|되었다|됐다)/gu, '되다')
    .replace(/(?:있었습니다|있었다)/gu, '있다')
    .replace(/(?:없었습니다|없었다)/gu, '없다')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function stripLockTokens(value) {
  return String(value || '').replace(LOCK_TOKEN, ' ');
}

function publicPlan(plan) {
  const {
    targetIndices: _targetIndices,
    targetParagraphIndices: _targetParagraphIndices,
    resumeRepetitionPlan,
    sourceRedundancyPlan,
    ...safe
  } = plan || {};
  return {
    ...safe,
    resumeRepetitionPlan: resumeRepetitionAudit.publicResumeRepetitionPlan(resumeRepetitionPlan),
    sourceRedundancyPlan: sourceRedundancy.publicSourceRedundancyPlan(sourceRedundancyPlan)
  };
}

function coefficientOfVariation(values) {
  if (!values.length) return 1;
  const avg = mean(values);
  if (!avg) return 1;
  return Math.sqrt(mean(values.map(value => (value - avg) ** 2))) / avg;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value) {
  return Math.max(0, Math.min(1, finite(value)));
}

function round4(value) {
  return Math.round(finite(value) * 10000) / 10000;
}

function progress(value, target) {
  const denominator = finite(target);
  if (denominator <= 0) return 1;
  return Math.min(1.25, finite(value) / denominator);
}

module.exports = {
  POLICY_VERSION,
  PLAN_SIGNAL_SOURCE,
  buildHumanizationPlan,
  buildDistributedHumanizationPlans,
  evaluateHumanizationDepth,
  humanizationCandidateScore,
  isBetterHumanizationCandidate,
  targetDepthGap,
  needsHumanizationRecovery,
  measureSubstantiveEdit,
  measureSubstantiveCarryover,
  eligibleProseSentences,
  buildSentenceParagraphMap,
  classifyEffectExpectation,
  assessDepthReview,
  buildHumanizationPromptBlock,
  normalizeSubstantive,
  normalizePerceivedSubstantive
};
