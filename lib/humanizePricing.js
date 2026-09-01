'use strict';

const SHORT_HUMANIZE_MIN_CREDITS = 10;

const RESTRUCTURE_TIERS = Object.freeze([
  Object.freeze({ maxLength: 3000, base: 100, evidence: 50 }),
  Object.freeze({ maxLength: 10000, base: 200, evidence: 100 }),
  Object.freeze({ maxLength: 20000, base: 400, evidence: 100 }),
  Object.freeze({ maxLength: Infinity, base: 600, evidence: 100 })
]);

function restructureCredit(length, evidenceEnabled = false) {
  const len = Math.max(0, Number(length) || 0);
  const tier = RESTRUCTURE_TIERS.find(item => len <= item.maxLength)
    || RESTRUCTURE_TIERS[RESTRUCTURE_TIERS.length - 1];
  return tier.base + (evidenceEnabled ? tier.evidence : 0);
}

function shortHumanizeCredit(length) {
  const len = Math.max(0, Number(length) || 0);
  return Math.max(SHORT_HUMANIZE_MIN_CREDITS, Math.ceil(len / 100) * 2);
}

module.exports = {
  RESTRUCTURE_TIERS,
  SHORT_HUMANIZE_MIN_CREDITS,
  restructureCredit,
  shortHumanizeCredit
};
