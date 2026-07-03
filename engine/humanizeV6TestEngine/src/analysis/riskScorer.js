'use strict';
const {
  normalizeText,
  splitSentences,
  splitParagraphs,
  words,
  koreanTokens,
  cv,
  entropy,
  countOccurrences,
  ngramRepetition,
  mattr
} = require('./textStats');
const { extractProtectedTerms } = require('./protectedTerms');

const ABSTRACT_PATTERNS = [
  /중요(?:하다|한|성)/g, /필요(?:하다|한|성)/g, /가능성/g, /효과/g, /가치/g, /의미/g,
  /전략/g, /경쟁력/g, /핵심/g, /변화/g, /환경/g, /문제/g, /방향/g, /역할/g,
  /기여/g, /활용/g, /확대/g, /강화/g, /개선/g, /도입/g, /운영/g, /관리/g
];

const FORMULAIC_PATTERNS = [
  /(?:라고|다고) 볼 수 있다/g, /할 수 있다/g, /것으로 보인다/g, /점에서/g, /측면에서/g,
  /기반으로/g, /통해/g, /이러한/g, /따라서/g, /결국/g, /나아가/g, /아울러/g,
  /중요한 역할/g, /핵심(?:적인)? (?:요인|인프라|축|역할)/g, /전략적 이점/g,
  /가능성이 높다/g, /이어진다/g, /기능한다/g, /작용한다/g, /기여한다/g,
  /활용 범위/g, /실질적/g, /전반(?:적|의)/g
];

const RHETORICAL_PATTERNS = [
  /진짜 목적/g, /무심코/g, /한 줄이/g, /바로 .*이다/g, /그치지 않고/g,
  /위력이 두드러진다/g, /인간의 눈/g, /앞에서는/g, /단서가 된다/g,
  /경계(?:를|가)/g, /밀어붙/g, /생존의 문제/g, /선택 앞에/g, /뒤흔들/g,
  /붙들어 두/g, /끌어올/g, /무너지는 것은/g, /불가능에 가까/g, /곧장 번진/g,
  /자리를 내줄 위험/g, /엄청난/g, /무서운 속도/g, /단번에/g, /완전히 새로운/g,
  /대폭/g, /폭발적/g, /압도적/g, /획기적/g
];

const CLAIM_STRENGTH_PATTERNS = [
  /반드시/g, /항상/g, /절대/g, /무조건/g, /확실(?:히|하다)/g, /명백(?:히|하다)/g,
  /유일한/g, /결정적/g, /불가능/g, /단번에/g, /완전히/g, /가장/g, /최고/g, /최악/g,
  /대폭/g, /엄청난/g, /무서운/g, /곧장/g
];

const IMPERSONAL_PATTERNS = [
  /여겨진다/g, /보여진다/g, /이루어진다/g, /요구된다/g, /필요하다/g, /가능하다/g,
  /나타난다/g, /확인된다/g, /분석된다/g, /활용된다/g, /제공된다/g, /운영된다/g,
  /처리된다/g, /구성된다/g
];

const TRANSITION_PATTERNS = [/또한/g, /그리고/g, /하지만/g, /다만/g, /따라서/g, /결국/g, /나아가/g, /한편/g, /반면/g, /즉/g, /더불어/g, /아울러/g];
const COMPRESSION_PATTERNS = [/요약하면/g, /정리하면/g, /한마디로/g, /핵심은/g, /결론적으로/g, /결국/g, /종합하면/g];
const OVER_FORMAL_PATTERNS = [/대상으로/g, /걸쳐/g, /순차적으로/g, /확인한 결과/g, /우선적으로/g, /재차/g, /실질적으로/g, /전반의/g, /비중을 짐작/g];
const OVER_COLLOQ_PATTERNS = [/대충/g, /똑똑해/g, /캐치/g, /확 줄/g, /겁나/g, /되게/g, /엄청/g, /~죠/g];

function safeDiv(a, b) { return b ? a / b : 0; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function scoreText(text, policy = {}) {
  const t = normalizeText(text);
  const sentences = splitSentences(t);
  const paras = splitParagraphs(t);
  const toks = words(t);
  const ktoks = koreanTokens(t);
  const charLen = t.replace(/\s+/g, '').length;

  const sentenceLens = sentences.map(s => s.replace(/\s+/g, '').length).filter(Boolean);
  const paraLens = paras.map(p => p.replace(/\s+/g, '').length).filter(Boolean);
  const avgSentLen = sentenceLens.length ? sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length : 0;
  const lengthCv = cv(sentenceLens);
  const paraCv = cv(paraLens);
  const endingCounts = new Map();
  for (const s of sentences) {
    const m = s.match(/(다|니다|요|한다|했다|된다|있다|없다)[.!?。！？]?$/);
    if (m) endingCounts.set(m[1], (endingCounts.get(m[1]) || 0) + 1);
  }
  const endingEntropy = entropy([...endingCounts.values()]);

  const abstractness = clamp01(safeDiv(countOccurrences(t, ABSTRACT_PATTERNS), Math.max(1, ktoks.length)) * 8.5);
  const formulaic = clamp01(safeDiv(countOccurrences(t, FORMULAIC_PATTERNS), Math.max(1, sentences.length)) * 0.65);
  const rhetorical = clamp01(safeDiv(countOccurrences(t, RHETORICAL_PATTERNS), Math.max(1, sentences.length)) * 0.9);
  const claimStrength = clamp01(safeDiv(countOccurrences(t, CLAIM_STRENGTH_PATTERNS), Math.max(1, sentences.length)) * 0.75);
  const impersonal = clamp01(safeDiv(countOccurrences(t, IMPERSONAL_PATTERNS), Math.max(1, sentences.length)) * 0.55);
  const transitionOveruse = clamp01(safeDiv(countOccurrences(t, TRANSITION_PATTERNS), Math.max(1, sentences.length)) * 0.42);
  const compression = clamp01(safeDiv(countOccurrences(t, COMPRESSION_PATTERNS), Math.max(1, sentences.length)) * 1.2);
  const overFormalization = clamp01(safeDiv(countOccurrences(t, OVER_FORMAL_PATTERNS), Math.max(1, sentences.length)) * 0.9);
  const overColloquialization = clamp01(safeDiv(countOccurrences(t, OVER_COLLOQ_PATTERNS), Math.max(1, sentences.length)) * 0.9);

  const repetition = clamp01(ngramRepetition(toks.map(x => x.toLowerCase()), 3) * 3.0);
  const uniformity = clamp01((1 - Math.min(1, lengthCv / 0.75)) * 0.7 + (endingEntropy < 1.2 ? 0.3 : 0));
  const lexicalFlatness = clamp01(1 - mattr(t, 45));
  const anchors = extractProtectedTerms(t);
  const anchorDensity = safeDiv(anchors.length, Math.max(1, charLen / 100));
  const anchorDeficit = clamp01(1 - Math.min(1, anchorDensity / 1.25));
  const sentenceLengthRisk = avgSentLen > 95 ? clamp01((avgSentLen - 75) / 80) : 0;

  const components = {
    abstractness,
    formulaic,
    rhetorical,
    claimStrength,
    impersonal,
    transitionOveruse,
    compression,
    overFormalization,
    overColloquialization,
    repetition,
    uniformity,
    lexicalFlatness,
    anchorDeficit,
    sentenceLengthRisk,
    anchorDensity,
    lengthCv,
    paraCv,
    endingEntropy,
    avgSentLen,
    sentenceCount: sentences.length,
    paragraphCount: paras.length,
    charLen
  };

  const w = (policy && policy.weights) || {};
  const raw = -1.45
    + (w.abstractness ?? 1.25) * abstractness
    + (w.formulaic ?? 1.35) * formulaic
    + (w.rhetorical ?? 1.65) * rhetorical
    + (w.claimStrength ?? 1.15) * claimStrength
    + (w.impersonal ?? 0.85) * impersonal
    + (w.transitionOveruse ?? 0.75) * transitionOveruse
    + (w.compression ?? 0.85) * compression
    + (w.overFormalization ?? 0.95) * overFormalization
    + (w.overColloquialization ?? 0.35) * overColloquialization
    + (w.repetition ?? 0.9) * repetition
    + (w.uniformity ?? 1.2) * uniformity
    + (w.lexicalFlatness ?? 0.45) * lexicalFlatness
    + (w.anchorDeficit ?? 0.8) * anchorDeficit
    + (w.sentenceLengthRisk ?? 0.45) * sentenceLengthRisk;

  const risk = sigmoid(raw);
  return { risk, components, anchors };
}

function scoreBlock(block, policy = {}) {
  return scoreText(block.text || '', policy);
}

module.exports = {
  scoreText,
  scoreBlock,
  patterns: {
    ABSTRACT_PATTERNS,
    FORMULAIC_PATTERNS,
    RHETORICAL_PATTERNS,
    CLAIM_STRENGTH_PATTERNS,
    IMPERSONAL_PATTERNS,
    TRANSITION_PATTERNS,
    COMPRESSION_PATTERNS,
    OVER_FORMAL_PATTERNS,
    OVER_COLLOQ_PATTERNS
  }
};
