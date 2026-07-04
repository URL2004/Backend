'use strict';

function splitSentences(text) {
  const normalized = String(text || '').replace(/\r/g, '');
  const chunks = normalized
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (chunks.length) return chunks;
  return normalized.trim() ? [normalized.trim()] : [];
}

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
  const paragraphs = String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
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
    firstPersonCount: countRe(text, /(?:저는|제가|저희|우리|나는|내가|나의|제\s|필자|본인)/g),
    thirdPersonCueCount: countRe(text, /(?:교사는|작성자는|글쓴이는|연구자는|기업은|사용자는|소비자는|보호자는)/g)
  };
}

function classifyEnding(compactSentence) {
  if (/(?:습니다|습니까|합니다|합니까|됩니다|됩니까|입니다|입니까|했습니다|였습니다|됩니다|립니다|봅니다)$/.test(compactSentence)) return 'hap';
  if (/(?:어요|아요|해요|돼요|예요|이에요|네요|죠|지요|군요|나요)$/.test(compactSentence)) return 'haeyo';
  if (/(?:다|였다|했다|한다|된다|이다|아니다|있다|없다|었다|였다|한다)$/.test(compactSentence)) return 'plain';
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
