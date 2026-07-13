'use strict';

const { computeEditMetrics, levenshteinDistance, splitSentences } = require('../engine/koreanText');
const { measureNaturalnessShadow } = require('../engine/koreanQuality/naturalnessShadow');

const CONNECTOR_START = /^(?:또한|따라서|이에\s*따라|이러한|이를\s*통해|나아가|한편|결론적으로|즉|첫째|둘째|셋째|하지만|그러나|반면|결국)(?=$|[\s,])/u;
const STOCK_PHRASE = /(?:할\s*수\s*있(?:다|습니다)|볼\s*수\s*있(?:다|습니다)|필요가\s*있(?:다|습니다)|중요(?:하|한)\s*(?:의미|역할|요인)?|의미를\s*가진(?:다|다고)|긍정적인\s*영향|체계적으로\s*(?:정리|분석|관리|운영)|기반으로\s*(?:한|하여|한다|합니다)|핵심\s*인프라|전략적\s*이점)/u;
const ABSTRACT_WORD = /(?:중요|필요|효율|전략|체계|역할|경험|가치|역량|기반|영향|과정|측면|요인|문제|개선|확대|강화|가능성|방향성|의미)/gu;
const DENSE_CONNECTOR = /(?:또한|따라서|하지만|그러나|반면|결국|때문에|통해|위해|이에\s*따라)/gu;
const LOCK_TOKEN = /ZXQLOCK\d+QXZ/giu;
const PLAN_VERSION = 2;
const POLICY_VERSION = 'perceived-v2';

const CAUTIOUS_PROFILES = new Set([
  'academic_paper',
  'report_assignment',
  'student_record_teacher',
  'student_self_assessment',
  'resume_application',
  'mail_notice',
  'short_phrase'
]);

// 최소선은 전달 게이트, 목표 범위는 모델이 실제로 노리는 체감 강도다.
// 기본은 눈에 띄는 재구성, 고급은 더 넓은 재구성과 전 문서 의미 검증을 전제로 한다.
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
      targetSentenceCount: 0,
      requiredChangedSentenceCount: 0,
      minSubstantiveEditRatio: 0,
      targetSubstantiveEditMin: 0,
      targetSubstantiveEditMax: 0,
      minTargetCoverage: 0
    };
  }

  const text = stripLockTokens(source);
  const sentences = meaningfulSentences(text);
  const target = detectTargetSentences(sentences);
  const shadow = safeNaturalness(text);
  const sentenceCount = sentences.length;
  const targetRatio = sentenceCount ? target.indices.length / sentenceCount : 0;
  const abstractRiskRatio = finite(inputRisk?.abstractRiskRatio);
  const overallRisk = finite(shadow?.overallRisk);
  const rhythmRisk = finite(shadow?.metrics?.uniformSentenceRhythm);
  const stockRisk = finite(shadow?.metrics?.stockReportPhrase);
  const connectorRisk = finite(shadow?.metrics?.connectorRepetition);
  const riskScore = clamp(Math.max(
    overallRisk,
    targetRatio * 0.64,
    rhythmRisk * 0.78,
    stockRisk * 0.72,
    connectorRisk * 0.68,
    abstractRiskRatio * 0.34
  ));
  const riskLevel = riskScore >= 0.36 || targetRatio >= 0.62
    ? 'high'
    : (riskScore >= 0.18 || targetRatio >= 0.30 || target.indices.length >= 2 ? 'medium' : 'low');

  const profile = String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
  const creative = profile === 'creative' || documentProfile?.formatProfile?.flags?.includes?.('creative_lines') === true;
  const cautious = CAUTIOUS_PROFILES.has(profile);
  const sourceChars = normalizeSubstantive(text).length;

  const basePolicy = PERCEIVED_POLICY[strength][riskLevel];
  let minSubstantiveEditRatio = basePolicy.minEdit;
  let targetSubstantiveEditMin = basePolicy.targetMin;
  let targetSubstantiveEditMax = basePolicy.targetMax;
  let minChangedSentenceRatio = basePolicy.minSentence;
  let minTargetCoverage = basePolicy.minTarget;

  // 사실·형식 민감 장르는 2%p 완화하지만, 기본도 최소 6%, 고급도 최소 9%의
  // 실질 변화를 유지한다. 창작문은 행갈이와 이미지 자체가 구조라 독립 정책을 쓴다.
  if (cautious) {
    minSubstantiveEditRatio = Math.max(strength === 'advanced' ? 0.09 : 0.06, minSubstantiveEditRatio - 0.02);
    targetSubstantiveEditMin = Math.max(minSubstantiveEditRatio, targetSubstantiveEditMin - 0.02);
    targetSubstantiveEditMax = Math.max(targetSubstantiveEditMin + 0.02, targetSubstantiveEditMax - 0.02);
    minChangedSentenceRatio = Math.max(strength === 'advanced' ? 0.35 : 0.25, minChangedSentenceRatio - 0.05);
    minTargetCoverage = Math.max(strength === 'advanced' ? 0.50 : 0.40, minTargetCoverage - 0.10);
  }
  if (creative) {
    const creativePolicy = CREATIVE_POLICY[riskLevel];
    minSubstantiveEditRatio = creativePolicy.minEdit;
    targetSubstantiveEditMin = creativePolicy.targetMin;
    targetSubstantiveEditMax = creativePolicy.targetMax;
    minChangedSentenceRatio = creativePolicy.minSentence;
    minTargetCoverage = creativePolicy.minTarget;
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
    sourceChars,
    sourceSentenceCount: sentenceCount,
    targetSentenceCount: target.indices.length,
    targetReasonCounts: target.reasonCounts,
    targetIndices: target.indices,
    requiredChangedSentenceCount,
    requiredTargetChangedCount,
    minChangedSentenceRatio: round4(minChangedSentenceRatio),
    minSubstantiveEditRatio: round4(minSubstantiveEditRatio),
    targetSubstantiveEditMin: round4(targetSubstantiveEditMin),
    targetSubstantiveEditMax: round4(targetSubstantiveEditMax),
    minTargetCoverage: round4(minTargetCoverage),
    sourceNaturalnessRisk: round4(overallRisk)
  };
}

function evaluateHumanizationDepth(source, output, planOrOptions = {}) {
  const plan = Number(planOrOptions?.version) >= 1
    ? planOrOptions
    : buildHumanizationPlan(source, planOrOptions);
  const metrics = measureSubstantiveEdit(source, output);
  if (!plan.applicable) return { version: PLAN_VERSION, applicable: false, pass: true, reasons: [], plan: publicPlan(plan), metrics };

  const targetIndices = new Set(plan.targetIndices || []);
  const targetChangedCount = metrics.sentenceEdits.filter(row => targetIndices.has(row.index) && row.substantiveChanged).length;
  const targetCoverage = plan.targetSentenceCount ? targetChangedCount / plan.targetSentenceCount : 1;
  const reasons = [];
  if (metrics.substantiveEditRatio + 1e-9 < plan.minSubstantiveEditRatio) reasons.push('substantive_edit_ratio_low');
  if (metrics.substantiveChangedSentenceCount < plan.requiredChangedSentenceCount) reasons.push('substantive_sentence_coverage_low');
  if (plan.requiredTargetChangedCount > 0 && targetChangedCount < plan.requiredTargetChangedCount) reasons.push('risk_target_coverage_low');
  if (metrics.trivialOnly) reasons.push('punctuation_or_surface_only');
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
    reasons,
    plan: publicPlan(plan),
    metrics: {
      ...metrics,
      sentenceEdits: undefined,
      targetChangedCount,
      targetCoverage: round4(targetCoverage),
      targetDepthMet,
      aboveTargetRange,
      deliveryDepthBand
    }
  };
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
  return {
    rawCharEditRatio: round4(raw.charEditRatio),
    substantiveDistance,
    substantiveEditRatio: round4(substantiveEditRatio),
    substantiveChangedSentenceCount,
    substantiveChangedSentenceRatio: round4(substantiveChangedSentenceRatio),
    sourceSentenceCount: sourceSentences.length,
    outputSentenceCount: outputSentences.length,
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
  const minPercent = formatPercent(plan.minSubstantiveEditRatio);
  const targetMinPercent = formatPercent(plan.targetSubstantiveEditMin);
  const targetMaxPercent = formatPercent(plan.targetSubstantiveEditMax);
  return [
    '[실질 휴머나이징 계약]',
    '이 모드는 교정·다듬기가 아니다. 원문의 뜻과 사실은 그대로 두되, AI식으로 반복되는 어순·상투어·추상명사·접속 방식·균일한 호흡을 사람이 직접 쓴 문장처럼 다시 구성한다.',
    '띄어쓰기, 쉼표, 인용부호, 조사 한 곳, 단순 축약이나 동의어 한두 개만 바꾼 결과는 실패다.',
    `${strengthLabel} 휴머나이징의 서버 최소선은 실질 변화 ${minPercent}%이고, 실제 작성 목표는 ${targetMinPercent}~${targetMaxPercent}%다. 숫자를 맞추려고 동의어를 흩뿌리지 말고 대상 문장을 충분히 다시 쓴다.`,
    `원문 위험도=${plan.riskLevel}; 일반 문장 ${plan.sourceSentenceCount}개 중 최소 ${plan.requiredChangedSentenceCount}개는 절·어순·연결·호흡 가운데 하나 이상이 분명히 달라져야 한다.`,
    plan.targetSentenceCount
      ? `우선 개선 대상 ${plan.targetSentenceCount}개 중 최소 ${plan.requiredTargetChangedCount}개를 실질적으로 고친다${reasons ? `: ${reasons}` : '.'}`
      : '특정 위험 표현이 적더라도 일반 문장의 흐름과 어순을 국소적으로 재구성해 다듬기와 구분되는 결과를 만든다.',
    '문장마다 억지로 다른 단어를 끼워 넣지 말고, 바꿀 문장은 충분히 바꾸며 이미 자연스러운 문장은 남긴다.',
    '원문에 없는 경험·감정·수치·기관·인용·주장·예시는 절대 추가하지 않는다.'
  ].join('\n');
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
      if (!best || ratio < best.ratio) best = { outputIndex, distance, ratio };
    }
    const substantiveChanged = best.distance >= 3 && best.ratio >= 0.065;
    return {
      index,
      outputIndex: best.outputIndex,
      distance: best.distance,
      ratio: round4(best.ratio),
      substantiveChanged
    };
  });
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

function safeNaturalness(value) {
  try { return measureNaturalnessShadow(value); } catch { return null; }
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

function formatPercent(value) {
  return Number((finite(value) * 100).toFixed(1));
}

module.exports = {
  POLICY_VERSION,
  buildHumanizationPlan,
  evaluateHumanizationDepth,
  measureSubstantiveEdit,
  buildHumanizationPromptBlock,
  normalizeSubstantive
};
