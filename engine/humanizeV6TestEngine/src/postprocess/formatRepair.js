'use strict';
const { normalizeText } = require('../analysis/textStats');

function repairHeadingSpacing(text) {
  return normalizeText(text)
    .replace(/^(Ⅰ\.?\s*서론)\s+/m, '$1\n')
    .replace(/^(Ⅱ\.?\s*본론)\s+/m, '$1\n')
    .replace(/^(Ⅲ\.?\s*결론)\s+/m, '$1\n')
    .replace(/\n(\d+\.\s+[^\n.。!?]{2,60})\s+(?=[가-힣A-Za-z])/g, '\n$1\n');
}

module.exports = { repairHeadingSpacing };
