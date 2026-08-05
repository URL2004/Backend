'use strict';

const { splitSentences, splitSentenceSpans, levenshteinDistance } = require('../engine/koreanText');
const {
  alignedOutputCandidates,
  sentenceSimilarity
} = require('./sentenceAlignment');
const layoutStructure = require('./layoutStructure');

const VERSION = 7;
const MIN_CONTENT_RECALL = 0.50;
const MIN_SEMANTIC_FALLBACK = 0.62;
const CLAIM_PATTERNS = Object.freeze({
  action: /(?:수행|담당|개발|분석|설계|운영|개선|협업|해결|참여|작성|구축|기획|관리|제작|조사|발표|주도|실행|근무|프로젝트)/u,
  competency: /(?:역량|능력|기술|활용|소통|협업|책임|전문성|문제\s*해결|리더십|성실|강점)/u,
  result: /(?:성과|달성|향상|증가|감소|개선|수상|완료|기여|효율|절감|성장|\d+(?:\.\d+)?%)/u,
  job_link: /(?:직무|지원|입사|귀사|회사|기업|업무|포부|조직|고객|현장|기여하|성장하)/u,
  learning: /(?:배웠|깨달|알게\s*되|느꼈|체감|확인할\s*수\s*있었|교훈|판단의\s*기준)/u
});

function auditResumeCoverage(source, output, documentProfile = null) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const safetyProfiles = Array.isArray(documentProfile?.safetyProfiles)
    ? documentProfile.safetyProfiles.map(value => String(value || ''))
    : [];
  // 사용자 지정 프로필과 저신뢰 라우팅에서도 자소서의 행동·성과·직무 연결
  // 누락은 동일한 사고다. 분류 신뢰도를 안전 감사의 ON/OFF 스위치로 쓰지 않는다.
  const applicable = profile === 'resume_application'
    || safetyProfiles.includes('resume_application');
  if (!applicable) return emptyReport(false);
  const sourceSentences = meaningfulSentences(source);
  const outputSentences = meaningfulSentences(output);
  const claims = sourceSentences
    .map((sentence, index) => ({ sentence, index, types: claimTypes(sentence), tokens: contentTokens(sentence) }))
    .filter(item => item.types.length > 0 && item.tokens.length >= 3);
  const rows = claims.map(claim => compareClaim(claim, sourceSentences.length, outputSentences));
  const omissions = rows.filter(item => !item.covered);
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
      semanticSimilarity: item.semanticSimilarity,
      aligned: item.aligned,
      sourceSentence: item.sourceSentence,
      previousContext: sourceSentences[item.sourceIndex - 1] || '',
      nextContext: sourceSentences[item.sourceIndex + 1] || ''
    }))
  };
}

function compareClaim(claim, sourceCount, outputSentences) {
  if (!outputSentences.length) return row(claim, -1, 0, 0, false);
  const localCandidates = alignedOutputCandidates(
    claim.sentence,
    claim.index,
    sourceCount,
    outputSentences,
    { window: 3, maxOutputGroup: 3 }
  );
  let best = bestCandidate(claim, localCandidates);
  // 문단 재배치나 제목 인식 변화로 위치 정렬만 흔들린 경우, 실제로 남아
  // 있는 주장을 누락으로 오인하지 않도록 문서 전체에서 한 번 더 찾는다.
  // 연속 세 문장까지만 묶고 내용어 회수율과 의미 유사도를 함께 요구한다.
  if (!candidateCovered(best)) {
    const globalBest = bestCandidate(claim, globalOutputCandidates(outputSentences, 3));
    if (isBetterCandidate(globalBest, best)) best = globalBest;
  }
  const aligned = best.recall >= 0.2
    || best.similarity >= 0.45
    || best.semanticSimilarity >= 0.48;
  return row(
    claim,
    best.index,
    best.recall,
    best.semanticSimilarity,
    aligned,
    best.learningEquivalent === true
  );
}

function bestCandidate(claim, candidates) {
  let best = { index: -1, recall: 0, similarity: 0, semanticSimilarity: 0, learningEquivalent: false };
  for (const candidate of candidates) {
    const candidateTokens = new Set(contentTokens(candidate.text));
    const recall = claim.tokens.filter(token => candidateTokens.has(token)).length / Math.max(1, claim.tokens.length);
    const sourceNorm = normalize(claim.sentence);
    const outputNorm = normalize(candidate.text);
    const similarity = 1 - (levenshteinDistance(sourceNorm, outputNorm) / Math.max(1, sourceNorm.length, outputNorm.length));
    const semanticSimilarity = sentenceSimilarity(claim.sentence, candidate.text);
    const learningEquivalent = claim.types.includes('learning')
      && hasLearningFunction(claim.sentence)
      && hasLearningFunction(candidate.text)
      && recall >= 0.28;
    const current = { index: candidate.start, recall, similarity, semanticSimilarity, learningEquivalent };
    if (isBetterCandidate(current, best)) best = current;
  }
  return best;
}

function isBetterCandidate(candidate, current) {
  return (candidate.learningEquivalent === true && current.learningEquivalent !== true)
    || (candidate.learningEquivalent === current.learningEquivalent
      && (candidate.recall > current.recall
        || (candidate.recall === current.recall
          && candidate.semanticSimilarity > current.semanticSimilarity)
        || (candidate.recall === current.recall
          && candidate.semanticSimilarity === current.semanticSimilarity
          && candidate.similarity > current.similarity)));
}

function globalOutputCandidates(sentences, maxGroup = 3) {
  const rows = [];
  for (let start = 0; start < sentences.length; start += 1) {
    for (let size = 1; size <= maxGroup && start + size <= sentences.length; size += 1) {
      rows.push({
        start,
        end: start + size - 1,
        text: sentences.slice(start, start + size).join(' ')
      });
    }
  }
  return rows;
}

function candidateCovered(candidate) {
  return candidate.learningEquivalent === true
    || candidate.recall >= 0.55
    || (candidate.recall >= MIN_CONTENT_RECALL && candidate.semanticSimilarity >= 0.40)
    || (candidate.recall >= 0.42 && candidate.semanticSimilarity >= MIN_SEMANTIC_FALLBACK);
}

function row(claim, outputIndex, recall, semanticSimilarity, aligned, learningEquivalent = false) {
  const covered = aligned && candidateCovered({ recall, semanticSimilarity, learningEquivalent });
  return {
    sourceIndex: claim.index,
    outputIndex,
    sourceSentence: claim.sentence,
    types: claim.types,
    contentRecall: round4(recall),
    semanticSimilarity: round4(semanticSimilarity),
    learningEquivalent,
    aligned,
    covered
  };
}

function claimTypes(sentence) {
  return Object.entries(CLAIM_PATTERNS)
    .filter(([, pattern]) => pattern.test(String(sentence || '')))
    .map(([type]) => type);
}

function meaningfulSentences(value) {
  const editableLines = layoutStructure.buildLineRecords(String(value || ''))
    .filter(record => !record.blank)
    .flatMap(record => {
      if ([
        'title',
        'heading',
        'label',
        'table',
        'flow',
        'quote',
        'code',
        'legal_clause',
        'signature'
      ].includes(record.role)) return [];
      if (record.role === 'label_inline') {
        const body = layoutStructure.bracketLabelParts(record.text)?.rest
          || layoutStructure.labelParts(record.text)?.rest
          || '';
        return body ? [body] : [];
      }
      if (record.role === 'list') {
        const listBody = layoutStructure.listPrefixParts(record.text)?.body || String(record.text || '');
        const body = listBody.replace(
          /^[^.!?。！？\n]{2,100}?\s+\[[^\]\n]{2,140}\]\s+(?=\S)/u,
          ''
        );
        return body ? [body] : [];
      }
      return [record.text];
    });
  return splitSentences(editableLines.join('\n'))
    .flatMap(splitCoverageRunOn)
    .map(sentence => String(sentence || '').trim())
    .filter(sentence => normalize(sentence).length >= 5);
}

function splitCoverageRunOn(value) {
  const sentence = String(value || '').trim();
  // 붙여넣기·OCR 원문은 마침표 없이 `...했습니다 다음으로 ...했습니다`가
  // 수백 자 이어지는 경우가 있다. 하나의 거대 주장과 결과의 앞 세 문장만
  // 비교하면 실제로 보존된 뒤쪽 행동·성과를 누락으로 오인한다. 감사용
  // 단위만 확실한 격식 종결에서 나누며 사용자 문서 자체는 바꾸지 않는다.
  if (sentence.length < 180) return [sentence];
  const boundary = /(?:습니다|입니다)[ \t]+(?=[가-힣A-Za-z0-9“"'‘「『《〈])/gu;
  const rows = [];
  let start = 0;
  for (const match of sentence.matchAll(boundary)) {
    const endingLength = match[0].length - (match[0].match(/[ \t]+$/u)?.[0].length || 0);
    const end = Number(match.index || 0) + endingLength;
    const row = sentence.slice(start, end).trim();
    if (row) rows.push(row);
    start = Number(match.index || 0) + match[0].length;
  }
  const tail = sentence.slice(start).trim();
  if (tail) rows.push(tail);
  return rows.length >= 2 ? rows : [sentence];
}

function contentTokens(value) {
  const stop = new Set([
    '그리고', '그러나', '하지만', '따라서', '또한', '통해', '위해', '대한',
    '있', '하', '되', '경험', '과정', '이러', '매우', '점'
  ]);
  return [...new Set((String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}|\d+(?:\.\d+)?%?/gu) || [])
    .map(normalizeContentToken)
    .filter(token => token.length >= 2 && !stop.has(token)))];
}

function normalizeContentToken(value) {
  let token = String(value || '').normalize('NFKC').toLowerCase();
  const suffixes = [
    /(?:으로부터|에게서는|으로서는|에게서|에서는|으로는|에게는|이라는|이라고|까지는|부터는)$/u,
    /(?:하였습니다|했습니다|되었습니다|하였고|하였으며|했으며|했지만|하였다|되었다|이었다|였습니다|했습니다)$/u,
    /(?:합니다|됩니다|입니다|이었다|였다|한다|된다|이다)$/u,
    /(?:으려는|으려고|으려|려는|려고|도록|하면서|했지만|하지만|하는|하며|하여|해서|하고|하면|한)$/u,
    /(?:되는|되어|되고|되며|되면|된)$/u,
    /(?:습니다|었습니다|았다|었다|였고|이며|이고)$/u,
    /(?:까지|부터|에게|에서|보다|처럼|으로|로서|로써|와|과|은|는|이|가|을|를|의|에|도|만|로)$/u,
    /(?:으면서|면서|으며|며|으니|니|으나|으므로|므로|으려|려|으려고|려고|기)$/u
  ];
  for (let pass = 0; pass < 3; pass += 1) {
    const before = token;
    for (const pattern of suffixes) {
      const candidate = token.replace(pattern, '');
      if (candidate.length >= 2 && candidate !== token) {
        token = candidate;
        break;
      }
    }
    if (token === before) break;
  }
  return token;
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
      && item.types.some(type => ['learning', 'job_link', 'competency', 'action', 'result'].includes(type)))
    .filter(item => String(item.sourceSentence || '').trim().length >= 12)
    .sort((left, right) => claimPriority(right) - claimPriority(left)
      || Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0));
  let text = before;
  const restoredSourceOrdinals = [];
  for (const omission of prioritized) {
    if (restoredSourceOrdinals.length >= Math.max(1, Number(maxRestoreCount) || 2)) break;
    const sentence = String(omission.sourceSentence || '').trim();
    if (!sentence || normalize(text).includes(normalize(sentence))) continue;
    const spans = splitSentenceSpans(text);
    const previous = bestAnchorSpan(omission.previousContext, spans);
    const next = bestAnchorSpan(omission.nextContext, spans);
    const learningClaim = Array.isArray(omission.types) && omission.types.includes('learning');
    const previousMinimum = learningClaim ? 0.42 : 0.5;
    const nextMinimum = learningClaim ? 0.48 : 0.5;
    const sourceFinalClaim = !String(omission.nextContext || '').trim();
    if (sourceFinalClaim && previous && previous.score >= 0.55) {
      const insertion = previous.span.end;
      text = `${text.slice(0, insertion)} ${sentence}${text.slice(insertion)}`;
      restoredSourceOrdinals.push(Number(omission.sourceOrdinal || Number(omission.sourceIndex || 0) + 1));
      continue;
    }
    if (!previous || !next
        || previous.score < previousMinimum
        || next.score < nextMinimum
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
  let score = 0;
  if (types.has('learning')) score += 5;
  if (types.has('result')) score += 3;
  if (types.has('job_link')) score += 3;
  if (types.has('competency')) score += 2;
  if (types.has('action')) score += 1;
  return score;
}

function hasLearningFunction(value) {
  return /(?:배웠|배우|깨달|알게\s*되|느꼈|느끼|체감|인식|판단|확인할\s*수\s*있었|교훈)/u
    .test(String(value || ''));
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
  MIN_SEMANTIC_FALLBACK,
  CLAIM_PATTERNS,
  auditResumeCoverage,
  contentTokens,
  claimTypes,
  isImproved,
  isSafeRestorationShape,
  restoreMissingClaimsLocally
};
