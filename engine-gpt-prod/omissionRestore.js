'use strict';

const {
  splitSentenceSpans,
  ngramJaccard,
  normalizeCompact
} = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');

const MAX_RESTORE_COUNT = 5;
const MIN_SOURCE_SENTENCE_CHARS = 14;

const STOP_TOKENS = new Set([
  '그리고', '그러나', '하지만', '또한', '따라서', '때문에', '통해', '위해',
  '대한', '관한', '하는', '되는', '있는', '없는', '했다', '하였다', '되었다',
  '있다', '없다', '한다', '된다', '이다', '입니다', '하였다', '그것', '이것',
  '해당', '내용', '문장', '부분', '마지막', '결론', '누락', '축약'
]);

/**
 * 의미 심사기가 omission으로 확정했지만 모델 수리가 끝내 복구하지 못한
 * 경우에만 원문의 정확한 문장을 안전한 원래 위치로 되돌린다. 새 문장을
 * 생성하지 않고 제목·표·목록·인용·코드·평가 문항은 삽입 대상에서 제외한다.
 */
function restoreConfirmedSemanticOmissions({
  source = '',
  outputText = '',
  semanticReport = null,
  maxRestoreCount = MAX_RESTORE_COUNT
} = {}) {
  const rawSource = String(source || '');
  const before = String(outputText || '');
  const violations = Array.isArray(semanticReport?.violations)
    ? semanticReport.violations
    : [];
  const omissions = violations.filter(item => item?.type === 'omission');
  if (!rawSource.trim() || !before.trim() || !omissions.length) {
    return restoreResult(before, [], violations, []);
  }

  const sourceSpans = splitSentenceSpans(rawSource);
  if (sourceSpans.length < 2) return restoreResult(before, [], violations, []);
  const candidates = [];
  const claimedSourceIndices = new Set();
  for (const violation of omissions) {
    const match = findSourceSentenceForViolation(rawSource, sourceSpans, violation);
    if (!match || claimedSourceIndices.has(match.index)) continue;
    if (isProtectedSourceSentence(match.span.text)) continue;
    if (!isMateriallyMissing(match.span.text, before)) continue;
    claimedSourceIndices.add(match.index);
    candidates.push({ ...match, violation });
  }
  candidates.sort((left, right) => left.index - right.index);

  let current = before;
  const restored = [];
  for (const candidate of candidates.slice(0, boundedRestoreCount(maxRestoreCount))) {
    if (!isMateriallyMissing(candidate.span.text, current)) continue;
    const insertion = locateInsertion(rawSource, sourceSpans, candidate.index, current);
    if (!insertion) continue;
    const next = insertSourceSentence(current, candidate.span.text, insertion);
    if (!next || next === current) continue;
    current = next;
    restored.push({
      sourceSentenceIndex: candidate.index,
      violation: candidate.violation,
      sentence: candidate.span.text,
      anchorType: insertion.anchorType
    });
  }

  // 의미 심사기가 누락을 확정했지만 span·detail이 포괄적이라 개별 문장과
  // 연결되지 않은 경우가 있다. 문서 마지막의 일반 산문 문단 전체가
  // 사라졌고 바로 앞 문단은 결과 끝부분에 확실히 대응할 때만, 그 결론
  // 문단을 원문 그대로 한 번 복원한다.
  const restoredKeysBeforeTrailing = new Set(restored.map(item => violationKey(item.violation)));
  const unresolvedOmissions = omissions.filter(item => !restoredKeysBeforeTrailing.has(violationKey(item)));
  const remainingCapacity = boundedRestoreCount(maxRestoreCount) - restored.length;
  if (remainingCapacity > 0 && unresolvedOmissions.length) {
    const trailing = findTrailingParagraphOmission(rawSource, current, unresolvedOmissions[0]);
    if (trailing) {
      current = `${current.trimEnd()}\n\n${trailing.paragraph}`.trim();
      restored.push(trailing);
      candidates.push(trailing);
    }
  }

  const restoredViolationKeys = new Set(restored.map(item => violationKey(item.violation)));
  const remainingViolations = violations.filter(item => !restoredViolationKeys.has(violationKey(item)));
  return restoreResult(current, restored, remainingViolations, candidates);
}

function findTrailingParagraphOmission(source, outputText, violation) {
  const paragraphs = sourceProseParagraphs(source);
  if (paragraphs.length < 2) return null;
  const paragraph = paragraphs.at(-1);
  const previousParagraph = paragraphs.at(-2);
  if (paragraph.length < 80 || paragraph.length > 1600) return null;
  if (layoutStructure.isStructureDominatedParagraph(paragraph)) return null;
  const finalSentences = splitSentenceSpans(paragraph);
  if (finalSentences.length < 2) return null;
  const missingSentences = finalSentences.filter(span => isMateriallyMissing(span.text, outputText));
  if (missingSentences.length / finalSentences.length < 0.67) return null;

  const previousSentences = splitSentenceSpans(previousParagraph);
  const outputSentences = splitSentenceSpans(outputText);
  if (!previousSentences.length || !outputSentences.length) return null;
  const anchorSentence = previousSentences.at(-1).text;
  const anchors = outputSentences
    .map((span, index) => ({ span, index, score: alignmentScore(anchorSentence, span.text) }))
    .sort((left, right) => right.score - left.score || right.index - left.index);
  const anchor = anchors[0];
  if (!anchor || anchor.score < 0.5) return null;
  if (anchor.index < Math.floor(outputSentences.length * 0.65)) return null;

  return {
    sourceSentenceIndex: -1,
    violation,
    sentence: paragraph,
    paragraph,
    paragraphRestore: true,
    restoredSentenceCount: finalSentences.length,
    anchorType: 'after_previous_paragraph'
  };
}

function sourceProseParagraphs(value) {
  const source = String(value || '').replace(/\r\n?/gu, '\n').trim();
  if (!source) return [];
  const blankSeparated = source.split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean);
  const candidates = blankSeparated.length >= 2
    ? blankSeparated
    : source.split('\n').map(item => item.trim()).filter(Boolean);
  return candidates.filter(paragraph => (
    paragraph.length >= 40
    && !layoutStructure.isStructureDominatedParagraph(paragraph)
  ));
}

function findSourceSentenceForViolation(source, sourceSpans, violation) {
  const rawSpan = String(violation?.span || '').trim();
  const compactSpan = normalizeForMatch(rawSpan);
  if (compactSpan.length >= 8) {
    const exactMatches = sourceSpans
      .map((span, index) => ({ span, index, compact: normalizeForMatch(span.text) }))
      .filter(item => item.compact.includes(compactSpan) || compactSpan.includes(item.compact));
    if (exactMatches.length === 1) return { ...exactMatches[0], matchType: 'exact_span' };
  }

  const hint = `${rawSpan} ${String(violation?.detail || '')}`.trim();
  const hintTokens = contentTokens(hint);
  if (hintTokens.size < 3) return null;
  const ranked = sourceSpans
    .map((span, index) => {
      const tokens = contentTokens(span.text);
      const shared = [...tokens].filter(token => hintTokens.has(token)).length;
      const containment = shared / Math.max(1, Math.min(tokens.size, hintTokens.size));
      return { span, index, containment, shared };
    })
    .filter(item => item.shared >= 3 && item.containment >= 0.62)
    .sort((left, right) => right.containment - left.containment || right.shared - left.shared);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].containment - ranked[1].containment < 0.12) return null;
  return { span: ranked[0].span, index: ranked[0].index, matchType: 'keyword_hint' };
}

function locateInsertion(source, sourceSpans, sourceIndex, outputText) {
  const outputSpans = splitSentenceSpans(outputText);
  if (!outputSpans.length) return null;

  const previous = bestAnchor(sourceSpans, outputSpans, sourceIndex, -1);
  const next = bestAnchor(sourceSpans, outputSpans, sourceIndex, 1);
  if (previous && next && previous.outputIndex >= next.outputIndex) return null;

  if (previous) {
    return {
      anchorType: 'after_previous',
      position: previous.span.end,
      separator: sourceSeparator(source, sourceSpans[previous.sourceIndex], sourceSpans[sourceIndex])
    };
  }
  if (next) {
    return {
      anchorType: 'before_next',
      position: next.span.start,
      separator: sourceSeparator(source, sourceSpans[sourceIndex], sourceSpans[next.sourceIndex])
    };
  }
  return null;
}

function bestAnchor(sourceSpans, outputSpans, targetIndex, direction) {
  const start = targetIndex + direction;
  const end = direction < 0 ? Math.max(-1, targetIndex - 5) : Math.min(sourceSpans.length, targetIndex + 5);
  let best = null;
  for (let sourceIndex = start;
    direction < 0 ? sourceIndex > end : sourceIndex < end;
    sourceIndex += direction) {
    const sourceSentence = sourceSpans[sourceIndex]?.text;
    if (!sourceSentence || isProtectedSourceSentence(sourceSentence)) continue;
    for (let outputIndex = 0; outputIndex < outputSpans.length; outputIndex += 1) {
      const score = alignmentScore(sourceSentence, outputSpans[outputIndex].text);
      if (score < 0.44) continue;
      const distancePenalty = Math.abs(targetIndex - sourceIndex) * 0.015;
      const adjusted = score - distancePenalty;
      if (!best || adjusted > best.adjusted) {
        best = {
          sourceIndex,
          outputIndex,
          span: outputSpans[outputIndex],
          score,
          adjusted
        };
      }
    }
    // 바로 이웃 문장이 충분히 정렬되면 더 먼 동명이의 문장을 찾지 않는다.
    if (best && best.sourceIndex === sourceIndex && best.score >= 0.7) break;
  }
  return best;
}

function alignmentScore(left, right) {
  const compactLeft = normalizeForMatch(left);
  const compactRight = normalizeForMatch(right);
  if (!compactLeft || !compactRight) return 0;
  if (compactLeft === compactRight) return 1;
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const containment = shared / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  return Math.max(ngramJaccard(left, right, 5), containment * 0.86);
}

function isMateriallyMissing(sourceSentence, outputText) {
  const sentence = String(sourceSentence || '').trim();
  if (normalizeForMatch(sentence).length < MIN_SOURCE_SENTENCE_CHARS) return false;
  const sourceCompact = normalizeForMatch(sentence);
  const outputCompact = normalizeForMatch(outputText);
  if (outputCompact.includes(sourceCompact)) return false;
  const sourceTokens = contentTokens(sentence);
  return splitSentenceSpans(outputText).every(span => {
    const candidateCompact = normalizeForMatch(span.text);
    if (candidateCompact.includes(sourceCompact) || sourceCompact.includes(candidateCompact)) return false;
    const candidateTokens = contentTokens(span.text);
    const shared = [...sourceTokens].filter(token => candidateTokens.has(token)).length;
    const containment = shared / Math.max(1, Math.min(sourceTokens.size, candidateTokens.size));
    return ngramJaccard(sentence, span.text, 5) < 0.42 && containment < 0.74;
  });
}

function isProtectedSourceSentence(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^(?:#{1,6}\s+|[-*+•▪◦·●○■□◆◇▶▷※]\s+|\d{1,3}(?:[-.]\d+)*[.)]\s+|[①-⑳]\s+|제\s*\d{1,3}\s*(?:장|절|항|조))/u.test(text)) return true;
  if (/^(?:\[|【)(?:듣기|읽기|말하기|쓰기|어휘|문법|평가|시험|문항|문제|지문|정답|답|해설|풀이)/u.test(text)) return true;
  if (/^(?:>|“[^”]+”$|‘[^’]+’$|"[^"]+"$|'[^']+'$|「[^」]+」$|『[^』]+』$|《[^》]+》$|〈[^〉]+〉$)/u.test(text)) return true;
  if (/^(?:`{3,}|~{3,})/u.test(text) || /\t|\|.+\|/u.test(text)) return true;
  const records = layoutStructure.buildLineRecords(text).filter(record => !record.blank);
  return records.length === 1 && layoutStructure.isStructuralRole(records[0].role);
}

function insertSourceSentence(outputText, sentenceValue, insertion) {
  const output = String(outputText || '');
  const sentence = String(sentenceValue || '').trim();
  const position = Math.max(0, Math.min(output.length, Number(insertion?.position) || 0));
  const separator = insertion?.separator === '\n\n' ? '\n\n' : ' ';
  if (insertion?.anchorType === 'before_next') {
    const prefix = output.slice(0, position).replace(/[ \t]+$/u, '');
    const suffix = output.slice(position).replace(/^[ \t]+/u, '');
    return `${prefix}${prefix ? separator : ''}${sentence}${suffix ? separator + suffix : ''}`;
  }
  const prefix = output.slice(0, position).replace(/[ \t]+$/u, '');
  const suffix = output.slice(position).replace(/^[ \t]+/u, '');
  return `${prefix}${prefix ? separator : ''}${sentence}${suffix ? separator + suffix : ''}`;
}

function sourceSeparator(source, leftSpan, rightSpan) {
  if (!leftSpan || !rightSpan) return ' ';
  const between = String(source || '').slice(leftSpan.end, rightSpan.start);
  return /\n[ \t]*\n/u.test(between) ? '\n\n' : ' ';
}

function contentTokens(value) {
  const out = new Set();
  for (const raw of String(value || '').normalize('NFKC').match(/[가-힣]{2,}|[A-Za-z]{3,}/gu) || []) {
    let token = raw.toLowerCase();
    token = token.replace(/(?:으로부터|에게서|에서는|으로는|이라는|이라고|까지는|부터는)$/u, '');
    token = token.replace(/(?:은|는|이|가|을|를|의|와|과|도|만|에서|에게|으로|에|로)$/u, '');
    token = token.replace(/(?:하게|되었|됐|합니다|했습니다|하였다|했다|입니다|이었다|였다)$/u, '');
    if (token.length >= 2 && !STOP_TOKENS.has(token)) out.add(token);
  }
  return out;
}

function normalizeForMatch(value) {
  return normalizeCompact(String(value || '')).replace(/[^\p{L}\p{N}]/gu, '');
}

function violationKey(item) {
  return `${item?.type || ''}\u0000${item?.span || ''}\u0000${item?.detail || ''}`;
}

function boundedRestoreCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_RESTORE_COUNT;
  return Math.max(0, Math.min(MAX_RESTORE_COUNT, Math.floor(parsed)));
}

function restoreResult(text, restored, remainingViolations, candidates) {
  return {
    text: String(text || ''),
    applied: restored.length > 0,
    restoredCount: restored.length,
    restored,
    restoredViolationKeys: restored.map(item => violationKey(item.violation)),
    remainingViolations: Array.isArray(remainingViolations) ? remainingViolations : [],
    candidateCount: Array.isArray(candidates) ? candidates.length : 0
  };
}

module.exports = {
  MAX_RESTORE_COUNT,
  restoreConfirmedSemanticOmissions,
  findSourceSentenceForViolation,
  isMateriallyMissing,
  isProtectedSourceSentence,
  alignmentScore,
  findTrailingParagraphOmission,
  sourceProseParagraphs
};
