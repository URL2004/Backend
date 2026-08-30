'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { restoreSourceSentenceOrdinals, sentenceSimilarity } = require('./sourceSentenceRestore');

const VERSION = 1;
const MIN_ALIGNMENT_SCORE = 0.24;
const MIN_ALIGNMENT_MARGIN = 0.08;

const OUTCOME_FAMILIES = Object.freeze({
  launch: /(?:런칭|출시|출품|공개|롤아웃|상용화|시장\s*진입)/iu,
  revenue: /(?:매출|거래액|매상|수익|판매액)/iu,
  conversion: /(?:전환율?|구매\s*전환|결제\s*전환|유료\s*전환)/iu,
  growth: /(?:성장률?|증가율?|증대|확대|상승|개선)/iu,
  achievement: /(?:성과|실적|달성|성공|우수|상위|목표\s*달성|기록)/iu,
  retention: /(?:리텐션|재유입|재방문|재구매|이탈\s*방지)/iu
});

const TARGET_CLASSIFIER = /([\p{L}][\p{L}\p{N}+&._-]{1,30})(?:(?:과|와)\s*같은|처럼|같은)?\s*(?:다른\s*)?(?:장르|카테고리|제품|서비스|작품|IP|브랜드|시장|고객군|세그먼트)/giu;
const UPPER_ENTITY = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9+&._-]{1,19})(?=$|[^A-Za-z0-9])/gu;
const QUOTED_ENTITY = /[“‘"'「『《〈]([^\n”’"'」』》〉]{2,40})[”’"'」』》〉]/gu;
const ENTITY_STOP = new Set(['IP', 'CRM', 'SNS', 'AI', 'API', 'SEO', 'UI', 'UX', 'KPI']);
const GENERIC_ENTITY_STOP = new Set([
  '같은', '다른', '신규', '기존', '해당', '여러', '다양한', '일반', '관련',
  '타', '새', '새로운', '우선', '특정', '각', '개별', '동일', '동일한',
  '지닌', '가진', '있는', '없는', '하는', '된',
  '글로벌', '해외', '국내', '대표', '핵심', '주요', '프리미엄', '보급형',
  '고급', '대중', '온라인', '오프라인', '신흥', '주력'
]);

function auditUnsupportedSpecificity(source, outputText, allowedExtra = '') {
  const rawSource = String(source || '');
  const output = String(outputText || '');
  const allowedWorld = [rawSource, String(allowedExtra || '')].filter(Boolean).join('\n');
  const sourceSpans = splitSentenceSpans(rawSource);
  const outputSpans = splitSentenceSpans(output);
  const worldEntities = new Set(extractEntityCandidates(allowedWorld).map(normalizeEntity));
  const worldCompact = compact(allowedWorld);
  const sourceFamilySet = new Set(sourceSpans.flatMap(span => outcomeFamilies(span.text)));
  const issues = [];

  outputSpans.forEach((span, outputIndex) => {
    const families = outcomeFamilies(span.text);
    if (!isOutcomeClaim(span.text, families)) return;
    const introducedEntities = extractEntityCandidates(span.text)
      .filter(entity => !entityExistsInWorld(entity, worldEntities, worldCompact));
    if (!introducedEntities.length) return;
    if (combinationExists(allowedWorld, introducedEntities, families)) return;

    const alignment = alignOutputSentence(sourceSpans, outputSpans, outputIndex);
    const alignedText = alignment ? sourceSpans[alignment.sourceIndex].text : '';
    const transferredFamilies = families.filter(family => sourceFamilySet.has(family));
    const signatures = compareClaimSignatures(alignedText, span.text);
    const alignmentSafe = Boolean(alignment)
      && (alignment.score >= MIN_ALIGNMENT_SCORE || alignment.stablePosition === true)
      && (alignment.margin >= MIN_ALIGNMENT_MARGIN || alignment.stablePosition === true);
    const autoRestorable = alignmentSafe && signatures.pass;
    issues.push({
      code: 'unsupported_specificity_attribution',
      outputOrdinal: outputIndex + 1,
      sourceOrdinal: alignment ? alignment.sourceIndex + 1 : null,
      introducedEntities,
      outcomeFamilies: families,
      transferredOutcomeFamilies: transferredFamilies,
      alignmentScore: alignment ? alignment.score : 0,
      alignmentMargin: alignment ? alignment.margin : 0,
      autoRestorable,
      restoreBlockReasons: [
        ...(!alignmentSafe ? ['ambiguous_or_weak_alignment'] : []),
        ...signatures.reasons
      ]
    });
  });

  return {
    version: VERSION,
    applicable: outputSpans.length > 0,
    pass: issues.length === 0,
    issueCount: issues.length,
    restorableCount: issues.filter(issue => issue.autoRestorable).length,
    // audit 시점에 아직 출력에 남아 있는 전체 이슈 수다. 자동 복원 가능
    // 여부와 혼동하면 pass=false인데 residualCount=0인 모순된 관측이 생긴다.
    residualCount: issues.length,
    nonRestorableCount: issues.filter(issue => !issue.autoRestorable).length,
    issues
  };
}

function restoreUnsupportedSpecificityClaims(source, outputText, audit) {
  const before = String(outputText || '');
  const report = audit && Array.isArray(audit.issues)
    ? audit
    : auditUnsupportedSpecificity(source, before, '');
  const safeIssues = report.issues
    .filter(issue => issue.autoRestorable === true)
    .filter(issue => Number.isInteger(issue.sourceOrdinal) && issue.sourceOrdinal > 0);
  const restored = safeIssues.length
    ? restoreSourceSentenceOrdinals(source, before, safeIssues.map(issue => issue.sourceOrdinal), {
        maxRestoreCount: 8,
        minSimilarity: MIN_ALIGNMENT_SCORE,
        ordinalSpace: 'source',
        maxOutputGroup: 3,
        allowStablePositionalFallback: true
      })
    : {
        text: before,
        applied: false,
        restoredSentenceOrdinals: [],
        reason: 'no_safe_target'
      };
  const restoredSourceSet = new Set(restored.restoredSentenceOrdinals || []);
  const restoredOutputOrdinals = safeIssues
    .filter(issue => restoredSourceSet.has(issue.sourceOrdinal))
    .map(issue => issue.outputOrdinal);
  const restoredOutputSet = new Set(restoredOutputOrdinals);
  let current = restored.text;
  const residualIssues = report.issues.filter(issue => !restoredOutputSet.has(issue.outputOrdinal));
  const removedOutputOrdinals = [];
  const remainingIssues = [];
  for (const issue of residualIssues) {
    const targetIndex = locateResidualIssueSentence(current, issue);
    if (targetIndex < 0) {
      remainingIssues.push(issue);
      continue;
    }
    const deletion = removeSentenceAt(current, targetIndex);
    const safety = auditGroundedSentenceRemoval(source, current, deletion);
    if (!safety.pass) {
      remainingIssues.push({ ...issue, removalBlockReasons: safety.reasons });
      continue;
    }
    current = deletion;
    removedOutputOrdinals.push(issue.outputOrdinal);
  }
  const deletionApplied = removedOutputOrdinals.length > 0;
  return restoreResult(
    current,
    restored.applied === true || deletionApplied,
    [...restoredOutputSet],
    remainingIssues,
    deletionApplied ? 'grounded_residual_sentence_removed' : (restored.reason || 'no_safe_alignment'),
    {
      removedCount: removedOutputOrdinals.length,
      removedOutputOrdinals,
      removalCode: deletionApplied ? 'grounded_residual_sentence_removed' : ''
    }
  );
}

function isOutcomeClaim(text, families) {
  if (families.length >= 2) return true;
  return families.length === 1
    && /(?:확인|검증|달성|기록|거두|이끌|높|우수|상위|증가|성장|성공)/u.test(text);
}

function outcomeFamilies(value) {
  return Object.entries(OUTCOME_FAMILIES)
    .filter(([, pattern]) => pattern.test(String(value || '')))
    .map(([family]) => family);
}

function extractEntityCandidates(value) {
  const text = String(value || '');
  const out = [];
  for (const pattern of [TARGET_CLASSIFIER, UPPER_ENTITY, QUOTED_ENTITY]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const entity = String(match[1] || '').trim();
      // ASCII apostrophe in P'(x) or a full direct quotation is not an entity.
      // Quoted names remain useful, but only short title/name-like spans enter
      // the unsupported-target audit.
      if (pattern === QUOTED_ENTITY
          && (entity.length > 24 || /[.!?。！？=<>\n]/u.test(entity))) continue;
      if (entity.length < 2
          || ENTITY_STOP.has(entity.toUpperCase())
          || GENERIC_ENTITY_STOP.has(entity)) continue;
      out.push(entity);
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return [...new Set(out)];
}

function entityExistsInWorld(entity, entitySet, worldCompact) {
  const key = normalizeEntity(entity);
  return entitySet.has(key) || (key.length >= 2 && worldCompact.includes(key));
}

function combinationExists(world, entities, families) {
  return splitSentenceSpans(String(world || '')).some(span => {
    const sentenceCompact = compact(span.text);
    if (!entities.some(entity => sentenceCompact.includes(normalizeEntity(entity)))) return false;
    const sentenceFamilies = new Set(outcomeFamilies(span.text));
    return families.every(family => sentenceFamilies.has(family));
  });
}

function alignOutputSentence(sourceSpans, outputSpans, outputIndex) {
  if (!sourceSpans.length || !outputSpans[outputIndex]) return null;
  const center = outputSpans.length <= 1
    ? 0
    : Math.round(outputIndex * Math.max(0, sourceSpans.length - 1) / Math.max(1, outputSpans.length - 1));
  const ranked = sourceSpans.map((span, sourceIndex) => {
    const rawScore = sentenceSimilarity(span.text, outputSpans[outputIndex].text);
    const positionalPenalty = Math.min(0.12, Math.abs(sourceIndex - center) * 0.018);
    return { sourceIndex, score: Math.max(0, rawScore - positionalPenalty) };
  }).sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex);
  const best = ranked[0];
  if (!best) return null;
  if (sourceSpans.length === outputSpans.length) {
    const positional = ranked.find(item => item.sourceIndex === outputIndex);
    const neighborIndices = [outputIndex - 1, outputIndex + 1]
      .filter(index => index >= 0 && index < sourceSpans.length);
    const stableNeighbors = neighborIndices.length > 0 && neighborIndices.every(index => (
      sentenceSimilarity(sourceSpans[index].text, outputSpans[index].text) >= 0.42
    ));
    if (positional && stableNeighbors) {
      return {
        ...positional,
        margin: positional.sourceIndex === best.sourceIndex
          ? positional.score - Number(ranked[1]?.score || 0)
          : 0,
        stablePosition: true
      };
    }
  }
  return { ...best, margin: best.score - Number(ranked[1]?.score || 0) };
}

function compareClaimSignatures(sourceSentence, outputSentence) {
  const reasons = [];
  if (!sameMultiset(numberTokens(sourceSentence), numberTokens(outputSentence))) reasons.push('number_signature_changed');
  if (!sameMultiset(quoteTokens(sourceSentence), quoteTokens(outputSentence))) reasons.push('quote_signature_changed');
  if (negationSignature(sourceSentence) !== negationSignature(outputSentence)) reasons.push('negation_signature_changed');
  if (!sameMultiset(modalityTokens(sourceSentence), modalityTokens(outputSentence))) reasons.push('modality_signature_changed');
  return { pass: reasons.length === 0, reasons };
}

function locateResidualIssueSentence(value, issue) {
  const spans = splitSentenceSpans(String(value || ''));
  const expected = Number(issue?.outputOrdinal) - 1;
  const matchesIssue = span => {
    const sentence = String(span?.text || '');
    const normalized = compact(sentence).toLowerCase();
    const entityMatch = (issue?.introducedEntities || [])
      .some(entity => normalized.includes(normalizeEntity(entity)));
    const families = new Set(outcomeFamilies(sentence));
    const familyMatch = (issue?.outcomeFamilies || []).filter(family => families.has(family)).length >= 2;
    return entityMatch && familyMatch;
  };
  if (expected >= 0 && expected < spans.length && matchesIssue(spans[expected])) return expected;
  const candidates = spans
    .map((span, index) => ({ index, matches: matchesIssue(span) }))
    .filter(item => item.matches);
  return candidates.length === 1 ? candidates[0].index : -1;
}

function removeSentenceAt(value, sentenceIndex) {
  const text = String(value || '');
  const spans = splitSentenceSpans(text);
  const span = spans[sentenceIndex];
  if (!span) return text;
  const left = text.slice(0, span.start);
  let right = text.slice(span.end);
  if (/[ \t]$/u.test(left) && /^[ \t]/u.test(right)) right = right.replace(/^[ \t]+/u, '');
  return (left + right)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/gu, '\n\n')
    .trim();
}

function auditGroundedSentenceRemoval(source, before, candidate) {
  const sourceSpans = splitSentenceSpans(String(source || ''));
  const beforeSpans = splitSentenceSpans(String(before || ''));
  const candidateSpans = splitSentenceSpans(String(candidate || ''));
  const reasons = [];
  if (!candidate.trim() || !sourceSpans.length || !candidateSpans.length) {
    return { pass: false, reasons: ['empty_or_unalignable_candidate'] };
  }
  const beforeCoverage = sourceCoverage(sourceSpans, beforeSpans);
  const candidateCoverage = sourceCoverage(sourceSpans, candidateSpans);
  if (candidateCoverage.some(score => score < 0.28)) reasons.push('source_coverage_below_absolute_minimum');
  if (candidateCoverage.some((score, index) => beforeCoverage[index] - score > 0.12)) {
    reasons.push('source_coverage_worsened');
  }
  if (!preservesUniqueSourceSignatures(source, before, candidate)) {
    reasons.push('unique_source_signature_removed');
  }
  return {
    pass: reasons.length === 0,
    reasons,
    minimumCoverage: candidateCoverage.length ? Math.min(...candidateCoverage) : 0,
    maximumCoverageRegression: candidateCoverage.reduce(
      (maximum, score, index) => Math.max(maximum, beforeCoverage[index] - score),
      0
    )
  };
}

function sourceCoverage(sourceSpans, outputSpans) {
  return sourceSpans.map(sourceSpan => outputSpans.reduce(
    (best, outputSpan) => Math.max(best, sentenceSimilarity(sourceSpan.text, outputSpan.text)),
    0
  ));
}

function preservesUniqueSourceSignatures(source, before, candidate) {
  const extractors = [numberTokens, quoteTokens, negationTokens, modalityTokens];
  return extractors.every(extract => {
    const sourceCounts = tokenCounts(extract(source));
    const beforeCounts = tokenCounts(extract(before));
    const candidateCounts = tokenCounts(extract(candidate));
    for (const [token, sourceCount] of sourceCounts) {
      const preservedBefore = Math.min(sourceCount, beforeCounts.get(token) || 0);
      if ((candidateCounts.get(token) || 0) < preservedBefore) return false;
    }
    return true;
  });
}

function numberTokens(value) {
  return (String(value || '').match(/\d+(?:[.,]\d+)?%?|한\s*번|두\s*번|세\s*번|네\s*번|다섯\s*번/gu) || [])
    .map(token => token.replace(/\s+/gu, ''));
}

function quoteTokens(value) {
  const out = [];
  const pattern = /[“‘"'「『《〈]([^\n”’"'」』》〉]+)[”’"'」』》〉]/gu;
  let match;
  while ((match = pattern.exec(String(value || ''))) !== null) out.push(compact(match[1]));
  return out;
}

function negationSignature(value) {
  return negationTokens(value).length;
}

function negationTokens(value) {
  return (String(value || '').match(/(?:아니|않|못|없|말다|말고|말며|말았)/gu) || [])
    .map(compact);
}

function modalityTokens(value) {
  return (String(value || '').match(/(?:수\s*있|수\s*없|가능|불가능|필요|의무|예정|계획|추정|것으로\s*보|것\s*같|수도\s*있)/gu) || [])
    .map(compact);
}

function sameMultiset(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function tokenCounts(values) {
  const counts = new Map();
  for (const value of values || []) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function normalizeEntity(value) {
  return compact(value).toLowerCase();
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}%]/gu, '');
}

function restoreResult(text, applied, restoredOutputOrdinals, residualIssues, reason, extra = {}) {
  return {
    version: VERSION,
    text,
    applied,
    restoredCount: restoredOutputOrdinals.length,
    restoredOutputOrdinals,
    residualCount: residualIssues.length,
    residualIssues,
    reason,
    removedCount: 0,
    removedOutputOrdinals: [],
    removalCode: '',
    ...extra
  };
}

module.exports = {
  VERSION,
  auditUnsupportedSpecificity,
  restoreUnsupportedSpecificityClaims
};
