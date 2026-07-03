'use strict';

const engine = require('./index');

async function suggestEvidence(opts = {}) {
  return await engine.suggestEvidence(opts);
}

async function suggestEvidenceForSegment(segText, opts = {}) {
  return await engine.suggestEvidence({ query: segText, ...opts });
}

module.exports = {
  suggestEvidence,
  suggestEvidenceForSegment
};
