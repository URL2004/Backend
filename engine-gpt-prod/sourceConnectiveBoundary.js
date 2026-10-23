'use strict';
// Only restore a punctuation boundary explicitly attested in the source.
// A connective followed by a citation is not a complete declarative sentence.
// No sentence is generated and literal quotations/code are never rewritten.
function restoreSourceConnectiveBoundary(source, candidate) {
  const text = String(candidate || ''), original = String(source || '').replace(/\s/gu, '');
  const syntax = require('../engine/textSyntax').syntaxSpans(text).filter(s => s.spanType !== 'parenthetical');
  const changes = [];
  for (const m of text.matchAll(/([가-힣]{2,20}(?:하며|이며|으며|하고|이고))([ \t]*\([^()\n]{1,40}\))\.([ \t]+)([가-힣]{2,20})/gu)) {
    const key = (m[1] + m[2] + ',' + m[4]).replace(/\s/gu, '');
    const at = original.indexOf(key), dot = m.index + m[1].length + m[2].length;
    if (at < 0 || at !== original.lastIndexOf(key) || text.indexOf(m[0]) !== text.lastIndexOf(m[0])
        || syntax.some(s => s.start < dot + 1 && s.end > m.index)) continue;
    changes.push(dot);
  }
  let result = text;
  for (const at of changes.reverse()) result = result.slice(0, at) + ',' + result.slice(at + 1);
  return { text: result, repairedCount: changes.length, applied: result !== text };
}
module.exports = { restoreSourceConnectiveBoundary };
