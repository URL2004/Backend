'use strict';

const preflight = require('./sourcePreflight');

function incomplete(text) {
  return !text || /[,:;，、]$/u.test(text)
    || /(?:그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/u.test(text)
    || preflight.isPossiblyIncompleteSentence(text);
}

// Only the identical final source fragment owns an unfinished ending. Two
// unrelated incomplete sentences are not evidence of preservation. Use the
// entire tail after the last explicit sentence/paragraph boundary, not a short
// suffix such as "그리고", so a newly shortened sentence remains a failure.
function finalFragment(text) {
  return text.split(/(?:[.!?。！？][”’"']?(?:\s+|$)|\r?\n\s*\r?\n)/u).at(-1)
    .replace(/\s+/gu, ' ').trim();
}

function looksGeneratedTruncated(source, outputText) {
  const before = String(source || '').trim(), after = String(outputText || '').trim();
  if (!after) return true;
  if (!incomplete(after)) return false;
  if (!incomplete(before)) return true;
  const tail = finalFragment(before);
  return !tail || tail !== finalFragment(after);
}

module.exports = { looksGeneratedTruncated };
