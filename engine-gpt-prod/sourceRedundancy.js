'use strict';

const { splitSentences } = require('../engine/koreanText');
const {
  sentenceSimilarity,
  normalizeSentence
} = require('./sentenceAlignment');

const VERSION = 1;
const MIN_RUN_SENTENCES = 3;
const MIN_RUN_CHARS = 150;
const MIN_PAIR_SIMILARITY = 0.55;
const MIN_AVERAGE_SIMILARITY = 0.76;
const STRONG_PAIR_SIMILARITY = 0.84;
const MAX_RUNS = 3;

/**
 * 원문 자체에 연속된 설명 블록이 두 번 들어간 경우를 찾는다.
 * 이 계획은 삭제기가 아니다. 후반 반복 구간을 모델의 재구성 대상으로
 * 표시할 뿐이며, 실제 후보는 기존 의미·수치·구조 감사 전체를 통과해야 한다.
 */
function buildSourceRedundancyPlan(source, documentProfile = null) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  if (['creative', 'legal_contract'].includes(profile)) return emptyPlan(false);
  const sentences = meaningfulSentences(source);
  if (sentences.length < MIN_RUN_SENTENCES * 2) return emptyPlan(false);
  const runs = detectRepeatedRuns(sentences);
  const targetIndices = [...new Set(runs.flatMap(run => (
    Array.from({ length: run.length }, (_unused, offset) => run.duplicateStart + offset)
  )))].sort((left, right) => left - right);
  return {
    version: VERSION,
    applicable: runs.length > 0,
    repeatedRunCount: runs.length,
    duplicateSentenceCount: targetIndices.length,
    targetSentenceCount: targetIndices.length,
    targetIndices,
    runs: runs.map(run => ({
      originalStart: run.originalStart,
      duplicateStart: run.duplicateStart,
      length: run.length,
      averageSimilarity: round4(run.averageSimilarity)
    }))
  };
}

function compareSourceRedundancy(output, plan = null) {
  if (plan?.applicable !== true) {
    return {
      version: VERSION,
      applicable: false,
      pass: true,
      sourceDuplicateSentenceCount: 0,
      outputDuplicateSentenceCount: 0,
      achievedReduction: 0,
      requiredReduction: 0
    };
  }
  const outputPlan = buildSourceRedundancyPlan(output, { profile: 'unknown' });
  const sourceCount = Number(plan.duplicateSentenceCount || 0);
  const outputCount = Number(outputPlan.duplicateSentenceCount || 0);
  const requiredReduction = Math.max(1, Math.ceil(sourceCount * 0.4));
  const achievedReduction = Math.max(0, sourceCount - outputCount);
  return {
    version: VERSION,
    applicable: true,
    pass: achievedReduction >= requiredReduction,
    sourceDuplicateSentenceCount: sourceCount,
    outputDuplicateSentenceCount: outputCount,
    achievedReduction,
    requiredReduction,
    remainingRepeatedRunCount: Number(outputPlan.repeatedRunCount || 0)
  };
}

function detectRepeatedRuns(sentences) {
  const candidates = [];
  for (let originalStart = 0; originalStart <= sentences.length - MIN_RUN_SENTENCES * 2; originalStart += 1) {
    for (let duplicateStart = originalStart + MIN_RUN_SENTENCES;
      duplicateStart <= sentences.length - MIN_RUN_SENTENCES;
      duplicateStart += 1) {
      const maximum = Math.min(
        duplicateStart - originalStart,
        sentences.length - duplicateStart
      );
      let length = 0;
      let similaritySum = 0;
      let strongPairCount = 0;
      while (length < maximum) {
        const similarity = sentencePairSimilarity(
          sentences[originalStart + length],
          sentences[duplicateStart + length]
        );
        if (similarity < MIN_PAIR_SIMILARITY) break;
        similaritySum += similarity;
        if (similarity >= STRONG_PAIR_SIMILARITY) strongPairCount += 1;
        length += 1;
      }
      if (length < MIN_RUN_SENTENCES) continue;
      const duplicateChars = sentences
        .slice(duplicateStart, duplicateStart + length)
        .reduce((sum, sentence) => sum + normalizeSentence(sentence).length, 0);
      const averageSimilarity = similaritySum / length;
      const requiredStrongPairs = Math.max(2, Math.ceil(length * 0.2));
      if (duplicateChars < MIN_RUN_CHARS
          || averageSimilarity < MIN_AVERAGE_SIMILARITY
          || strongPairCount < requiredStrongPairs) continue;
      candidates.push({
        originalStart,
        duplicateStart,
        length,
        duplicateChars,
        averageSimilarity,
        strongPairCount
      });
    }
  }
  candidates.sort((left, right) => (
    right.length - left.length
      || right.averageSimilarity - left.averageSimilarity
      || left.duplicateStart - right.duplicateStart
  ));
  const selected = [];
  for (const candidate of candidates) {
    const candidateEnd = candidate.duplicateStart + candidate.length;
    if (selected.some(run => rangesOverlap(
      candidate.duplicateStart,
      candidateEnd,
      run.duplicateStart,
      run.duplicateStart + run.length
    ))) continue;
    selected.push(candidate);
    if (selected.length >= MAX_RUNS) break;
  }
  return selected.sort((left, right) => left.duplicateStart - right.duplicateStart);
}

function sentencePairSimilarity(left, right) {
  if (/^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|\d{1,3}[.)]|제\s*\d+\s*조)/u.test(String(left || '').trim())
      || /^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|\d{1,3}[.)]|제\s*\d+\s*조)/u.test(String(right || '').trim())) {
    return 0;
  }
  if (!protectedFactsCompatible(left, right)) return 0;
  const a = normalizeSentence(left);
  const b = normalizeSentence(right);
  if (!a || !b || Math.min(a.length, b.length) < 12) return 0;
  if (a === b) return 1;
  return sentenceSimilarity(left, right);
}

function protectedFactsCompatible(left, right) {
  const a = protectedFactSignature(left);
  const b = protectedFactSignature(right);
  return sameValues(a.numbers, b.numbers)
    && sameValues(a.quotes, b.quotes)
    && a.negated === b.negated;
}

function protectedFactSignature(value) {
  const text = String(value || '');
  return {
    numbers: uniqueSorted(text.match(/\d+(?:[.,]\d+)*(?:%|％|년|월|일|명|개|건|회|배|원|초|분|시간)?/gu) || []),
    quotes: uniqueSorted((text.match(/[“‘「『《〈"'][^”’」』》〉"'\n]{2,80}[”’」』》〉"']/gu) || [])
      .map(item => normalizeSentence(item))),
    negated: /(?:않|아니|없|못하|금지|제외|불가|비허용)/u.test(text)
  };
}

function uniqueSorted(values) {
  return [...new Set((values || []).map(value => String(value || '').replace(/\s+/gu, '').toLowerCase()))].sort();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function meaningfulSentences(value) {
  return splitSentences(String(value || ''))
    .map(sentence => String(sentence || '').trim())
    // humanizationDepth의 문장 인덱스와 정확히 같은 공간을 유지한다.
    // 짧은 문장은 pair 비교에서 0점 처리하되 여기서 제거해 뒤 인덱스를
    // 앞으로 당기지 않는다.
    .filter(sentence => normalizeSentence(sentence).length >= 3);
}

function publicSourceRedundancyPlan(plan = null) {
  return {
    version: VERSION,
    applicable: plan?.applicable === true,
    repeatedRunCount: Number(plan?.repeatedRunCount || 0),
    duplicateSentenceCount: Number(plan?.duplicateSentenceCount || 0),
    targetSentenceCount: Number(plan?.targetSentenceCount || 0)
  };
}

function emptyPlan(applicable) {
  return {
    version: VERSION,
    applicable,
    repeatedRunCount: 0,
    duplicateSentenceCount: 0,
    targetSentenceCount: 0,
    targetIndices: [],
    runs: []
  };
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
}

module.exports = {
  VERSION,
  MIN_RUN_SENTENCES,
  buildSourceRedundancyPlan,
  compareSourceRedundancy,
  detectRepeatedRuns,
  publicSourceRedundancyPlan
};
