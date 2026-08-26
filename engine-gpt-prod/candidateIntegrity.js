'use strict';

const koreanRefinement = require('./koreanRefinement');
const fingerprint = require('./fingerprintAudit');
const endingStyle = require('./endingStyleAudit');
const legalAudit = require('./legalAudit');
const structureChunk = require('./structureChunk');
const statisticalAtoms = require('./statisticalAtoms');
const dedupe = require('../engine/dedupe');
const {
  auditDirectQuoteIntegrity,
  auditVoice,
  buildVoiceProfile
} = require('./voiceProfile');

const STRUCTURE_WARNING_CODES = new Set([
  'list_structure_changed',
  'heading_structure_changed',
  'questionnaire_structure_changed',
  'title_line_merged',
  'structural_line_loss',
  'line_structure_changed',
  'creative_line_structure'
]);
const VOICE_WARNING_CODES = new Set([
  'speaker_injected',
  'speaker_removed',
  'personal_scope_generalized'
]);

/**
 * 모델·결정론·의미 수리 등 생성 주체와 무관하게 모든 늦은 후보가 통과해야
 * 하는 공통 비퇴행 감사다. 각 수리기가 자기 분야만 확인하면 다른 분야의
 * 오류를 새로 만들 수 있으므로, 현재 후보보다 악화된 항목이 하나라도 있으면
 * 후보 전체를 거부한다.
 */
function auditCandidateIntegrity({
  source = '',
  before = '',
  candidate = '',
  documentProfile = null,
  mode = ''
} = {}) {
  const reasons = [];
  const add = code => {
    if (!reasons.includes(code)) reasons.push(code);
  };
  const current = String(before || '');
  const after = String(candidate || '');
  if (!after.trim()) add('empty_candidate');

  const beforeKorean = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: current,
    documentProfile,
    mode
  });
  const candidateKorean = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: after,
    documentProfile,
    mode
  });
  const beforeKoreanIssueCounts = koreanIssueCounts(beforeKorean);
  const candidateKoreanIssueCounts = koreanIssueCounts(candidateKorean);
  if (koreanIntegrityWorsened({
    before: beforeKorean,
    candidate: candidateKorean,
    beforeCounts: beforeKoreanIssueCounts,
    candidateCounts: candidateKoreanIssueCounts
  })) {
    add('korean_integrity_worsened');
  }

  const beforeFingerprint = fingerprint.auditFingerprint(source, current, documentProfile);
  const candidateFingerprint = fingerprint.auditFingerprint(source, after, documentProfile);
  const beforeFingerprintRisk = fingerprintRisk(beforeFingerprint);
  const candidateFingerprintRisk = fingerprintRisk(candidateFingerprint);
  const beforeFingerprintCodes = new Set(beforeFingerprint.issueCodes || []);
  if (candidateFingerprintRisk > beforeFingerprintRisk
      || (candidateFingerprint.issueCodes || []).some(code => !beforeFingerprintCodes.has(code))) {
    add('semantic_relation_worsened');
  }

  const beforeEnding = endingStyle.auditEndingStyle(source, current, documentProfile);
  const candidateEnding = endingStyle.auditEndingStyle(source, after, documentProfile);
  if (Number(candidateEnding.issueCount || 0) > Number(beforeEnding.issueCount || 0)
      || Number(candidateEnding.introducedOtherCount || 0) > Number(beforeEnding.introducedOtherCount || 0)) {
    add('ending_style_worsened');
  }

  const beforeQuote = auditDirectQuoteIntegrity(source, current);
  const candidateQuote = auditDirectQuoteIntegrity(source, after);
  if ((!beforeQuote.pass && quoteRisk(candidateQuote) > quoteRisk(beforeQuote))
      || (beforeQuote.pass && !candidateQuote.pass)) {
    add('direct_quote_worsened');
  }

  const beforeLegal = legalAudit.auditLegalIntegrity(source, current, documentProfile);
  const candidateLegal = legalAudit.auditLegalIntegrity(source, after, documentProfile);
  if (candidateLegal.applicable
      && legalRisk(candidateLegal) > legalRisk(beforeLegal)) {
    add('legal_integrity_worsened');
  }

  const sourceVoice = buildVoiceProfile(source, { documentProfile, mode });
  const beforeStructureIssues = voiceStructureIssues(sourceVoice, source, current, documentProfile, mode);
  const candidateStructureIssues = voiceStructureIssues(sourceVoice, source, after, documentProfile, mode);
  const beforeVoiceIssues = voiceIntegrityIssues(sourceVoice, source, current, documentProfile, mode);
  const candidateVoiceIssues = voiceIntegrityIssues(sourceVoice, source, after, documentProfile, mode);
  const beforeStructureRisk = structureIssueRisk(beforeStructureIssues);
  const candidateStructureRisk = structureIssueRisk(candidateStructureIssues);
  const beforeTokenBoundaryRisk = lockedTokenBoundaryRisk(source, current);
  const candidateTokenBoundaryRisk = lockedTokenBoundaryRisk(source, after);
  const beforeLineAnchorRisk = lineAnchorRisk(source, current, sourceVoice);
  const candidateLineAnchorRisk = lineAnchorRisk(source, after, sourceVoice);
  if ([...candidateStructureIssues.entries()]
    .some(([code, count]) => count > Number(beforeStructureIssues.get(code) || 0))
      || candidateTokenBoundaryRisk > beforeTokenBoundaryRisk
      || candidateLineAnchorRisk > beforeLineAnchorRisk) {
    add('structure_integrity_worsened');
  }
  if ([...candidateVoiceIssues.entries()]
    .some(([code, count]) => count > Number(beforeVoiceIssues.get(code) || 0))) {
    add('voice_integrity_worsened');
  }

  const beforeGeneratedDuplicates = dedupe.auditGeneratedDuplicateIntegrity(source, current);
  const candidateGeneratedDuplicates = dedupe.auditGeneratedDuplicateIntegrity(source, after);
  if (generatedDuplicateWorsened(beforeGeneratedDuplicates, candidateGeneratedDuplicates)) {
    add('source_replay_worsened');
  }

  const beforeStatisticalAtoms = statisticalAtoms.auditStatisticalAtoms(source, current);
  const candidateStatisticalAtoms = statisticalAtoms.auditStatisticalAtoms(source, after);
  if (statisticalAtomWorsened(beforeStatisticalAtoms, candidateStatisticalAtoms)) {
    add('statistical_atom_worsened');
  }

  return {
    version: 3,
    pass: reasons.length === 0,
    reasons,
    before: {
      korean: compactKorean(beforeKorean),
      fingerprintRisk: beforeFingerprintRisk,
      endingIssueCount: Number(beforeEnding.issueCount || 0),
      quoteRisk: quoteRisk(beforeQuote),
      legalRisk: legalRisk(beforeLegal),
      structureRisk: beforeStructureRisk,
      voiceRisk: structureIssueRisk(beforeVoiceIssues),
      tokenBoundaryRisk: beforeTokenBoundaryRisk,
      lineAnchorRisk: beforeLineAnchorRisk,
      generatedDuplicateRisk: Number(beforeGeneratedDuplicates.riskCount || 0),
      statisticalAtomRisk: statisticalAtomRisk(beforeStatisticalAtoms)
    },
    candidate: {
      korean: compactKorean(candidateKorean),
      fingerprintRisk: candidateFingerprintRisk,
      endingIssueCount: Number(candidateEnding.issueCount || 0),
      quoteRisk: quoteRisk(candidateQuote),
      legalRisk: legalRisk(candidateLegal),
      structureRisk: candidateStructureRisk,
      voiceRisk: structureIssueRisk(candidateVoiceIssues),
      tokenBoundaryRisk: candidateTokenBoundaryRisk,
      lineAnchorRisk: candidateLineAnchorRisk,
      generatedDuplicateRisk: Number(candidateGeneratedDuplicates.riskCount || 0),
      statisticalAtomRisk: statisticalAtomRisk(candidateStatisticalAtoms)
    }
  };
}

function statisticalAtomRisk(value) {
  if (value?.applicable !== true) return 0;
  return Number(value?.removedCount || 0)
    + Number(value?.addedCount || 0)
    + Number(value?.whitespaceBrokenCount || 0);
}

function generatedDuplicateWorsened(before, candidate) {
  return [
    'exactBlockCount',
    'sourceReplayBlockCount',
    'sourceReplaySentenceCount',
    'localOverlapCount',
    'adjacentRestatementCount'
  ].some(key => Number(candidate?.[key] || 0) > Number(before?.[key] || 0));
}

function statisticalAtomWorsened(before, candidate) {
  return [
    'removedCount',
    'addedCount',
    'whitespaceBrokenCount'
  ].some(key => Number(candidate?.[key] || 0) > Number(before?.[key] || 0));
}

function fingerprintRisk(value) {
  return Number(value?.violations?.length || 0)
    + Number(value?.semanticRelations?.count || 0)
    + Number(value?.relationShift?.count || 0);
}

function quoteRisk(value) {
  return Number(value?.countChanged === true)
    + Number(value?.changedCount || 0);
}

function legalRisk(value) {
  if (!value?.applicable) return 0;
  return Number(value?.changedOperators?.length || 0)
    + Number(value?.changedClauses?.length || 0)
    + Number(value?.articleOrderPass === false);
}

function voiceStructureIssues(sourceVoice, source, output, documentProfile, mode) {
  return voiceIssueCounts(
    sourceVoice,
    source,
    output,
    documentProfile,
    mode,
    STRUCTURE_WARNING_CODES
  );
}

function voiceIntegrityIssues(sourceVoice, source, output, documentProfile, mode) {
  return voiceIssueCounts(
    sourceVoice,
    source,
    output,
    documentProfile,
    mode,
    VOICE_WARNING_CODES
  );
}

function voiceIssueCounts(sourceVoice, source, output, documentProfile, mode, acceptedCodes) {
  const audit = auditVoice(sourceVoice, output, {
    documentProfile,
    mode,
    sourceText: source
  });
  const counts = new Map();
  for (const item of audit.warnings || []) {
    const code = String(item?.code || '');
    if (!acceptedCodes.has(code)) continue;
    counts.set(code, Number(counts.get(code) || 0) + 1);
  }
  return counts;
}

function structureIssueRisk(issues) {
  let risk = 0;
  for (const count of issues.values()) risk += Number(count || 0);
  return risk;
}

function lockedTokenBoundaryRisk(reference, value) {
  const source = String(reference || '');
  const output = String(value || '');
  const tokens = [...new Set(source.match(/ZXQLOCK\d{4}QXZ/gu) || [])];
  let risk = 0;
  for (const token of tokens) {
    const expectedCount = source.split(token).length - 1;
    const actualCount = output.split(token).length - 1;
    if (actualCount !== expectedCount) {
      risk += Math.abs(actualCount - expectedCount) || 1;
      continue;
    }
    let sourceCursor = 0;
    let outputCursor = 0;
    for (let index = 0; index < expectedCount; index += 1) {
      const sourceIndex = source.indexOf(token, sourceCursor);
      const outputIndex = output.indexOf(token, outputCursor);
      if (sourceIndex < 0 || outputIndex < 0) {
        risk += 1;
        break;
      }
      const sourceLineStart = isLineStart(source, sourceIndex);
      const sourceLineEnd = isLineEnd(source, sourceIndex + token.length);
      if (sourceLineStart && !isLineStart(output, outputIndex)) risk += 1;
      if (sourceLineEnd && !isLineEnd(output, outputIndex + token.length)) risk += 1;
      sourceCursor = sourceIndex + token.length;
      outputCursor = outputIndex + token.length;
    }
  }
  return risk;
}

function isLineStart(value, index) {
  const lineStart = String(value || '').lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return /^[ \t]*$/u.test(String(value || '').slice(lineStart, index));
}

function isLineEnd(value, index) {
  const text = String(value || '');
  const lineEnd = text.indexOf('\n', index);
  return /^[ \t]*$/u.test(text.slice(index, lineEnd < 0 ? text.length : lineEnd));
}

function compactKorean(value) {
  return {
    weightedRisk: Number(value?.weightedRisk || 0),
    repairableIssueCount: Number(value?.repairableIssueCount || 0),
    introducedIssueCount: Number(value?.introducedIssueCount || 0),
    issueCodes: value?.issueCodes || []
  };
}

function koreanIssueCounts(value) {
  const counts = new Map();
  for (const issue of value?.issues || []) {
    const code = String(issue?.code || '');
    if (!code) continue;
    const count = Number(issue?.introducedCount ?? issue?.afterCount ?? issue?.count ?? 0);
    counts.set(code, Math.max(
      Number(counts.get(code) || 0),
      Number.isFinite(count) ? count : 0
    ));
  }
  return counts;
}

function lineAnchorRisk(source, output, sourceVoice) {
  const anchors = structureChunk.compareLineAnchorLayout(source, output);
  let risk = Number(anchors?.losses?.length || 0)
    + Number(anchors?.boundaryChanges?.length || 0)
    + Number(anchors?.additions?.length || 0);
  if (sourceVoice?.lineBoundaryPolicy === 'all') {
    const exact = structureChunk.auditExactLineStructure(source, output);
    if (exact.pass !== true) risk += 1;
  }
  return risk;
}

function koreanIntegrityWorsened({ before, candidate, beforeCounts, candidateCounts }) {
  if (Number(candidate?.repairableIssueCount || 0) > Number(before?.repairableIssueCount || 0)) return true;
  const definitionByCode = new Map((candidate?.issues || []).map(item => [String(item?.code || ''), item]));
  const increased = [];
  for (const [code, count] of candidateCounts.entries()) {
    const delta = Number(count || 0) - Number(beforeCounts.get(code) || 0);
    if (delta > 0) increased.push({ ...(definitionByCode.get(code) || {}), code, delta });
  }
  if (!increased.length) {
    return Number(candidate?.weightedRisk || 0) > Number(before?.weightedRisk || 0)
      || Number(candidate?.introducedIssueCount || 0) > Number(before?.introducedIssueCount || 0);
  }
  const introducedCount = increased.reduce((sum, item) => sum + Number(item.delta || 0), 0);
  const onlyOneReviewNotice = introducedCount <= 1
    && increased.every(item => item.repairable !== true && Number(item.weight || 1) <= 1);
  const materiallyImproved = Number(candidate?.weightedRisk || 0)
    <= Number(before?.weightedRisk || 0) - 1;
  return !(onlyOneReviewNotice && materiallyImproved);
}

module.exports = {
  auditCandidateIntegrity,
  koreanIntegrityWorsened,
  fingerprintRisk,
  quoteRisk,
  legalRisk,
  statisticalAtomRisk,
  generatedDuplicateWorsened,
  statisticalAtomWorsened
};
