'use strict';

const {
  normalizeSignalEvidence,
  publicSignalDescriptions
} = require('./detectSignalPolicy');
const { normalizeScore } = require('./detectInterpretation');

const DISCLAIMER = '이 점수는 글에서 관찰된 문체 신호를 나타내며, 실제 작성 주체를 확정하지 않습니다.';

const BANDS = Object.freeze({
  unknown: Object.freeze({
    level: 'unknown', label: '분석 결과 확인 필요',
    summary: '완료된 문체 점수를 확인할 수 없어요.',
    detail() { return '점수가 없는 상태를 낮은 문체 신호로 해석하지 않아요. 입력과 분석 결과 상태를 확인해 주세요.'; }
  }),
  low: Object.freeze({
    level: 'low',
    label: 'AI식 문체 신호 · 낮음',
    summary: 'AI식 문체 신호가 낮게 관찰됐어요.',
    detail(probability) {
      return `문체 신호 ${probability}/100은 낮은 구간입니다. 정돈된 문장이나 반복 표현이 일부 보여도 글 전체의 AI식 문체 신호는 낮게 해석해야 합니다.`;
    }
  }),
  moderate: Object.freeze({
    level: 'moderate',
    label: 'AI식 문체 신호 · 중간',
    summary: 'AI식 문체 신호가 일부 관찰됐어요.',
    detail(probability) {
      return `문체 신호 ${probability}/100은 중간 구간입니다. 일부 정형적인 특징이 보이지만, 이 점수만으로 작성 주체를 판단할 수는 없습니다.`;
    }
  }),
  high: Object.freeze({
    level: 'high',
    label: 'AI식 문체 신호 · 높음',
    summary: 'AI식 문체 신호가 높게 관찰됐어요.',
    detail(probability) {
      return `문체 신호 ${probability}/100은 높은 구간입니다. 아래 특징이 글 전반에서 반복되어 점수를 높인 신호로 관찰됐습니다.`;
    }
  })
});

function clampProbability(value) {
  return normalizeScore(value);
}

function riskBand(probability) {
  const score = clampProbability(probability);
  if (score === null) return BANDS.unknown;
  if (score <= 20) return BANDS.low;
  if (score <= 49) return BANDS.moderate;
  return BANDS.high;
}

function compact(value, max = 800) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function claimsHighRisk(value) {
  const text = compact(value, 2000);
  if (!text) return false;
  return [
    /(?:가능성|확률|위험|의심)(?:이|은|도)?\s*(?:매우\s*)?(?:높|크|강)/,
    /(?:AI|인공지능|기계|자동)[^.!?\n]{0,50}(?:생성|작성|보조|의심|흔적)[^.!?\n]{0,35}(?:높|강|뚜렷|명확)/,
    /(?:AI|인공지능)[^.!?\n]{0,40}(?:작성|생성)(?:한|된)?\s*글(?:로|일)\s*(?:보|판단)/
  ].some(pattern => pattern.test(text));
}

function claimsLowRisk(value) {
  const text = compact(value, 2000);
  if (!text) return false;
  return [
    /(?:가능성|확률|위험|의심)(?:이|은|도)?\s*(?:매우\s*)?(?:낮|작|약)/,
    /(?:AI|인공지능|기계|자동)[^.!?\n]{0,50}(?:생성|작성|보조|의심|흔적)[^.!?\n]{0,35}(?:낮|약|없|미미)/,
    /사람이\s*(?:직접\s*)?쓴\s*글(?:로|일)\s*(?:보|판단)/
  ].some(pattern => pattern.test(text));
}

function narrativeContradictsRisk(value, level) {
  if (level === 'low') return claimsHighRisk(value);
  if (level === 'high') return claimsLowRisk(value);
  return claimsHighRisk(value) || claimsLowRisk(value);
}

function cleanSignals(signals) {
  if (Array.isArray(signals) && signals.some(item => item && typeof item === 'object')) {
    return publicSignalDescriptions(signals)
      .map(value => compact(value, 160).replace(/^[-•·]\s*/, ''))
      .filter(value => value && !claimsHighRisk(value) && !claimsLowRisk(value))
      .slice(0, 5);
  }
  if (!Array.isArray(signals)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const signal of signals) {
    const value = compact(signal, 160).replace(/^[-•·]\s*/, '');
    if (!value || claimsHighRisk(value) || claimsLowRisk(value) || seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value);
    if (cleaned.length >= 5) break;
  }
  return cleaned;
}

function evidenceBlock(signals) {
  const cleaned = cleanSignals(signals);
  if (!cleaned.length) return '';
  return `\n\n관찰된 문체 특징\n${cleaned.map(signal => `- ${signal}`).join('\n')}`;
}

/**
 * The probability is the final user-facing verdict. Model prose is supporting
 * evidence only, so it must never override or contradict that verdict.
 */
function applyDetectNarrativePolicy(result = {}, probabilityOverride) {
  const probability = clampProbability(
    probabilityOverride === undefined ? result.probability : probabilityOverride
  );
  const band = riskBand(probability);
  const originalSummary = compact(result.summary, 800);
  const originalDetail = compact(result.detail, 1800);
  const summaryContradiction = narrativeContradictsRisk(originalSummary, band.level);
  const detailContradiction = narrativeContradictsRisk(originalDetail, band.level);
  const signalEvidence = normalizeSignalEvidence(
    Array.isArray(result.signalEvidence) && result.signalEvidence.length
      ? result.signalEvidence
      : result.signals
  );
  const signals = cleanSignals(signalEvidence.length ? signalEvidence : result.signals);
  const allowedSignalDescriptions = new Set(signals);
  const publicSignalEvidence = signalEvidence.filter(item => allowedSignalDescriptions.has(item.description));
  // The model's free-form summary/detail can mix an observed feature with an
  // opposite verdict in the same sentence. Only structured feature signals
  // survive; the verdict prose is generated deterministically from the score.
  const modelDetail = evidenceBlock(signals);

  return {
    ...result,
    probability,
    riskLevel: band.level,
    riskLabel: band.label,
    summary: band.summary,
    detail: `${band.detail(probability)}${modelDetail}\n\n${DISCLAIMER}`,
    signals,
    signalEvidence: publicSignalEvidence,
    narrativeConsistencyAdjusted: summaryContradiction || detailContradiction
  };
}

module.exports = {
  DISCLAIMER,
  clampProbability,
  riskBand,
  claimsHighRisk,
  claimsLowRisk,
  narrativeContradictsRisk,
  cleanSignals,
  applyDetectNarrativePolicy
};
