'use strict';

const { splitSentences, splitSentenceSpans, levenshteinDistance } = require('../engine/koreanText');
const {
  alignedOutputCandidates,
  sentenceSimilarity
} = require('./sentenceAlignment');

const VERSION = 2;
const MIN_CONTENT_RECALL = 0.55;
const CLAIM_PATTERNS = Object.freeze({
  action: /(?:수행|담당|개발|분석|설계|운영|개선|협업|해결|참여|작성|구축|기획|관리|제작|조사|발표|주도|실행|근무|프로젝트)/u,
  competency: /(?:역량|능력|기술|활용|소통|협업|책임|전문성|문제\s*해결|리더십|성실|강점)/u,
  result: /(?:성과|달성|향상|증가|감소|개선|수상|완료|기여|효율|절감|성장|\d+(?:\.\d+)?%)/u,
  job_link: /(?:직무|지원|입사|귀사|회사|기업|업무|포부|조직|고객|현장|기여하|성장하)/u
});

function auditResumeCoverage(source, output, documentProfile = null) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const confidence = Number(documentProfile?.confidence ?? documentProfile?.profileConfidence ?? 0);
  const applicable = profile === 'resume_application' && confidence >= 0.75;
  if (!applicable) return emptyReport(false);
  const sourceSentences = meaningfulSentences(source);
  const outputSentences = meaningfulSentences(output);
  const claims = sourceSentences
    .map((sentence, index) => ({ sentence, index, types: claimTypes(sentence), tokens: contentTokens(sentence) }))
    .filter(item => item.types.length > 0 && item.tokens.length >= 3);
  const rows = claims.map(claim => compareClaim(claim, sourceSentences.length, outputSentences));
  const omissions = rows.filter(item => !item.aligned || item.contentRecall < MIN_CONTENT_RECALL);
  return {
    version: VERSION,
    applicable: true,
    pass: omissions.length === 0,
    minContentRecall: MIN_CONTENT_RECALL,
    claimCount: rows.length,
    coveredClaimCount: rows.length - omissions.length,
    coverageRatio: round4(rows.length ? (rows.length - omissions.length) / rows.length : 1),
    minimumObservedRecall: rows.length ? Math.min(...rows.map(item => item.contentRecall)) : 1,
    issueCodes: omissions.length ? ['resume_claim_omission'] : [],
    omissions: omissions.slice(0, 12).map(item => ({
      sourceIndex: item.sourceIndex,
      sourceOrdinal: item.sourceIndex + 1,
      types: item.types,
      contentRecall: item.contentRecall,
      aligned: item.aligned,
      sourceSentence: item.sourceSentence,
      previousContext: sourceSentences[item.sourceIndex - 1] || '',
      nextContext: sourceSentences[item.sourceIndex + 1] || ''
    }))
  };
}

function compareClaim(claim, sourceCount, outputSentences) {
  if (!outputSentences.length) return row(claim, -1, 0, false);
  const candidates = alignedOutputCandidates(
    claim.sentence,
    claim.index,
    sourceCount,
    outputSentences,
    { window: 3, maxOutputGroup: 2 }
  );
  let best = { index: -1, recall: 0, similarity: 0 };
  for (const candidate of candidates) {
    const candidateTokens = new Set(contentTokens(candidate.text));
    const recall = claim.tokens.filter(token => candidateTokens.has(token)).length / Math.max(1, claim.tokens.length);
    const sourceNorm = normalize(claim.sentence);
    const outputNorm = normalize(candidate.text);
    const similarity = 1 - (levenshteinDistance(sourceNorm, outputNorm) / Math.max(1, sourceNorm.length, outputNorm.length));
    if (recall > best.recall || (recall === best.recall && similarity > best.similarity)) {
      best = { index: candidate.start, recall, similarity };
    }
  }
  return row(claim, best.index, best.recall, best.recall >= 0.2 || best.similarity >= 0.45);
}

function row(claim, outputIndex, recall, aligned) {
  return {
    sourceIndex: claim.index,
    outputIndex,
    sourceSentence: claim.sentence,
    types: claim.types,
    contentRecall: round4(recall),
    aligned
  };
}

function claimTypes(sentence) {
  return Object.entries(CLAIM_PATTERNS)
    .filter(([, pattern]) => pattern.test(String(sentence || '')))
    .map(([type]) => type);
}

function meaningfulSentences(value) {
  return splitSentences(String(value || ''))
    .map(sentence => String(sentence || '').trim())
    .filter(sentence => normalize(sentence).length >= 5);
}

function contentTokens(value) {
  const stop = new Set(['그리고', '그러나', '하지만', '따라서', '또한', '통해', '위해', '대한', '있는', '하는', '했습니다', '합니다', '있습니다', '경험', '과정']);
  return [...new Set((String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}|\d+(?:\.\d+)?%?/gu) || [])
    .map(token => token.toLowerCase().replace(/(?:하였습니다|했습니다|하였다|했다|에서는|으로는|에게는|이라는|으로|에서|에게|보다|처럼|하고|하며|하여|한다|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u, ''))
    .filter(token => token.length >= 2 && !stop.has(token)))];
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/gu, '');
}

function isImproved(before, after) {
  return Number(after?.coveredClaimCount || 0) > Number(before?.coveredClaimCount || 0)
    || Number(after?.coverageRatio || 0) > Number(before?.coverageRatio || 0) + 1e-9;
}

function isSafeRestorationShape(source, current, candidate, omissionCount = 1) {
  const before = String(source || '').trim();
  const now = String(current || '').trim();
  const after = String(candidate || '').trim();
  if (!before || !now || !after || normalize(now) === normalize(after)) return false;
  const sourceLengthRatio = after.length / Math.max(1, before.length);
  if (sourceLengthRatio < 0.85 || sourceLengthRatio > 1.12) return false;
  const sourceSentences = meaningfulSentences(before).length;
  const currentSentences = meaningfulSentences(now).length;
  const candidateSentences = meaningfulSentences(after).length;
  if (candidateSentences < currentSentences) return false;
  if (candidateSentences > sourceSentences + 1) return false;
  if (candidateSentences - currentSentences > Math.max(1, Number(omissionCount) || 1) + 1) return false;
  // 변환 결과가 가독성을 위해 원문 문단을 이미 나눴더라도, 국소 복원이
  // 현재 결과의 문단 수를 더 바꾸지만 않으면 허용한다.
  return paragraphCount(now) === paragraphCount(after);
}

/**
 * 모델 수리가 실패해도 앞·뒤 문장이 모두 확실히 정렬되는 핵심 주장만
 * 원래 위치에 원문 그대로 되돌린다. 새로운 문장을 생성하지 않으며,
 * 문단 경계를 넘거나 한쪽 앵커만 있는 경우에는 복원하지 않는다.
 */
function restoreMissingClaimsLocally({
  source = '',
  currentOutput = '',
  audit = null,
  maxRestoreCount = 2
} = {}) {
  const before = String(currentOutput || '');
  if (!before || audit?.applicable !== true || audit?.pass === true) {
    return { text: before, applied: false, restoredCount: 0, restoredSourceOrdinals: [] };
  }
  const prioritized = [...(audit.omissions || [])]
    .filter(item => Array.isArray(item.types)
      && item.types.some(type => ['job_link', 'competency', 'action'].includes(type)))
    .filter(item => String(item.sourceSentence || '').trim().length >= 12)
    .sort((left, right) => claimPriority(right) - claimPriority(left)
      || Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0))
    .slice(0, Math.max(1, Number(maxRestoreCount) || 2));
  let text = before;
  const restoredSourceOrdinals = [];
  for (const omission of prioritized) {
    const sentence = String(omission.sourceSentence || '').trim();
    if (!sentence || normalize(text).includes(normalize(sentence))) continue;
    const spans = splitSentenceSpans(text);
    const previous = bestAnchorSpan(omission.previousContext, spans);
    const next = bestAnchorSpan(omission.nextContext, spans);
    if (!previous || !next
        || previous.score < 0.5
        || next.score < 0.5
        || previous.index >= next.index
        || next.index - previous.index > 3) continue;
    text = `${text.slice(0, next.span.start)}${sentence} ${text.slice(next.span.start)}`;
    restoredSourceOrdinals.push(Number(omission.sourceOrdinal || Number(omission.sourceIndex || 0) + 1));
  }
  return {
    text,
    applied: restoredSourceOrdinals.length > 0,
    restoredCount: restoredSourceOrdinals.length,
    restoredSourceOrdinals
  };
}

function bestAnchorSpan(value, spans) {
  const anchor = String(value || '').trim();
  if (!anchor || !spans.length) return null;
  let best = null;
  spans.forEach((span, index) => {
    const score = sentenceSimilarity(anchor, span.text);
    if (!best || score > best.score) best = { index, span, score };
  });
  return best;
}

function claimPriority(item) {
  const types = new Set(item?.types || []);
  if (types.has('job_link')) return 3;
  if (types.has('competency')) return 2;
  if (types.has('action')) return 1;
  return 0;
}

function paragraphCount(value) {
  return String(value || '').split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean).length;
}

function emptyReport(applicable) {
  return {
    version: VERSION,
    applicable,
    pass: true,
    minContentRecall: MIN_CONTENT_RECALL,
    claimCount: 0,
    coveredClaimCount: 0,
    coverageRatio: 1,
    minimumObservedRecall: 1,
    issueCodes: [],
    omissions: []
  };
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

module.exports = {
  VERSION,
  MIN_CONTENT_RECALL,
  CLAIM_PATTERNS,
  auditResumeCoverage,
  contentTokens,
  claimTypes,
  isImproved,
  isSafeRestorationShape,
  restoreMissingClaimsLocally
};
