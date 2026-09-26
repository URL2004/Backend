'use strict';

// Locate quoted evidence without erasing word boundaries. A model may render a
// paragraph break as a space; that is not permission to guess missing words,
// change punctuation, merge tokens, or select one of several identical spans.
function locateEvidenceSpan(text, value, minLength = 4) {
  const raw = String(text || ''), quote = String(value || '').trim();
  if (quote.length < minLength) return null;
  const exact = raw.indexOf(quote);
  if (exact >= 0) return raw.indexOf(quote, exact + 1) < 0 ? { start: exact, end: exact + quote.length } : null;
  const normalizedQuote = quote.replace(/\s+/gu, ' ');
  let normalized = '';
  const starts = [], ends = [];
  for (const match of raw.matchAll(/\s+|\S+/gu)) {
    if (/^\s/u.test(match[0])) {
      normalized += ' '; starts.push(match.index); ends.push(match.index + match[0].length);
    } else {
      normalized += match[0];
      for (let i = 0; i < match[0].length; i++) { starts.push(match.index + i); ends.push(match.index + i + 1); }
    }
  }
  const at = normalized.indexOf(normalizedQuote);
  if (at < 0 || normalized.indexOf(normalizedQuote, at + 1) >= 0) return null;
  return { start: starts[at], end: ends[at + normalizedQuote.length - 1] };
}

module.exports = { locateEvidenceSpan };
