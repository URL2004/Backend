'use strict';

const koreanRefinement = require('./koreanRefinement');
const fingerprint = require('./fingerprintAudit');
const endingStyle = require('./endingStyleAudit');
const legalAudit = require('./legalAudit');
const { auditDirectQuoteIntegrity } = require('./voiceProfile');

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
  if (candidateKorean.weightedRisk > beforeKorean.weightedRisk
      || candidateKorean.repairableIssueCount > beforeKorean.repairableIssueCount
      || candidateKorean.introducedIssueCount > beforeKorean.introducedIssueCount) {
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

  return {
    version: 1,
    pass: reasons.length === 0,
    reasons,
    before: {
      korean: compactKorean(beforeKorean),
      fingerprintRisk: beforeFingerprintRisk,
      endingIssueCount: Number(beforeEnding.issueCount || 0),
      quoteRisk: quoteRisk(beforeQuote),
      legalRisk: legalRisk(beforeLegal)
    },
    candidate: {
      korean: compactKorean(candidateKorean),
      fingerprintRisk: candidateFingerprintRisk,
      endingIssueCount: Number(candidateEnding.issueCount || 0),
      quoteRisk: quoteRisk(candidateQuote),
      legalRisk: legalRisk(candidateLegal)
    }
  };
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

function compactKorean(value) {
  return {
    weightedRisk: Number(value?.weightedRisk || 0),
    repairableIssueCount: Number(value?.repairableIssueCount || 0),
    introducedIssueCount: Number(value?.introducedIssueCount || 0),
    issueCodes: value?.issueCodes || []
  };
}

module.exports = {
  auditCandidateIntegrity,
  fingerprintRisk,
  quoteRisk,
  legalRisk
};
