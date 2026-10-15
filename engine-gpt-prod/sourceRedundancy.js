'use strict';

const { splitSentences } = require('../engine/koreanText');
const { createHash } = require('node:crypto');
const {
  sentenceSimilarityFeatures,
  sentenceFeatureSimilarity,
  normalizeSentence
} = require('./sentenceAlignment');

const VERSION = 1;
const MIN_RUN_SENTENCES = 3;
const MIN_RUN_CHARS = 150;
const MIN_PAIR_SIMILARITY = 0.55;
const MIN_AVERAGE_SIMILARITY = 0.76;
const STRONG_PAIR_SIMILARITY = 0.84;
const MAX_RUNS = 3;
const MAX_SCORE_CACHE_BYTES = 32 * 1024 * 1024;
// The routing result owns the profile for this request. Reuse source-derived
// plans across basic/advanced planning without retaining source text globally.
// Keys contain only an exact digest; a caller receives its own mutable copy.
const plansByProfile = new WeakMap();
const clonePlan = plan => ({ ...plan, targetIndices: [...plan.targetIndices], runs: plan.runs.map(run => ({ ...run })) });

/**
 * 원문 자체에 연속된 설명 블록이 두 번 들어간 경우를 찾는다.
 * 이 계획은 삭제기가 아니다. 후반 반복 구간을 모델의 재구성 대상으로
 * 표시할 뿐이며, 실제 후보는 기존 의미·수치·구조 감사 전체를 통과해야 한다.
 */
function buildSourceRedundancyPlan(source, documentProfile = null) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  if (['creative', 'legal_contract'].includes(profile)) return emptyPlan(false);
  const cacheOwner = documentProfile && typeof documentProfile === 'object' ? documentProfile : null;
  const key = cacheOwner ? `${profile}:${createHash('sha256').update(String(source || '')).digest('hex')}` : '';
  const cached = cacheOwner && plansByProfile.get(cacheOwner)?.get(key);
  if (cached) return clonePlan(cached);
  const sentences = meaningfulSentences(source);
  if (sentences.length < MIN_RUN_SENTENCES * 2) return emptyPlan(false);
  const runs = detectRepeatedRuns(sentences);
  const targetIndices = [...new Set(runs.flatMap(run => (
    Array.from({ length: run.length }, (_unused, offset) => run.duplicateStart + offset)
  )))].sort((left, right) => left - right);
  const plan = {
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
  if (cacheOwner) {
    if (!plansByProfile.has(cacheOwner)) plansByProfile.set(cacheOwner, new Map());
    const cache = plansByProfile.get(cacheOwner);
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(key, clonePlan(plan));
  }
  return plan;
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
  // Every original (i,j) candidate still participates, including suffixes of
  // longer runs. Diagonal runs and prefix statistics replace repeated extension
  // scans; skipping non-maximal runs would change the three-run selection.
  const byText = new Map();
  const features = sentences.map(sentence => {
    if (!byText.has(sentence)) byText.set(sentence, sentenceFeatures(sentence));
    return byText.get(sentence);
  });
  const charPrefix = [0];
  features.forEach(feature => charPrefix.push(charPrefix.at(-1) + feature.normalized.length));
  // Greedy selection after a global sort is equivalent to finding the best
  // non-overlapping candidate in each of three passes. Do not retain O(n?)
  // candidate objects: dense, short repeated sentences otherwise exhaust a
  // worker's heap. The optional numeric score cache has a fixed 32 MiB ceiling.
  const selected = [];
  const scoreCache = new Map();
  let cachedBytes = 0;
  for (let pass = 0; pass < MAX_RUNS; pass += 1) {
    let best = null;
    for (let offset = MIN_RUN_SENTENCES; offset <= sentences.length - MIN_RUN_SENTENCES; offset += 1) {
      const count = sentences.length - offset;
      let scores = scoreCache.get(offset);
      if (!scores) {
        scores = new Float64Array(count);
        for (let index = 0; index < count; index += 1) {
          scores[index] = featurePairSimilarity(features[index], features[index + offset]);
        }
        if (pass === 0 && cachedBytes + scores.byteLength <= MAX_SCORE_CACHE_BYTES) {
          scoreCache.set(offset, scores);
          cachedBytes += scores.byteLength;
        }
      }
      const ends = new Uint32Array(count + 1);
      const sums = new Float64Array(count + 1);
      const strong = new Uint32Array(count + 1);
      const fractional = new Uint32Array(count + 1);
      for (let index = 0; index < count; index += 1) {
        const score = scores[index];
        sums[index + 1] = sums[index] + score;
        strong[index + 1] = strong[index] + Number(score >= STRONG_PAIR_SIMILARITY);
        fractional[index + 1] = fractional[index] + Number(score !== 0 && score !== 1);
      }
      ends[count] = count;
      for (let index = count - 1; index >= 0; index -= 1) {
        ends[index] = scores[index] < MIN_PAIR_SIMILARITY ? index : ends[index + 1];
      }
      // Each prefix contains at most count additions of values in [0, 1].
      // Include both accumulated prefixes and the legacy sum's roundoff.
      const tolerance = Number.EPSILON * count * count * 4;
      for (let originalStart = 0; originalStart <= Math.min(sentences.length - MIN_RUN_SENTENCES * 2, count - MIN_RUN_SENTENCES); originalStart += 1) {
        const duplicateStart = originalStart + offset;
        const length = Math.min(offset, ends[originalStart] - originalStart);
        if (length < MIN_RUN_SENTENCES || (best && length < best.length)) continue;
        const duplicateChars = charPrefix[duplicateStart + length] - charPrefix[duplicateStart];
        const strongPairCount = strong[originalStart + length] - strong[originalStart];
        const requiredStrongPairs = Math.max(2, Math.ceil(length * 0.2));
        if (duplicateChars < MIN_RUN_CHARS || strongPairCount < requiredStrongPairs) continue;
        if (selected.some(run => rangesOverlap(duplicateStart, duplicateStart + length,
          run.duplicateStart, run.duplicateStart + run.length))) continue;
        const candidate = {
          originalStart, duplicateStart, length, duplicateChars,
          averageSimilarity: (sums[originalStart + length] - sums[originalStart]) / length,
          strongPairCount, scores, tolerance,
          exactAverage: fractional[originalStart + length] === fractional[originalStart]
        };
        if (candidate.exactAverage) candidate.averageSimilarity = 1;
        // Resolve floating thresholds and ties in the legacy addition order.
        if (Math.abs(candidate.averageSimilarity - MIN_AVERAGE_SIMILARITY) <= tolerance) exactAverage(candidate);
        if (candidate.averageSimilarity < MIN_AVERAGE_SIMILARITY) continue;
        if (!best || compareCandidates(candidate, best) < 0) best = candidate;
      }
    }
    if (!best) break;
    selected.push(best);
  }
  return selected.sort((left, right) => left.duplicateStart - right.duplicateStart).map(candidate => {
    exactAverage(candidate);
    const { scores, tolerance, exactAverage: _exact, ...result } = candidate;
    return result;
  });
}

function compareCandidates(left, right) {
  if (left.length !== right.length) return right.length - left.length;
  const difference = right.averageSimilarity - left.averageSimilarity;
  const scoreOrder = Math.abs(difference) > Math.max(left.tolerance, right.tolerance)
    ? difference : exactAverage(right) - exactAverage(left);
  return scoreOrder || left.duplicateStart - right.duplicateStart || left.originalStart - right.originalStart;
}

function exactAverage(candidate) {
  if (!candidate.exactAverage) {
    let sum = 0;
    for (let index = candidate.originalStart; index < candidate.originalStart + candidate.length; index += 1) sum += candidate.scores[index];
    candidate.averageSimilarity = sum / candidate.length;
    candidate.exactAverage = true;
  }
  return candidate.averageSimilarity;
}

function sentenceFeatures(value) {
  const text = String(value || '');
  return {
    excluded: /^(?:#{1,6}|[-*+•▪◦●○■□◆◇▶▷※]|\d{1,3}[.)]|제\s*\d+\s*조)/u.test(text.trim()),
    facts: protectedFactSignature(text),
    ...sentenceSimilarityFeatures(text)
  };
}

function featurePairSimilarity(left, right) {
  if (left.excluded || right.excluded || !protectedFactsCompatible(left.facts, right.facts)) return 0;
  const a = left.normalized, b = right.normalized;
  if (!a || !b || Math.min(a.length, b.length) < 12) return 0;
  if (a === b) return 1;
  return sentenceFeatureSimilarity(left, right);
}

function protectedFactsCompatible(a, b) {
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
