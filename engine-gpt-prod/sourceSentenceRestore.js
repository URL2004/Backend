'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const {
  alignSourceSentence,
  alignedOutputCandidates,
  sentenceSimilarity: sharedSentenceSimilarity,
  contentTokens
} = require('./sentenceAlignment');
const layoutStructure = require('./layoutStructure');

// 모델 수리까지 실패했을 때 문서 전체를 버리지 않고, 원문과 결과의 문장
// 하나가 둘 이상의 결과 문장으로 분리된 경우까지 공통 정렬기로 추적해
// 문제 범위만 원문으로 되돌린다. 서로 다른 원문 문장이 한 결과 문장으로
// 합쳐져 정렬이 모호하거나 문단 경계를 가로지르는 경우에는 복원하지 않는다.
function restoreSourceSentenceOrdinals(source, outputText, sentenceOrdinals, {
  maxRestoreCount = 8,
  minSimilarity = 0.24,
  ordinalSpace = 'source',
  maxOutputGroup = 3,
  allowStablePositionalFallback = false
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
    let alignment = ordinalSpace === 'output'
      ? alignOutputOrdinalToSource(ordinal, sourceSpans, outputSpans, { minSimilarity, maxOutputGroup })
      : alignSourceOrdinalToOutput(ordinal, sourceSpans, outputSpans, {
          minSimilarity,
          maxOutputGroup,
          allowStablePositionalFallback
        });
    if (!alignment) continue;
    alignment = resolveSplitRestoration(alignment, sourceSpans, outputSpans, before, maxOutputGroup);
    if (!alignment) continue;
    // Positional proximity retrieves a proposal; it does not establish which
    // claim owns it. Long documents drift after 1:N rewrites. A similar clause
    // about another condition must never be replaced merely because the true
    // counterpart is outside the proportional +/-3 window.
    if (!hasReciprocalOwnership(alignment, sourceSpans, outputSpans, before)) continue;
    const sourceSpan = sourceSpans[alignment.sourceIndex];
    // A public source ordinal may cover an entire punctuation-poor document.
    // Its inferred claims have no verified replacement coordinates here. Never
    // paste that whole run into a partial output match (even if similarity or
    // a caller's 1:1 preference accepts it). Leave it to model repair/review.
    if (sourceSpan && splitSentenceSpans(sourceSpan.text, { inferPlainEndings: true }).length > 1) continue;
    const firstOutput = outputSpans[alignment.start];
    const lastOutput = outputSpans[alignment.end - 1];
    if (!sourceSpan || !firstOutput || !lastOutput) continue;
    const replacedSlice = before.slice(firstOutput.start, lastOutput.end);
    const replacementText = alignment.replacementText || sourceSpan.text;
    if (normalize(replacementText) === normalize(replacedSlice)) continue;
    // 한 원문 문장이 결과에서 두 문단으로 찢어진 경우에는 여기서 문단을
    // 합치지 않는다. 구조 복원기가 담당하도록 보수적으로 중단한다.
    if (alignment.end - alignment.start > 1 && /\r?\n[ \t]*\r?\n/u.test(replacedSlice)) continue;
    proposals.push({
      ordinal,
      sourceOrdinal: alignment.sourceIndex + 1,
      start: firstOutput.start,
      end: lastOutput.end,
      text: replacementText,
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

function hasReciprocalOwnership(alignment, sourceSpans, outputSpans, output) {
  const original = alignment.replacementText || sourceSpans[alignment.sourceIndex].text;
  const selected = output.slice(outputSpans[alignment.start].start, outputSpans[alignment.end - 1].end);
  const score = sentenceSimilarity(original, selected);
  const numbers = value => (String(value).match(/\d+(?:\.\d+)?/gu) || []).join('|');
  const numericAnchor = numbers(original);
  const sameNumericAnchor = numericAnchor && numericAnchor === numbers(selected);
  // Check all unselected sentences, not the positional search window. Copying
  // a source sentence already better represented elsewhere duplicates one
  // condition and erases another. Ties are not enough to authorize a write.
  for (let i = 0; i < outputSpans.length; i++) {
    if (i >= alignment.start && i < alignment.end) continue;
    const competing = sentenceSimilarity(original, outputSpans[i].text);
    if (competing < score - 0.02) continue;
    if (sameNumericAnchor && numbers(outputSpans[i].text) !== numericAnchor) continue;
    // Shared vocabulary may belong to a separate, already intact claim. That
    // is not a competing owner of this source sentence.
    const separatelyOwned = sourceSpans.some((s, index) => index !== alignment.sourceIndex
      && sentenceSimilarity(sourceTextWithoutLeadingHeading(s.text, outputSpans[i].text), outputSpans[i].text)
        >= Math.max(0.5, competing + 0.06));
    if (!separatelyOwned) return false;
  }
  for (let i = 0; i < sourceSpans.length; i++) {
    if (i === alignment.sourceIndex) continue;
    const other = sourceTextWithoutLeadingHeading(sourceSpans[i].text, selected);
    const competing = sentenceSimilarity(other, selected);
    if (competing < score - 0.02) continue;
    if (normalize(other) === normalize(original)) return false;
    if (sameNumericAnchor && numbers(other) !== numericAnchor) continue;
    const representedElsewhere = outputSpans.some((s, index) => (index < alignment.start || index >= alignment.end)
      && sentenceSimilarity(other, s.text) >= Math.max(0.5, competing + 0.06));
    if (!representedElsewhere) return false;
  }
  return true;
}

function sentenceSimilarity(left, right) {
  return sharedSentenceSimilarity(left, right);
}

// A whole source sentence must not overwrite only one arm of a split result.
// Ordinal equality and a caller's 1:1 preference are not evidence of 1:1 ownership.
// Expand only to adjacent, source-backed arms; never dedupe a fuzzy neighbour.
function resolveSplitRestoration(alignment, sourceSpans, outputSpans, output, maxOutputGroup) {
  const sourceText = alignment.replacementText || sourceSpans[alignment.sourceIndex].text;
  const sourceTokens = new Set(restorationTokens(sourceText));
  if (sourceTokens.size < 3) return alignment;
  let current = alignment;
  // Three is the shared restoration contract. If a fourth arm still contributes
  // source content, reject instead of restoring an incomplete span.
  for (let pass = 0; pass < 3; pass += 1) {
    const selectedText = output.slice(outputSpans[current.start].start, outputSpans[current.end - 1].end);
    const selectedTokens = new Set(restorationTokens(selectedText));
    const singleScore = sentenceSimilarity(sourceText, selectedText);
    let best = null;
    for (const neighbour of [current.start - 1, current.end]) {
      if (!outputSpans[neighbour]) continue;
      const text = outputSpans[neighbour].text;
      const tokens = restorationTokens(text);
      const shared = tokens.filter(token => sourceTokens.has(token));
      const added = shared.filter(token => !selectedTokens.has(token));
      if (added.length < 2 || shared.length / Math.max(1, tokens.length) < 0.4) continue;
      const ownerScore = sentenceSimilarity(sourceText, text);
      // A shorter source sentence can score higher on shared broad vocabulary
      // than one arm of a long compound. Only a strong alternative owner can
      // dismiss that arm. Ambiguity must prevent the overwrite, not authorize
      // copying the whole compound over an incomplete span.
      const otherOwner = Math.max(0, ...sourceSpans.map((span, index) =>
        index === alignment.sourceIndex ? 0 : sentenceSimilarity(span.text, text)));
      if (otherOwner >= ownerScore - 0.02) {
        if (otherOwner >= Math.max(0.5, ownerScore + 0.06)) continue;
        return null;
      }
      const start = Math.min(current.start, neighbour), end = Math.max(current.end, neighbour + 1);
      const joined = output.slice(outputSpans[start].start, outputSpans[end - 1].end);
      const score = sentenceSimilarity(sourceText, joined);
      // Even if crossing a paragraph is forbidden, do not silently fall back to
      // a partial overwrite. Ownership is already established above; a small
      // similarity gain cannot make the unselected source-backed arm vanish.
      // The caller may request a model repair instead.
      if (/\r?\n[ \t]*\r?\n/u.test(joined) || end - start > Math.min(3, maxOutputGroup)) return null;
      if (score < singleScore + 0.04) continue;
      if (!best || score > best.score) best = { ...current, start, end, score };
    }
    if (!best) return current;
    current = best;
  }
  return current;
}

function restorationTokens(text) {
  // Compound-to-sentence inflection is expected in split arms (`혼합했고` /
  // `혼합했다`). Normalize only these endings for the ownership guard, not the
  // global alignment score, and keep a minimum two-syllable lexical stem.
  return [...new Set(contentTokens(text).map(token => token.replace(
    /(?<=[가-힣]{2})(?:했고|했으며|하였으며|하면서|하여서|했지만|하였지만)$/u, ''
  )))];
}

function alignSourceOrdinalToOutput(ordinal, sourceSpans, outputSpans, {
  minSimilarity,
  maxOutputGroup,
  allowStablePositionalFallback = false
}) {
  const sourceIndex = ordinal - 1;
  const sourceSpan = sourceSpans[sourceIndex];
  if (!sourceSpan) return null;
  const editableSourceText = sourceTextWithoutLeadingHeading(sourceSpan.text, '');
  if (editableSourceText !== sourceSpan.text) {
    const bodyAlignment = alignSourceSentence(
      editableSourceText,
      sourceIndex,
      sourceSpans.length,
      outputSpans.map(item => item.text),
      {
        window: outputSpans.length,
        maxOutputGroup: 1
      }
    );
    if (bodyAlignment && bodyAlignment.score >= Math.max(minSimilarity, 0.36)) {
      return {
        sourceIndex,
        start: bodyAlignment.start,
        end: bodyAlignment.end,
        score: bodyAlignment.score,
        replacementText: editableSourceText
      };
    }
  }
  if (sourceSpans.length === outputSpans.length) {
    const outputSpan = outputSpans[sourceIndex];
    const score = sentenceSimilarity(sourceSpan.text, outputSpan?.text || '');
    if (outputSpan && score >= minSimilarity) {
      return { sourceIndex, start: sourceIndex, end: sourceIndex + 1, score };
    }
    // 감정·동기 문장이 일반론으로 완전히 평탄화되면 해당 문장 자체의
    // 어휘 유사도는 낮아진다. 앞뒤 문장이 제자리에 안정적으로 정렬된
    // 경우에만 같은 위치를 복원 대상으로 인정해 엉뚱한 문장 교체를 막는다.
    if (outputSpan
        && allowStablePositionalFallback
        && hasStablePositionalNeighbors(sourceIndex, sourceSpans, outputSpans)) {
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
  if (alignment && alignment.score >= minSimilarity) {
    if (alignment.end - alignment.start > 1) {
      const globalSingle = alignSourceSentence(
        sourceSpan.text,
        sourceIndex,
        sourceSpans.length,
        outputSpans.map(item => item.text),
        {
          window: outputSpans.length,
          maxOutputGroup: 1
        }
      );
      if (globalSingle
          && globalSingle.score >= Math.max(0.36, alignment.score + 0.03)) {
        return {
          sourceIndex,
          start: globalSingle.start,
          end: globalSingle.end,
          score: globalSingle.score
        };
      }
    }
    return { sourceIndex, start: alignment.start, end: alignment.end, score: alignment.score };
  }
  // 제목·라벨이 결과에서 독립 문장으로 분리되면 뒤 문장의 비례 위치가
  // 기본 ±3 범위를 크게 벗어날 수 있다. 국소 복원에 한해 문서 전체를
  // 다시 검색하되 더 높은 유사도 기준을 적용해 먼 오정렬을 막는다.
  const globalAlignment = alignSourceSentence(
    sourceSpan.text,
    sourceIndex,
    sourceSpans.length,
    outputSpans.map(item => item.text),
    {
      window: outputSpans.length,
      maxOutputGroup
    }
  );
  const globalMinimum = Math.max(minSimilarity, 0.36);
  if (!globalAlignment || globalAlignment.score < globalMinimum) return null;
  return {
    sourceIndex,
    start: globalAlignment.start,
    end: globalAlignment.end,
    score: globalAlignment.score
  };
}

function hasStablePositionalNeighbors(index, sourceSpans, outputSpans) {
  const neighbors = [index - 1, index + 1]
    .filter(value => value >= 0 && value < sourceSpans.length && value < outputSpans.length);
  if (!neighbors.length) return false;
  return neighbors.every(value => (
    sentenceSimilarity(sourceSpans[value]?.text || '', outputSpans[value]?.text || '') >= 0.42
  ));
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
  const collectCandidates = ({ window, minimum }) => {
    const candidates = [];
    sourceSpans.forEach((sourceSpan, sourceIndex) => {
      const alignments = alignedOutputCandidates(
        sourceSpan.text,
        sourceIndex,
        sourceSpans.length,
        outputTexts,
        { maxOutputGroup, ...(window ? { window } : {}) }
      );
      const bestForSource = alignments[0] || null;
      const replacementText = sourceTextWithoutLeadingHeading(
        sourceSpan.text,
        outputSpans[outputIndex].text
      );
      let directHeadingCandidateAdded = false;
      if (replacementText !== sourceSpan.text) {
        const directScore = sentenceSimilarity(replacementText, outputSpans[outputIndex].text);
        const bestCoversTarget = bestForSource
          && bestForSource.start <= outputIndex
          && bestForSource.end > outputIndex;
        if (directScore >= minimum
            && (!bestForSource || bestCoversTarget || directScore >= bestForSource.score - 0.04)) {
          candidates.push({
            sourceIndex,
            start: outputIndex,
            end: outputIndex + 1,
            score: directScore,
            replacementText
          });
          directHeadingCandidateAdded = true;
        }
      }
      if (directHeadingCandidateAdded) return;
      for (const alignment of alignments) {
        if (alignment.start > outputIndex || alignment.end <= outputIndex) continue;
        if (alignment.score < minimum) continue;
        const bestCoversTarget = bestForSource
          && bestForSource.start <= outputIndex
          && bestForSource.end > outputIndex;
        // 인접 문장이 같은 핵심어를 공유할 때 현재 결과 문장에도 제법 높은
        // 점수가 나올 수 있다. 그 원문 문장이 실제로는 다른 결과 문장에 더
        // 잘 대응하면 현재 문장을 덮어쓰는 후보에서 제외한다.
        if (bestForSource
            && !bestCoversTarget
            && alignment.score < bestForSource.score - 0.04) continue;
        candidates.push({
          sourceIndex,
          start: alignment.start,
          end: alignment.end,
          score: alignment.score
        });
      }
    });
    return candidates;
  };
  let candidates = collectCandidates({ minimum: minSimilarity });
  if (!candidates.length) {
    candidates = collectCandidates({
      window: outputSpans.length,
      minimum: Math.max(minSimilarity, 0.36)
    });
  }
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

function sourceTextWithoutLeadingHeading(value, targetOutput) {
  const text = String(value || '');
  const lines = text.split(/\r?\n/u);
  if (lines.length < 2) return text;
  const removed = [];
  while (lines.length > 1) {
    const candidate = String(lines[0] || '').trim();
    const role = layoutStructure.classifyLine(candidate);
    if (!['title', 'heading'].includes(role)) break;
    removed.push(candidate);
    lines.shift();
  }
  if (!removed.length) return text;
  const targetKey = normalize(targetOutput);
  if (removed.some(item => targetKey.includes(normalize(item)))) return text;
  const body = lines.join('\n').trim();
  return body || text;
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
