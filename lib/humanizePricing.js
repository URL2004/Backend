'use strict';

const SHORT_HUMANIZE_MIN_CREDITS = 10;

const RESTRUCTURE_PRICE_POLICY = Object.freeze({
  base: Object.freeze({
    includedLength: 3000,
    includedCredits: 100,
    mediumMaxLength: 10000,
    mediumMaxCredits: 200,
    mediumStepLength: 350,
    longMaxLength: 30000,
    longStepLength: 250,
    stepCredits: 5,
    maxCredits: 600
  }),
  evidence: Object.freeze({
    includedLength: 3000,
    includedCredits: 50,
    graduatedMaxLength: 10000,
    stepLength: 700,
    stepCredits: 5,
    maxCredits: 100
  })
});

// Compatibility export: these are representative policy anchors, not flat-price ranges.
const RESTRUCTURE_TIERS = Object.freeze([
  Object.freeze({ maxLength: 3000, base: 100, evidence: 50 }),
  Object.freeze({ maxLength: 10000, base: 200, evidence: 100 }),
  Object.freeze({ maxLength: 20000, base: 400, evidence: 100 }),
  Object.freeze({ maxLength: Infinity, base: 600, evidence: 100 })
]);

function normalizedLength(length) {
  return Math.max(0, Number(length) || 0);
}

function restructureBaseCredit(length) {
  const len = normalizedLength(length);
  const policy = RESTRUCTURE_PRICE_POLICY.base;

  if (len <= policy.includedLength) return policy.includedCredits;
  if (len <= policy.mediumMaxLength) {
    return Math.min(
      policy.mediumMaxCredits,
      policy.includedCredits
        + policy.stepCredits * Math.ceil((len - policy.includedLength) / policy.mediumStepLength)
    );
  }
  if (len <= policy.longMaxLength) {
    return Math.min(
      policy.maxCredits,
      policy.mediumMaxCredits
        + policy.stepCredits * Math.ceil((len - policy.mediumMaxLength) / policy.longStepLength)
    );
  }
  return policy.maxCredits;
}

function restructureEvidenceCredit(length) {
  const len = normalizedLength(length);
  const policy = RESTRUCTURE_PRICE_POLICY.evidence;

  if (len <= policy.includedLength) return policy.includedCredits;
  if (len <= policy.graduatedMaxLength) {
    return Math.min(
      policy.maxCredits,
      policy.includedCredits
        + policy.stepCredits * Math.floor((len - policy.includedLength) / policy.stepLength)
    );
  }
  return policy.maxCredits;
}

function restructureCredit(length, evidenceEnabled = false) {
  const base = restructureBaseCredit(length);
  return base + (evidenceEnabled ? restructureEvidenceCredit(length) : 0);
}

function shortHumanizeCredit(length) {
  const len = Math.max(0, Number(length) || 0);
  return Math.max(SHORT_HUMANIZE_MIN_CREDITS, Math.ceil(len / 100) * 2);
}

module.exports = {
  RESTRUCTURE_PRICE_POLICY,
  RESTRUCTURE_TIERS,
  SHORT_HUMANIZE_MIN_CREDITS,
  restructureBaseCredit,
  restructureEvidenceCredit,
  restructureCredit,
  shortHumanizeCredit
};
