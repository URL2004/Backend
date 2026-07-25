'use strict';

const { splitSentences, levenshteinDistance } = require('../engine/koreanText');

const DEFAULT_WINDOW = 3;
const DEFAULT_MAX_OUTPUT_GROUP = 3;

/**
 * 문장 단위 감사를 위한 공통 1:N/N:1 정렬기다.
 *
 * 모델은 한 원문 문장을 둘 이상의 결과 문장으로 나누거나, 둘을 하나로
 * 합칠 수 있다. 기존 감사기들은 예상 위치 주변의 단일 문장 중 하나만
 * 골라 관계 표지·전문 어휘가 사라졌다고 오판했다. 이 정렬기는 예상 위치
 * 주변의 연속 문장 묶음을 함께 비교하고 모든 감사기가 같은 결과를 쓴다.
 */
function alignSourceSentence(sourceSentence, sourceIndex, sourceCount, outputSentences, {
  window = DEFAULT_WINDOW,
  maxOutputGroup = DEFAULT_MAX_OUTPUT_GROUP
} = {}) {
  const output = normalizeSentenceList(outputSentences);
  if (!String(sourceSentence || '').trim() || !output.length) return null;
  const center = sourceCount <= 1
    ? 0
    : Math.round(sourceIndex * Math.max(0, output.length - 1) / Math.max(1, sourceCount - 1));
  const candidates = [];
  const seen = new Set();
  const minStart = Math.max(0, center - window);
  const maxStart = Math.min(output.length - 1, center + window);
  for (let start = minStart; start <= maxStart; start += 1) {
    for (let size = 1; size <= Math.max(1, maxOutputGroup); size += 1) {
      const end = Math.min(output.length, start + size);
      if (end <= start) continue;
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sentences = output.slice(start, end);
      const text = sentences.join(' ');
      const rawScore = sentenceSimilarity(sourceSentence, text);
      const positionalPenalty = Math.min(0.12, Math.abs(center - start) * 0.018);
      const groupPenalty = Math.max(0, sentences.length - 1) * 0.012;
      candidates.push({
        start,
        end,
        index: start,
        sentence: text,
        text,
        sentences,
        score: round4(Math.max(0, rawScore - positionalPenalty - groupPenalty)),
        rawScore: round4(rawScore)
      });
    }
  }
  candidates.sort((left, right) => (
    right.score - left.score
      || left.sentences.length - right.sentences.length
      || Math.abs(left.start - center) - Math.abs(right.start - center)
      || left.start - right.start
  ));
  const best = candidates[0] || null;
  if (!best) return null;
  return {
    ...best,
    center,
    candidates
  };
}

function alignedOutputCandidates(sourceSentence, sourceIndex, sourceCount, outputSentences, options = {}) {
  return alignSourceSentence(
    sourceSentence,
    sourceIndex,
    sourceCount,
    outputSentences,
    options
  )?.candidates || [];
}

function alignSentenceLists(source, output, options = {}) {
  const sourceSentences = normalizeSentenceList(source);
  const outputSentences = normalizeSentenceList(output);
  return sourceSentences.map((sentence, index) => ({
    sourceIndex: index,
    sourceSentence: sentence,
    alignment: alignSourceSentence(sentence, index, sourceSentences.length, outputSentences, options)
  }));
}

function normalizeSentenceList(value) {
  const rows = Array.isArray(value) ? value : splitSentences(String(value || ''));
  return rows.map(item => String(item || '').trim()).filter(Boolean);
}

function sentenceSimilarity(left, right) {
  const leftTokens = new Set(contentTokens(left));
  const rightTokens = new Set(contentTokens(right));
  const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const sourceCoverage = shared / Math.max(1, leftTokens.size);
  const outputPrecision = shared / Math.max(1, rightTokens.size);
  const a = normalizeSentence(left);
  const b = normalizeSentence(right);
  const editSimilarity = 1 - (levenshteinDistance(a, b) / Math.max(1, a.length, b.length));
  const lengthRatio = Math.min(a.length, b.length) / Math.max(1, a.length, b.length);
  return Math.max(
    sourceCoverage * 0.72 + outputPrecision * 0.08 + editSimilarity * 0.20,
    editSimilarity * 0.72,
    sourceCoverage * 0.82 + lengthRatio * 0.08
  );
}

function contentTokens(value) {
  return [...new Set((String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}|\d+(?:\.\d+)?/gu) || [])
    .map(token => token.toLowerCase().replace(
      /(?:하였습니다|했습니다|하였다|했다|에서는|으로는|에게는|이라는|으로|에서|에게|보다|처럼|하고|하며|하여|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u,
      ''
    ))
    .filter(token => token.length >= 2 && ![
      '그러나', '하지만', '그리고', '또한', '따라서', '이러한', '그러한'
    ].includes(token)))];
}

function normalizeSentence(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/gu, '');
}

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
}

module.exports = {
  DEFAULT_WINDOW,
  DEFAULT_MAX_OUTPUT_GROUP,
  alignSourceSentence,
  alignedOutputCandidates,
  alignSentenceLists,
  normalizeSentenceList,
  sentenceSimilarity,
  contentTokens,
  normalizeSentence
};
