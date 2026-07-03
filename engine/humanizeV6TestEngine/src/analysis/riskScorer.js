const {
  getBasicStats,
  countMatches,
  charCountNoSpace,
  tokenize
} = require('./textStats');
const { extractProtectedTerms } = require('./protectedTerms');

const ABSTRACT_PATTERNS = [
  /추상적/g, /일반적/g, /중요/g, /필요/g, /가능성/g, /측면/g, /관점/g, /의미/g,
  /기반/g, /전략/g, /핵심/g, /요인/g, /효과/g, /문제/g, /과정/g, /구조/g,
  /역할/g, /방법/g, /결과/g, /목적/g, /가치/g, /변화/g, /요소/g, /활용/g,
  /강화/g, /확대/g, /개선/g, /확보/g, /기여/g, /시사/g, /경쟁력/g
];

const FORMULAIC_PATTERNS = [
  /라고 할 수 있다/g, /볼 수 있다/g, /할 수 있다/g, /필요가 있다/g, /중요하다/g,
  /이어진다/g, /작용한다/g, /기능한다/g, /의미가 있다/g, /시사한다/g,
  /나타났다/g, /확인하였다/g, /알 수 있었다/g, /기반으로/g, /측면에서/g,
  /통해/g, /이러한/g, /결론적으로/g, /종합하면/g, /핵심 인프라/g, /핵심 요소/g
];

const IMPERSONAL_PATTERNS = [
  /이루어진다/g, /요구된다/g, /제공된다/g, /확인된다/g, /처리된다/g, /분석된다/g,
  /운영된다/g, /가능해진다/g, /나타난다/g, /여겨진다/g, /간주된다/g, /예상된다/g,
  /볼 수 있다/g, /할 수 있다/g, /필요하다/g
];

const TRANSITION_PATTERNS = [
  /따라서/g, /또한/g, /그리고/g, /하지만/g, /그러나/g, /반면/g, /나아가/g,
  /결국/g, /즉/g, /이에/g, /이처럼/g, /이러한/g, /첫째/g, /둘째/g, /마지막으로/g
];

const COMPRESSION_PATTERNS = [
  /동시에/g, /나아가/g, /아울러/g, /뿐만 아니라/g, /반대로/g, /한편/g,
  /이를 통해/g, /그 결과/g, /즉/g, /결국/g
];

const OVER_FORMAL_PATTERNS = [
  /전반의/g, /우선적으로/g, /재차/g, /순차적으로/g, /실질적으로/g, /기반으로/g,
  /확보/g, /추진/g, /도출/g, /제고/g, /고도화/g, /전략적/g
];

const OVER_COLLOQUIAL_PATTERNS = [
  /버리고/g, /고쳐나간다/g, /받쳐줘/g, /뒤흔들/g, /끌어올린/g, /붙들어/g,
  /들여다본다/g, /확 와/g, /엄청/g, /정말/g
];

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function density(count, denom, scale = 1) {
  return clamp01((count / Math.max(1, denom)) * scale);
}

function analyzeRisk(text, policy = {}) {
  const stats = getBasicStats(text);
  const tokenCount = Math.max(1, stats.tokenCount);
  const sentenceCount = Math.max(1, stats.sentenceCount);
  const protectedTerms = extractProtectedTerms(text, { max: 120 });
  const protectedTermDensity = protectedTerms.length / Math.max(1, tokenCount / 25);
  const numbers = (String(text || '').match(/\d+(?:[.,]\d+)?/g) || []).length;
  const latin = (String(text || '').match(/[A-Za-z]{2,}/g) || []).length;

  const abstractness = density(countMatches(text, ABSTRACT_PATTERNS), tokenCount, 12);
  const formulaic = density(countMatches(text, FORMULAIC_PATTERNS), sentenceCount, 0.9);
  const impersonal = density(countMatches(text, IMPERSONAL_PATTERNS), sentenceCount, 0.75);
  const transitionOveruse = density(countMatches(text, TRANSITION_PATTERNS), sentenceCount, 0.55);
  const compression = density(countMatches(text, COMPRESSION_PATTERNS), sentenceCount, 0.7);
  const overFormal = density(countMatches(text, OVER_FORMAL_PATTERNS), sentenceCount, 0.55);
  const overColloquial = density(countMatches(text, OVER_COLLOQUIAL_PATTERNS), sentenceCount, 0.65);
  const repetition = clamp01((stats.repetition3 * 1.35) + (stats.repetition4 * 1.1));

  // Uniformity risk rises when sentence-length entropy and CV are too low.
  const cvRisk = stats.sentenceLengthCv < 0.38 ? (0.38 - stats.sentenceLengthCv) / 0.38 : 0;
  const entropyRisk = stats.sentenceLengthEntropy < 0.62 ? (0.62 - stats.sentenceLengthEntropy) / 0.62 : 0;
  const uniformity = clamp01((cvRisk * 0.58) + (entropyRisk * 0.42));

  // Anchor deficit is high when a text is abstract but lacks factual anchors.
  const anchorRaw = numbers + latin + protectedTerms.length;
  const anchorDensity = clamp01(anchorRaw / Math.max(1, tokenCount / 18));
  const anchorDeficit = clamp01(abstractness * (1 - anchorDensity));

  // MATTR too low suggests repetitive vocabulary; too high can mean term-dense text. We only penalize low diversity.
  const lexicalLow = stats.mattr < 0.62 ? (0.62 - stats.mattr) / 0.62 : 0;

  const weights = policy.weights || {};
  const linear =
    -0.95 +
    (weights.abstractness ?? 1.0) * abstractness +
    (weights.formulaic ?? 1.1) * formulaic +
    (weights.repetition ?? 1.0) * repetition +
    (weights.uniformity ?? 1.0) * uniformity +
    (weights.impersonal ?? 0.8) * impersonal +
    (weights.transitionOveruse ?? 0.6) * transitionOveruse +
    (weights.compression ?? 0.7) * compression +
    (weights.anchorDeficit ?? 0.9) * anchorDeficit +
    (weights.overFormal ?? 0.45) * overFormal +
    (weights.overColloquial ?? 0.32) * overColloquial +
    0.35 * lexicalLow;

  const score = clamp01(sigmoid(linear));
  const grade = score >= 0.72 ? 'high' : score >= 0.52 ? 'medium' : score >= 0.32 ? 'low-medium' : 'low';
  const sourceType = classifySourceRisk({ score, abstractness, anchorDensity, stats, protectedTerms });

  return {
    score,
    grade,
    sourceType,
    components: {
      abstractness,
      formulaic,
      repetition,
      uniformity,
      impersonal,
      transitionOveruse,
      compression,
      anchorDensity,
      anchorDeficit,
      overFormal,
      overColloquial,
      lexicalLow
    },
    stats: publicStats(stats),
    protectedTerms
  };
}

function classifySourceRisk({ score, abstractness, anchorDensity, stats, protectedTerms }) {
  const hasStructure = stats.headings.length >= 2 || stats.listLineCount >= 2 || /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\./.test(stats.paragraphs.join('\n'));
  if (score < 0.30 && stats.repetition3 < 0.02) return 'lowRiskSource';
  if (protectedTerms.length >= 10 && anchorDensity > 0.4) return 'factDenseSource';
  if (hasStructure) return 'structureSensitiveSource';
  if (abstractness > 0.55 && anchorDensity < 0.32) return 'abstractSource';
  return 'mixedSource';
}

function publicStats(s) {
  return {
    charCountNoSpace: s.charCountNoSpace,
    paragraphCount: s.paragraphCount,
    sentenceCount: s.sentenceCount,
    tokenCount: s.tokenCount,
    headingCount: s.headings.length,
    listLineCount: s.listLineCount,
    avgSentenceLength: round(s.avgSentenceLength),
    sentenceLengthCv: round(s.sentenceLengthCv),
    sentenceLengthEntropy: round(s.sentenceLengthEntropy),
    paragraphLengthCv: round(s.paragraphLengthCv),
    mattr: round(s.mattr),
    repetition3: round(s.repetition3),
    repetition4: round(s.repetition4)
  };
}

function round(x) {
  return Math.round((Number(x) || 0) * 1000) / 1000;
}

function contentOverlap(a, b) {
  const stop = new Set(['그리고','하지만','그러나','따라서','또한','이러한','이처럼','것이다','있다','한다','된다','수','있다','위해','통해','대한','관련','부분','경우','정도']);
  const A = new Set(tokenize(a).map(t => t.toLowerCase()).filter(t => t.length >= 2 && !stop.has(t)));
  const B = new Set(tokenize(b).map(t => t.toLowerCase()).filter(t => t.length >= 2 && !stop.has(t)));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

module.exports = {
  analyzeRisk,
  contentOverlap,
  ABSTRACT_PATTERNS,
  FORMULAIC_PATTERNS,
  IMPERSONAL_PATTERNS
};
