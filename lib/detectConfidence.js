'use strict';

const { buildDetectInputDocument } = require('./detectInputDocument');

function insufficientSample(source) {
  return buildDetectInputDocument(source).eligibleSentenceCount < 4;
}

// This is an evidence-sufficiency ceiling, never an authorship score adjustment.
// Apply after model selection so limited input does not itself trigger retries.
// The model may still choose low for protected or corrupted longer input.
function limitConfidenceToSample(result, source) {
  const count = buildDetectInputDocument(source).eligibleSentenceCount;
  const confidence = count < 4 ? 'low'
    : count < 8 && result?.confidence === 'high' ? 'medium'
      : result?.confidence;
  return confidence === result?.confidence ? result : { ...result, confidence };
}

module.exports = { limitConfidenceToSample, insufficientSample };
