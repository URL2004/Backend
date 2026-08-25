'use strict';

const { PACKS } = require('./index');

const REQUIRED_FIELDS = Object.freeze([
  'id', 'domain', 'approved', 'jurisdiction', 'reviewedAt', 'sourceCheckedAt',
  'approval', 'sources', 'institutionTerms', 'treatmentTerms', 'claimTerms',
  'blockedClaimTerms', 'notice'
]);

function validatePack(pack) {
  const errors = [];
  for (const key of REQUIRED_FIELDS) {
    if (pack?.[key] === undefined || pack?.[key] === null || pack?.[key] === '') errors.push(`missing:${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(pack?.reviewedAt || ''))) errors.push('invalid:reviewedAt');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(pack?.sourceCheckedAt || ''))) errors.push('invalid:sourceCheckedAt');
  if (pack?.jurisdiction !== 'KR') errors.push('invalid:jurisdiction');
  if (!Array.isArray(pack?.sources) || !pack.sources.length) errors.push('invalid:sources');
  else if (pack.sources.some(source => !source?.title || !source?.publisher || !/^https:\/\//u.test(source?.url || ''))) errors.push('invalid:source');
  if (!pack?.approval || !['PENDING_OWNER_REVIEW', 'APPROVED'].includes(pack.approval.status)) errors.push('invalid:approval');
  if (pack?.approved === true && (pack?.approval?.status !== 'APPROVED' || !pack?.approval?.owner || !pack?.approval?.approvedAt)) {
    errors.push('invalid:approvedWithoutSignoff');
  }
  for (const key of ['institutionTerms', 'treatmentTerms', 'claimTerms', 'blockedClaimTerms']) {
    if (!Array.isArray(pack?.[key])) errors.push(`invalid:${key}`);
  }
  return { valid: errors.length === 0, errors };
}

function registrySnapshot() {
  const packs = PACKS.map(pack => {
    const validation = validatePack(pack);
    return {
      id: pack.id,
      domain: pack.domain,
      locale: 'ko-KR',
      jurisdiction: pack.jurisdiction,
      approved: pack.approved === true,
      approvalStatus: pack.approved === true ? 'APPROVED' : 'PENDING_OWNER_REVIEW',
      reviewedAt: pack.reviewedAt,
      sourceCheckedAt: pack.sourceCheckedAt,
      approval: pack.approval,
      sources: pack.sources,
      validation,
      termCounts: {
        institutions: pack.institutionTerms.length,
        treatments: pack.treatmentTerms.length,
        claims: pack.claimTerms.length,
        blockedClaims: pack.blockedClaimTerms.length
      },
      notice: pack.notice
    };
  });
  return {
    version: 'writing-policy-registry-v1',
    jurisdiction: 'KR',
    generatedAt: new Date().toISOString(),
    launchEligible: packs.every(pack => pack.approved && pack.validation.valid),
    pendingDomains: packs.filter(pack => !pack.approved).map(pack => pack.domain),
    invalidPackIds: packs.filter(pack => !pack.validation.valid).map(pack => pack.id),
    packs
  };
}

module.exports = { REQUIRED_FIELDS, validatePack, registrySnapshot };
