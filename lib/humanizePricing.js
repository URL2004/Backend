'use strict';

const SHORT_HUMANIZE_MIN_CREDITS = 10;

function restructureCredit(length, evidenceEnabled = false) {
  const len = Math.max(0, Number(length) || 0);
  const tier = len <= 10000 ? 0 : (len <= 20000 ? 1 : 2);
  const base = [200, 400, 600][tier];
  return base + (evidenceEnabled ? 100 : 0);
}

function shortHumanizeCredit(length) {
  const len = Math.max(0, Number(length) || 0);
  return Math.max(SHORT_HUMANIZE_MIN_CREDITS, Math.ceil(len / 100) * 2);
}

module.exports = {
  SHORT_HUMANIZE_MIN_CREDITS,
  restructureCredit,
  shortHumanizeCredit
};
