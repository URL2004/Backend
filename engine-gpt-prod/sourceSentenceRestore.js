'use strict';

const { splitSentenceSpans, levenshteinDistance } = require('../engine/koreanText');

// 모델 수리까지 실패했을 때 문서 전체를 버리지 않고, 원문과 결과의 문장
// 배열이 안전하게 일대일 대응하는 경우에만 문제 문장을 원문으로 되돌린다.
// 특정 장르나 문구를 알지 못하는 공용 안전 장치다.
function restoreSourceSentenceOrdinals(source, outputText, sentenceOrdinals, {
  maxRestoreCount = 8,
  minSimilarity = 0.24
} = {}) {
  const before = String(outputText || '');
  const sourceSpans = splitSentenceSpans(String(source || ''));
  const outputSpans = splitSentenceSpans(before);
  const requested = [...new Set((sentenceOrdinals || [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, Number(maxRestoreCount) || 0));

  if (!requested.length) return result(before, false, [], 'no_target');
  if (!sourceSpans.length || sourceSpans.length !== outputSpans.length) {
    return result(before, false, [], 'sentence_alignment_mismatch');
  }

  const replacements = [];
  for (const ordinal of requested) {
    const index = ordinal - 1;
    const sourceSpan = sourceSpans[index];
    const outputSpan = outputSpans[index];
    if (!sourceSpan || !outputSpan) continue;
    if (normalize(sourceSpan.text) === normalize(outputSpan.text)) continue;
    if (sentenceSimilarity(sourceSpan.text, outputSpan.text) < minSimilarity) continue;
    replacements.push({
      ordinal,
      start: outputSpan.start,
      end: outputSpan.end,
      text: sourceSpan.text
    });
  }
  if (!replacements.length) return result(before, false, [], 'no_safe_alignment');

  let text = before;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  }
  return result(text, text !== before, replacements.map(item => item.ordinal), 'restored');
}

function sentenceSimilarity(left, right) {
  const leftTokens = contentTokens(left);
  const rightTokens = new Set(contentTokens(right));
  const tokenOverlap = leftTokens.filter(token => rightTokens.has(token)).length / Math.max(1, leftTokens.length);
  const a = normalize(left);
  const b = normalize(right);
  const editSimilarity = 1 - (levenshteinDistance(a, b) / Math.max(1, a.length, b.length));
  return Math.max(tokenOverlap, editSimilarity * 0.8);
}

function contentTokens(value) {
  return [...new Set((String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}|\d+(?:\.\d+)?/gu) || [])
    .map(token => token.toLowerCase().replace(/(?:하였습니다|했습니다|하였다|했다|에서는|으로는|으로|에서|하고|하며|하여|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u, ''))
    .filter(token => token.length >= 2))];
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/gu, '');
}

function result(text, applied, restoredSentenceOrdinals, reason) {
  return {
    text,
    applied,
    restoredSentenceCount: restoredSentenceOrdinals.length,
    restoredSentenceOrdinals,
    reason
  };
}

module.exports = {
  restoreSourceSentenceOrdinals,
  sentenceSimilarity
};
