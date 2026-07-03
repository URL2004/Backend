'use strict';
const { normalizeText } = require('../analysis/textStats');

function minimalCleanup(text) {
  return normalizeText(text)
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\s+([,.;:!?。！？])/g, '$1')
    .replace(/([가-힣A-Za-z0-9])\s+([,.;:!?。！？])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { minimalCleanup };
