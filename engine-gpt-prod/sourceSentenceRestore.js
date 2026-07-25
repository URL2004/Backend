'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const {
  alignSourceSentence,
  alignedOutputCandidates,
  sentenceSimilarity: sharedSentenceSimilarity
} = require('./sentenceAlignment');

// 모델 수리까지 실패했을 때 문서 전체를 버리지 않고, 원문과 결과의 문장
// 하나가 둘 이상의 결과 문장으로 분리된 경우까지 공통 정렬기로 추적해
// 문제 범위만 원문으로 되돌린다. 서로 다른 원문 문장이 한 결과 문장으로
// 합쳐져 정렬이 모호하거나 문단 경계를 가로지르는 경우에는 복원하지 않는다.
function restoreSourceSentenceOrdinals(source, outputText, sentenceOrdinals, {
  maxRestoreCount = 8,
  minSimilarity = 0.24,
  ordinalSpace = 'source',
  maxOutputGroup = 3
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
  if (!sourceSpans.length || !outputSpans.length) {
    return result(before, false, [], 'sentence_alignment_mismatch');
  }

  const proposals = [];
  for (const ordinal of requested) {
    const alignment = ordinalSpace === 'output'
      ? alignOutputOrdinalToSource(ordinal, sourceSpans, outputSpans, { minSimilarity, maxOutputGroup })
      : alignSourceOrdinalToOutput(ordinal, sourceSpans, outputSpans, { minSimilarity, maxOutputGroup });
    if (!alignment) continue;
    const sourceSpan = sourceSpans[alignment.sourceIndex];
    const firstOutput = outputSpans[alignment.start];
    const lastOutput = outputSpans[alignment.end - 1];
    if (!sourceSpan || !firstOutput || !lastOutput) continue;
    const replacedSlice = before.slice(firstOutput.start, lastOutput.end);
    if (normalize(sourceSpan.text) === normalize(replacedSlice)) continue;
    // 한 원문 문장이 결과에서 두 문단으로 찢어진 경우에는 여기서 문단을
    // 합치지 않는다. 구조 복원기가 담당하도록 보수적으로 중단한다.
    if (alignment.end - alignment.start > 1 && /\r?\n[ \t]*\r?\n/u.test(replacedSlice)) continue;
    proposals.push({
      ordinal,
      sourceOrdinal: alignment.sourceIndex + 1,
      start: firstOutput.start,
      end: lastOutput.end,
      text: sourceSpan.text,
      score: alignment.score
    });
  }
  const replacements = selectNonOverlappingProposals(proposals);
  if (!replacements.length) return result(before, false, [], 'no_safe_alignment');

  let text = before;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  }
  return result(
    text,
    text !== before,
    replacements.map(item => item.ordinal),
    'restored',
    {
      ordinalSpace,
      restoredSourceSentenceOrdinals: replacements.map(item => item.sourceOrdinal)
    }
  );
}

function sentenceSimilarity(left, right) {
  return sharedSentenceSimilarity(left, right);
}

function alignSourceOrdinalToOutput(ordinal, sourceSpans, outputSpans, {
  minSimilarity,
  maxOutputGroup
}) {
  const sourceIndex = ordinal - 1;
  const sourceSpan = sourceSpans[sourceIndex];
  if (!sourceSpan) return null;
  if (sourceSpans.length === outputSpans.length) {
    const outputSpan = outputSpans[sourceIndex];
    const score = sentenceSimilarity(sourceSpan.text, outputSpan?.text || '');
    if (outputSpan && score >= minSimilarity) {
      return { sourceIndex, start: sourceIndex, end: sourceIndex + 1, score };
    }
  }
  const alignment = alignSourceSentence(
    sourceSpan.text,
    sourceIndex,
    sourceSpans.length,
    outputSpans.map(item => item.text),
    { maxOutputGroup }
  );
  if (!alignment || alignment.score < minSimilarity) return null;
  return { sourceIndex, start: alignment.start, end: alignment.end, score: alignment.score };
}

function alignOutputOrdinalToSource(ordinal, sourceSpans, outputSpans, {
  minSimilarity,
  maxOutputGroup
}) {
  const outputIndex = ordinal - 1;
  if (!outputSpans[outputIndex]) return null;
  if (sourceSpans.length === outputSpans.length) {
    const sourceSpan = sourceSpans[outputIndex];
    const score = sentenceSimilarity(sourceSpan?.text || '', outputSpans[outputIndex].text);
    if (sourceSpan && score >= minSimilarity) {
      return { sourceIndex: outputIndex, start: outputIndex, end: outputIndex + 1, score };
    }
  }
  const outputTexts = outputSpans.map(item => item.text);
  const candidates = [];
  sourceSpans.forEach((sourceSpan, sourceIndex) => {
    for (const alignment of alignedOutputCandidates(
      sourceSpan.text,
      sourceIndex,
      sourceSpans.length,
      outputTexts,
      { maxOutputGroup }
    )) {
      if (alignment.start > outputIndex || alignment.end <= outputIndex) continue;
      if (alignment.score < minSimilarity) continue;
      candidates.push({
        sourceIndex,
        start: alignment.start,
        end: alignment.end,
        score: alignment.score
      });
    }
  });
  candidates.sort((left, right) => (
    right.score - left.score
      || (left.end - left.start) - (right.end - right.start)
      || left.sourceIndex - right.sourceIndex
  ));
  const best = candidates[0];
  if (!best) return null;
  const competing = candidates.find(item => item.sourceIndex !== best.sourceIndex);
  // 서로 다른 원문 문장이 같은 결과 문장에 거의 같은 점수로 대응하면
  // N:1 병합일 가능성이 있으므로 한 문장만 되돌려 다른 내용을 지우지 않는다.
  if (competing
      && rangesOverlap(best, competing)
      && competing.score >= best.score - 0.04) return null;
  return best;
}

function selectNonOverlappingProposals(proposals) {
  const selected = [];
  for (const proposal of [...proposals].sort((left, right) => (
    right.score - left.score
      || left.start - right.start
      || left.end - right.end
  ))) {
    const duplicate = selected.find(item => item.start === proposal.start && item.end === proposal.end);
    if (duplicate) continue;
    if (selected.some(item => rangesOverlap(item, proposal))) continue;
    selected.push(proposal);
  }
  return selected.sort((left, right) => left.start - right.start);
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/gu, '');
}

function result(text, applied, restoredSentenceOrdinals, reason, extra = {}) {
  return {
    text,
    applied,
    restoredSentenceCount: restoredSentenceOrdinals.length,
    restoredSentenceOrdinals,
    reason,
    ...extra
  };
}

module.exports = {
  restoreSourceSentenceOrdinals,
  sentenceSimilarity
};
