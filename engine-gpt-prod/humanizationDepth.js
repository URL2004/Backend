'use strict';

const { computeEditMetrics, levenshteinDistance, splitSentences } = require('../engine/koreanText');
const { buildRemediationPlan, compareRemediationTargets } = require('./discourseAudit');

const CONNECTOR_START = /^(?:또한|따라서|이에\s*따라|이러한|이를\s*통해|나아가|한편|결론적으로|즉|첫째|둘째|셋째|하지만|그러나|반면|결국)(?=$|[\s,])/u;
const STOCK_PHRASE = /(?:할\s*수\s*있(?:다|습니다)|볼\s*수\s*있(?:다|습니다)|필요가\s*있(?:다|습니다)|중요(?:하|한)\s*(?:의미|역할|요인)?|의미를\s*가진(?:다|다고)|긍정적인\s*영향|체계적으로\s*(?:정리|분석|관리|운영)|기반으로\s*(?:한|하여|한다|합니다)|핵심\s*인프라|전략적\s*이점)/u;
const ABSTRACT_WORD = /(?:중요|필요|효율|전략|체계|역할|경험|가치|역량|기반|영향|과정|측면|요인|문제|개선|확대|강화|가능성|방향성|의미)/gu;
const DENSE_CONNECTOR = /(?:또한|따라서|하지만|그러나|반면|결국|때문에|통해|위해|이에\s*따라)/gu;
const LOCK_TOKEN = /ZXQLOCK\d+QXZ/giu;
const PLAN_VERSION = 5;
const POLICY_VERSION = 'perceived-v2.4.8';
const PLAN_SIGNAL_SOURCE = 'deterministic_targets_input_risk';
const HARD_DELIVERY_EDIT_FLOOR = 0.04;
const HARD_DELIVERY_EDIT_FACTOR = 0.40;
const HARD_DELIVERY_SENTENCE_FACTOR = 0.50;

const CAUTIOUS_PROFILES = new Set([
  'academic_paper',
  'report_assignment',
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
    low: Object.freeze({ minEdit: 0.08, targetMin: 0.10, targetMax: 0.13, minSentence: 0.30, minTarget: 0.50 }),
    medium: Object.freeze({ minEdit: 0.10, targetMin: 0.12, targetMax: 0.16, minSentence: 0.40, minTarget: 0.65 }),
    high: Object.freeze({ minEdit: 0.13, targetMin: 0.15, targetMax: 0.19, minSentence: 0.50, minTarget: 0.75 })
  }),
  advanced: Object.freeze({
    low: Object.freeze({ minEdit: 0.11, targetMin: 0.14, targetMax: 0.17, minSentence: 0.40, minTarget: 0.60 }),
    medium: Object.freeze({ minEdit: 0.14, targetMin: 0.17, targetMax: 0.20, minSentence: 0.50, minTarget: 0.75 }),
    high: Object.freeze({ minEdit: 0.17, targetMin: 0.20, targetMax: 0.23, minSentence: 0.60, minTarget: 0.85 })
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
      carryoverApplicable: false,
      maxSubstantiveCarryoverRatio: 1,
      requiredStructuralChangedSentenceCount: 0,
      minRemediationCoverage: 0,
      rhetoricalRemediationPlan: { applicable: false, targetCount: 0, categoryCount: 0, categories: [] }
    };
  }

  const text = stripLockTokens(source);
  const sentences = meaningfulSentences(text);
  const rhetoricalRemediationPlan = buildRemediationPlan(text);
  const target = mergeRemediationTargets(detectTargetSentences(sentences), rhetoricalRemediationPlan);
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

  const profile = String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
  const creative = profile === 'creative' || documentProfile?.formatProfile?.flags?.includes?.('creative_lines') === true;
  const cautious = CAUTIOUS_PROFILES.has(profile);
  const sourceChars = normalizeSubstantive(text).length;
  const eligibleCarryoverSentenceCount = eligibleProseSentences(text).length;

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

  // 사실·형식 민감 장르는 2%p 완화하지만, 기본도 최소 6%, 고급도 최소 9%의
  // 실질 변화를 유지한다. 창작문은 행갈이와 이미지 자체가 구조라 독립 정책을 쓴다.
  if (cautious) {
    minSubstantiveEditRatio = Math.max(strength === 'advanced' ? 0.09 : 0.06, minSubstantiveEditRatio - 0.02);
    targetSubstantiveEditMin = Math.max(minSubstantiveEditRatio, targetSubstantiveEditMin - 0.02);
    targetSubstantiveEditMax = Math.max(targetSubstantiveEditMin + 0.02, targetSubstantiveEditMax - 0.02);
    minChangedSentenceRatio = Math.max(strength === 'advanced' ? 0.35 : 0.25, minChangedSentenceRatio - 0.05);
    minTargetCoverage = Math.max(strength === 'advanced' ? 0.50 : 0.40, minTargetCoverage - 0.10);
    structuralCoverageFactor = strength === 'advanced' ? 0.50 : 0.38;
    minRemediationCoverage = rhetoricalRemediationPlan.targetCount > 0
      ? (strength === 'advanced' ? 0.50 : 0.40)
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
    ? Math.min(1, (strength === 'advanced' ? 0.25 : 0.30) + (cautious ? 0.05 : 0))
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
    carryoverApplicable,
    maxSubstantiveCarryoverRatio: round4(maxSubstantiveCarryoverRatio),
    minRemediationCoverage: round4(minRemediationCoverage),
    rhetoricalRemediationPlan
  };
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
    reasons: [],
    blockingReasons: [],
    plan: publicPlan(plan),
    metrics
  };

  const targetIndices = new Set(plan.targetIndices || []);
  const targetChangedCount = metrics.sentenceEdits.filter(row => targetIndices.has(row.index) && row.substantiveChanged).length;
  const targetCoverage = plan.targetSentenceCount ? targetChangedCount / plan.targetSentenceCount : 1;
  const reasons = [];
  if (metrics.substantiveEditRatio + 1e-9 < plan.minSubstantiveEditRatio) reasons.push('substantive_edit_ratio_low');
  if (metrics.substantiveChangedSentenceCount < plan.requiredChangedSentenceCount) reasons.push('substantive_sentence_coverage_low');
  if (plan.requiredTargetChangedCount > 0 && targetChangedCount < plan.requiredTargetChangedCount) reasons.push('risk_target_coverage_low');
  if (Number(plan.requiredStructuralChangedSentenceCount || 0) > 0
      && metrics.structurallyChangedSentenceCount < Number(plan.requiredStructuralChangedSentenceCount)) {
    reasons.push('structural_rewrite_coverage_low');
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

  return {
    version: PLAN_VERSION,
    applicable: true,
    pass: reasons.length === 0,
    minimumEffectPass: blockingReasons.length === 0,
    reasons,
    blockingReasons,
    plan: publicPlan(plan),
    metrics: {
      ...metrics,
      sentenceEdits: undefined,
      targetChangedCount,
      targetCoverage: round4(targetCoverage),
      remediation,
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
    ? progress(metrics.structurallyChangedSentenceCount, plan.requiredStructuralChangedSentenceCount)
    : 1;
  const remediationProgress = Number(plan.minRemediationCoverage || 0) > 0
    ? progress(metrics.remediation?.coverage, plan.minRemediationCoverage)
    : 1;
  const carryoverProgress = plan.carryoverApplicable === true
    ? (finite(metrics.substantiveCarryoverRatio) <= finite(plan.maxSubstantiveCarryoverRatio) ? 1 : 0)
    : 1;
  return round4((editProgress * 0.36)
    + (sentenceProgress * 0.22)
    + (targetProgress * 0.15)
    + (structuralProgress * 0.11)
    + (remediationProgress * 0.08)
    + (carryoverProgress * 0.08));
}

function isBetterHumanizationCandidate(current, candidate) {
  if (!candidate?.applicable || candidate.metrics?.trivialOnly) return false;
  if (candidate.pass === true && current?.pass !== true) return true;
  const currentScore = humanizationCandidateScore(current);
  const candidateScore = humanizationCandidateScore(candidate);
  if (candidateScore >= currentScore + 0.04) return true;
  const currentEdit = finite(current?.metrics?.substantiveEditRatio);
  const candidateEdit = finite(candidate?.metrics?.substantiveEditRatio);
  const currentSentences = finite(current?.metrics?.substantiveChangedSentenceCount);
  const candidateSentences = finite(candidate?.metrics?.substantiveChangedSentenceCount);
  const currentStructural = finite(current?.metrics?.structurallyChangedSentenceCount);
  const candidateStructural = finite(candidate?.metrics?.structurallyChangedSentenceCount);
  const currentRemediation = finite(current?.metrics?.remediation?.coverage);
  const candidateRemediation = finite(candidate?.metrics?.remediation?.coverage);
  if (candidateStructural > currentStructural && candidateEdit >= currentEdit - 0.005) return true;
  if (candidateRemediation >= currentRemediation + 0.25 && candidateEdit >= currentEdit - 0.005) return true;
  return candidateEdit >= currentEdit + 0.015 && candidateSentences >= currentSentences;
}

function measureSubstantiveEdit(source, output) {
  const fromRaw = stripLockTokens(source);
  const toRaw = stripLockTokens(output);
  const from = normalizeSubstantive(fromRaw);
  const to = normalizeSubstantive(toRaw);
  const substantiveDistance = levenshteinDistance(from, to);
  const substantiveBase = Math.max(from.length, to.length, 1);
  const raw = computeEditMetrics(fromRaw, toRaw);
  const sourceSentences = meaningfulSentences(fromRaw);
  const outputSentences = meaningfulSentences(toRaw);
  const sentenceEdits = alignSentenceEdits(sourceSentences, outputSentences);
  const substantiveChangedSentenceCount = sentenceEdits.filter(row => row.substantiveChanged).length;
  const substantiveChangedSentenceRatio = sourceSentences.length
    ? substantiveChangedSentenceCount / sourceSentences.length
    : 0;
  const substantiveEditRatio = substantiveDistance / substantiveBase;
  const structurallyChangedSentenceCount = sentenceEdits.filter(row => row.structuralChanged).length;
  const clauseBoundaryChangeCount = sentenceEdits.filter(row => row.clauseBoundaryChanged).length;
  const contentOrderChangeCount = sentenceEdits.filter(row => row.contentOrderChanged).length;
  const sentenceBoundaryDelta = Math.abs(sourceSentences.length - outputSentences.length);
  const structuralChangeCount = Math.max(
    structurallyChangedSentenceCount,
    sentenceBoundaryDelta > 0 ? Math.min(sourceSentences.length, sentenceBoundaryDelta) : 0
  );
  const carryover = measureSubstantiveCarryover(fromRaw, toRaw);
  return {
    rawCharEditRatio: round4(raw.charEditRatio),
    substantiveDistance,
    substantiveEditRatio: round4(substantiveEditRatio),
    substantiveChangedSentenceCount,
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
    uniform_rhythm: '균일한 문장 호흡'
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
    `원문 위험도=${plan.riskLevel}; 이미 자연스러운 문장은 남기고 아래 우선 대상 문장을 구조적으로 다시 쓴다.`,
    plan.targetSentenceCount
      ? `우선 대상 문장 번호=${targetOrdinals.join(',') || '서버선정'}${reasons ? `; 원인=${reasons}` : ''}. 문장 번호는 편집 위치일 뿐 새 문장을 만들라는 뜻이 아니다.`
      : '특정 위험 표현이 적더라도 일반 문장의 흐름과 어순을 국소적으로 재구성해 다듬기와 구분되는 결과를 만든다.',
    '문장마다 억지로 다른 단어를 끼워 넣지 말고, 바꿀 문장은 충분히 바꾸며 이미 자연스러운 문장은 남긴다.',
    plan.requiredStructuralChangedSentenceCount > 0
      ? '대상 문장은 단순 동의어 교체에 머물지 말고, 같은 뜻 안에서 절 배치·주어 위치·연결 방식·문장 경계 중 실제 구조를 바꾼다.'
      : '',
    plan.rhetoricalRemediationPlan?.targetCount > 0
      ? '원문 담화 계약에 표시된 정형 성찰·반복 결론·과도하게 완결된 인과 구조는 그대로 복사하지 말고, 사실을 삭제하지 않는 범위에서 직접적인 문장으로 풀어 쓴다.'
      : '',
    '원문에 없는 경험·감정·수치·기관·인용·주장·예시는 절대 추가하지 않는다.'
  ].filter(Boolean).join('\n');
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
    const sourceNorm = normalizeSubstantive(sentence);
    if (!outputSentences.length) {
      return { index, outputIndex: -1, distance: sourceNorm.length, ratio: 1, substantiveChanged: true };
    }
    const center = sourceSentences.length <= 1
      ? 0
      : Math.round(index * (outputSentences.length - 1) / Math.max(1, sourceSentences.length - 1));
    const candidates = new Set([center - 1, center, center + 1].filter(value => value >= 0 && value < outputSentences.length));
    let best = null;
    for (const outputIndex of candidates) {
      const outputNorm = normalizeSubstantive(outputSentences[outputIndex]);
      const distance = levenshteinDistance(sourceNorm, outputNorm);
      const base = Math.max(sourceNorm.length, outputNorm.length, 1);
      const ratio = distance / base;
      if (!best || ratio < best.ratio) best = { outputIndex, distance, ratio, outputSentence: outputSentences[outputIndex] };
    }
    const substantiveChanged = best.distance >= 3 && best.ratio >= 0.065;
    const structure = compareSentenceStructure(sentence, best.outputSentence, {
      substantiveChanged,
      editRatio: best.ratio
    });
    return {
      index,
      outputIndex: best.outputIndex,
      distance: best.distance,
      ratio: round4(best.ratio),
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

function compareSentenceStructure(source, output, { substantiveChanged = false, editRatio = 0 } = {}) {
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
  return {
    clauseBoundaryChanged,
    contentOrderChanged,
    contentOrderChangeRatio: round4(orderChangeRatio),
    sharedContentTokenRatio: round4(sharedRatio),
    structuralChanged: substantiveChanged && (clauseBoundaryChanged || contentOrderChanged || deepRecast)
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

function stripLockTokens(value) {
  return String(value || '').replace(LOCK_TOKEN, ' ');
}

function publicPlan(plan) {
  const { targetIndices: _targetIndices, ...safe } = plan || {};
  return safe;
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
  evaluateHumanizationDepth,
  humanizationCandidateScore,
  isBetterHumanizationCandidate,
  measureSubstantiveEdit,
  measureSubstantiveCarryover,
  eligibleProseSentences,
  classifyEffectExpectation,
  buildHumanizationPromptBlock,
  normalizeSubstantive
};
