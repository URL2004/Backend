'use strict';

const CONNECTOR_PATTERNS = [
  /또한/gu, /따라서/gu, /이에\s*따라/gu, /이러한/gu, /이를\s*통해/gu,
  /나아가/gu, /한편/gu, /결론적으로/gu, /즉[, ]/gu, /첫째/gu, /둘째/gu, /셋째/gu
];
const STOCK_REPORT_PATTERNS = [
  /할\s*수\s*있(?:다|습니다)/gu, /볼\s*수\s*있(?:다|습니다)/gu,
  /필요가\s*있(?:다|습니다)/gu, /중요(?:하|한)\s*(?:의미|역할|요인)?/gu,
  /의미를\s*가진(?:다|다고|다고\s*볼)/gu, /긍정적인\s*영향/gu,
  /체계적으로\s*(?:정리|분석|관리|운영)/gu, /기반으로\s*(?:한|하여|한다|합니다)/gu,
  /핵심\s*인프라/gu, /전략적\s*이점/gu, /효율(?:성|적)/gu
];
const GENERIC_ABSTRACT_PATTERNS = [
  /중요/gu, /필요/gu, /효율/gu, /전략/gu, /체계/gu, /역할/gu, /경험/gu,
  /가치/gu, /역량/gu, /기반/gu, /영향/gu, /과정/gu, /측면/gu, /요인/gu,
  /문제/gu, /개선/gu, /확대/gu, /강화/gu
];
const OVER_POLISHED_ENDINGS = [
  /(?:할|될)\s*수\s*있(?:다|습니다)[.?!]?$/u,
  /(?:라고|다고)\s*볼\s*수\s*있(?:다|습니다)[.?!]?$/u,
  /필요가\s*있(?:다|습니다)[.?!]?$/u,
  /중요(?:하다고\s*생각한다|하다|합니다)[.?!]?$/u,
  /마무리(?:되었다|되었습니다|된다|됩니다)[.?!]?$/u,
  /이어(?:진다|집니다)[.?!]?$/u
];

function measureNaturalnessShadow(value) {
  const text = String(value || '');
  // 운영 81건 기준선과 연속 비교하기 위한 shadow 전용 v1 측정 분리기다.
  // 실제 변환·청킹·감사 판정은 engine/koreanText의 통합 분리기를 사용한다.
  const sentences = splitShadowSentences(text);
  const paragraphs = text.split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean);
  const compactLength = text.replace(/\s+/gu, '').length;
  const connectorCount = countMany(text, CONNECTOR_PATTERNS);
  const stockCount = countMany(text, STOCK_REPORT_PATTERNS);
  const genericCount = countMany(text, GENERIC_ABSTRACT_PATTERNS);
  const endingCount = sentences.filter(sentence => OVER_POLISHED_ENDINGS.some(pattern => pattern.test(sentence.trim().slice(-40)))).length;
  const rhythm = measureRhythm(sentences);
  const paragraphShape = measureParagraphShape(paragraphs);
  const concrete = measureConcreteAnchors(text, sentences.length);
  const sentenceCount = Math.max(1, sentences.length);
  const metrics = {
    connectorRepetition: round3(Math.min(1, connectorCount / Math.max(4, sentenceCount * 0.65))),
    stockReportPhrase: round3(Math.min(1, stockCount / Math.max(3, sentenceCount * 0.45))),
    genericAbstractness: round3(Math.min(1, genericCount / Math.max(8, compactLength / 120))),
    uniformSentenceRhythm: rhythm.risk,
    paragraphSymmetry: paragraphShape.risk,
    overPolishedEnding: round3(Math.min(1, endingCount / Math.max(3, sentenceCount * 0.40))),
    concreteAnchorScarcity: concrete.scarcityRisk
  };
  const overallRisk = round3(Math.min(1,
    metrics.connectorRepetition * 0.17 +
    metrics.stockReportPhrase * 0.19 +
    metrics.genericAbstractness * 0.14 +
    metrics.uniformSentenceRhythm * 0.18 +
    metrics.paragraphSymmetry * 0.10 +
    metrics.overPolishedEnding * 0.14 +
    metrics.concreteAnchorScarcity * 0.08
  ));
  return {
    version: 2,
    shadowOnly: true,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    counts: { connectorCount, stockCount, genericCount, overPolishedEndingCount: endingCount, concreteAnchorCount: concrete.anchorCount },
    sentenceCv: rhythm.cv,
    paragraphCv: paragraphShape.cv,
    rhythm,
    paragraphShape,
    metrics,
    overallRisk
  };
}

function compareNaturalnessShadow(source, output) {
  const before = measureNaturalnessShadow(source);
  const after = measureNaturalnessShadow(output);
  const delta = {};
  for (const key of Object.keys(before.metrics)) delta[key] = round3(after.metrics[key] - before.metrics[key]);
  delta.overallRisk = round3(after.overallRisk - before.overallRisk);
  return {
    version: 2,
    shadowOnly: true,
    before,
    after,
    delta,
    // 운영 81건 기준선(20건)과 같은 정의: 전체 과정돈 위험이 0.03 이상 증가.
    riskIncreased: delta.overallRisk >= 0.03,
    rhythmUniformityDelta: delta.uniformSentenceRhythm
  };
}

function measureRhythm(sentences) {
  const lengths = sentences.map(sentence => sentence.replace(/\s+/gu, '').length).filter(Boolean);
  if (lengths.length < 4) return { sentenceCount: lengths.length, avg: average(lengths), cv: 1, risk: 0 };
  const avg = average(lengths);
  const sd = Math.sqrt(average(lengths.map(value => (value - avg) ** 2)));
  const cv = avg ? sd / avg : 1;
  const sameBand = lengths.filter(value => Math.abs(value - avg) <= Math.max(8, avg * 0.18)).length / lengths.length;
  const risk = round3(Math.max(0, Math.min(1, (0.42 - cv) * 1.9 + Math.max(0, sameBand - 0.55))));
  return { sentenceCount: lengths.length, avg: round3(avg), min: Math.min(...lengths), max: Math.max(...lengths), cv: round3(cv), sameBand: round3(sameBand), risk };
}

function measureParagraphShape(paragraphs) {
  const lengths = paragraphs.map(paragraph => paragraph.replace(/\s+/gu, '').length).filter(value => value >= 20);
  if (lengths.length < 4) return { paragraphCount: lengths.length, avg: average(lengths), cv: 1, risk: 0 };
  const avg = average(lengths);
  const sd = Math.sqrt(average(lengths.map(value => (value - avg) ** 2)));
  const cv = avg ? sd / avg : 1;
  const risk = round3(Math.max(0, Math.min(1, (0.34 - cv) * 1.8)));
  return { paragraphCount: lengths.length, avg: round3(avg), min: Math.min(...lengths), max: Math.max(...lengths), cv: round3(cv), risk };
}

function measureConcreteAnchors(text, sentenceCount) {
  const source = String(text || '');
  const anchors = [
    ...(source.match(/\d+(?:[.,]\d+)?\s*(?:%|원|명|개|회|년|월|일|시간|분|평|건)?/gu) || []),
    ...(source.match(/["“”'‘’][^"“”'‘’]{2,40}["“”'‘’]/gu) || []),
    ...(source.match(/[A-Z][A-Za-z0-9-]{2,}/gu) || []),
    ...(source.match(/[가-힣A-Za-z0-9·-]{2,}(?:시스템|서비스|제품|기관|회사|학교|병원|터미널|소방서|우체국|플랫폼|프로그램)/gu) || [])
  ];
  const anchorCount = anchors.length;
  const density = anchorCount / Math.max(1, sentenceCount || 1);
  return { anchorCount, density: round3(density), scarcityRisk: round3(Math.max(0, Math.min(1, 0.55 - density))) };
}

function countMany(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (String(text || '').match(new RegExp(pattern.source, pattern.flags)) || []).length, 0);
}

function splitShadowSentences(text) {
  return (String(text || '').replace(/\r\n/gu, '\n').match(/[^.!?。？！\n]+[.!?。？！]?/gu) || [])
    .map(value => value.trim())
    .filter(value => value.replace(/\s+/gu, '').length >= 3);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round3(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
}

module.exports = { measureNaturalnessShadow, compareNaturalnessShadow };
