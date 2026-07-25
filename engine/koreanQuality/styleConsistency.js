'use strict';

const { splitSentences } = require('../koreanText');
const { computePovSeed } = require('../pov');
const { classifySentenceEnding } = require('../endingStyle');

function analyzeStyle(text) {
  const sentences = splitSentences(text);
  const endings = { hap: 0, haeyo: 0, plain: 0, other: 0 };
  const lengths = [];
  for (const sentence of sentences) {
    const body = sentence.replace(/[.!?。！？]+$/g, '').trim();
    const compact = body.replace(/\s+/g, '');
    if (!compact) continue;
    lengths.push(compact.length);
    const ending = classifyEnding(compact);
    endings[ending] = (endings[ending] || 0) + 1;
  }
  const totalEndings = endings.hap + endings.haeyo + endings.plain;
  const dominant = dominantRegister(endings);
  const registerMixRisk = measureRegisterMix(endings, totalEndings);
  const rhythm = measureRhythm(lengths);
  const paragraphs = String(text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
  const oneSentenceParagraphs = paragraphs.filter(p => splitSentences(p).length <= 1 && p.length >= 20).length;
  const paragraphFragmentRisk = paragraphs.length >= 4
    ? Math.min(1, oneSentenceParagraphs / Math.max(1, paragraphs.length))
    : 0;
  return {
    sentenceCount: sentences.length,
    endings,
    totalEndings,
    dominantRegister: dominant.register,
    dominantRatio: dominant.ratio,
    registerMixRisk,
    rhythm,
    oneSentenceParagraphs,
    paragraphFragmentRisk,
    firstPersonCount: firstPersonCount(text),
    thirdPersonCueCount: countRe(text, /(?:교사는|작성자는|글쓴이는|연구자는|기업은|사용자는|소비자는|보호자는)/g)
  };
}

function firstPersonCount(value) {
  const seed = computePovSeed(value);
  return seed.fp_singular
    + seed.fp_plural
    + countRe(value, /(?<![가-힣A-Za-z0-9_])(?:필자|본인)(?![가-힣A-Za-z0-9_])/gu);
}

function classifyEnding(compactSentence) {
  const style = classifySentenceEnding(compactSentence, { includeNominal: false });
  if (style === 'polite') return 'hap';
  if (style === 'haeyo') return 'haeyo';
  if (style === 'plain') return 'plain';
  return 'other';
}

function dominantRegister(endings) {
  const pairs = ['hap', 'haeyo', 'plain'].map(k => [k, endings[k] || 0]).sort((a, b) => b[1] - a[1]);
  const total = pairs.reduce((n, [, c]) => n + c, 0);
  if (!total) return { register: 'unknown', ratio: 0 };
  return { register: pairs[0][0], ratio: pairs[0][1] / total };
}

function measureRegisterMix(endings, total) {
  if (!total || total < 4) return 0;
  const active = ['hap', 'haeyo', 'plain'].filter(k => (endings[k] || 0) >= 2);
  if (active.length <= 1) return 0;
  const top = Math.max(endings.hap || 0, endings.haeyo || 0, endings.plain || 0);
  return Number(Math.min(1, (total - top) / total + (active.length - 1) * 0.12).toFixed(3));
}

function measureRhythm(lengths) {
  if (!lengths.length) return { avg: 0, cv: 0, uniformRisk: 0 };
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((acc, n) => acc + Math.pow(n - avg, 2), 0) / lengths.length;
  const sd = Math.sqrt(variance);
  const cv = avg > 0 ? sd / avg : 0;
  const uniformRisk = lengths.length >= 5 && cv < 0.23 ? Number((0.23 - cv).toFixed(3)) : 0;
  return {
    avg: Number(avg.toFixed(1)),
    cv: Number(cv.toFixed(3)),
    uniformRisk
  };
}

function compareStyle(before, after) {
  const sourceStyle = before || {};
  const outputStyle = after || {};
  const povIntroduced = (sourceStyle.firstPersonCount || 0) === 0 && (outputStyle.firstPersonCount || 0) >= 2;
  const firstPersonDropped = (sourceStyle.firstPersonCount || 0) >= 2 && (outputStyle.firstPersonCount || 0) === 0;
  const registerShiftSevere = sourceStyle.dominantRegister &&
    outputStyle.dominantRegister &&
    sourceStyle.dominantRegister !== 'unknown' &&
    outputStyle.dominantRegister !== 'unknown' &&
    sourceStyle.dominantRegister !== outputStyle.dominantRegister &&
    (sourceStyle.dominantRatio || 0) >= 0.65 &&
    (outputStyle.dominantRatio || 0) >= 0.65;
  return {
    povIntroduced,
    firstPersonDropped,
    registerShiftSevere,
    sourceRegister: sourceStyle.dominantRegister || 'unknown',
    outputRegister: outputStyle.dominantRegister || 'unknown'
  };
}

function countRe(text, re) {
  const matches = String(text || '').match(re);
  return matches ? matches.length : 0;
}

module.exports = {
  splitSentences,
  analyzeStyle,
  compareStyle
};
