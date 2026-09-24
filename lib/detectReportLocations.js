'use strict';

// Model IDs address canonical syntax spans; UI IDs address display sentences.
// Never equate those namespaces (headings, quotations and soft wraps differ).
// Map only in source order, permitting whitespace differences introduced by the
// report splitter. Non-whitespace mismatches fail closed, not fuzzy-match.
function reportSourceOffsets(source, paragraphs) {
  source = String(source || '');
  let cursor = 0;
  const maps = [];
  for (const paragraph of paragraphs) {
    const text = String(paragraph || '');
    const offsets = [];
    for (let i = 0; i < text.length; i++) {
      if (/\s/u.test(text[i])) {
        offsets[i] = cursor;
        while (cursor < source.length && /\s/u.test(source[cursor])) cursor++;
      } else {
        while (cursor < source.length && /\s/u.test(source[cursor])) cursor++;
        if (source[cursor] !== text[i]) return null;
        offsets[i] = cursor++;
      }
    }
    offsets[text.length] = cursor;
    maps.push(offsets);
  }
  if (source.slice(cursor).trim()) return null;
  return maps;
}

function projectReportEvidence(evidence, sentenceMap) {
  const marks = sentenceMap?.sourceLocations || [];
  return (Array.isArray(evidence) ? evidence : []).map(item => {
    const locations = [];
    const seen = new Set();
    if (item?.locationStatus === 'source_range_verified') {
      for (const loc of item.locations || []) {
        if (![loc?.start, loc?.end].every(Number.isSafeInteger) || loc.end <= loc.start) continue;
        for (const mark of marks) {
          const start = Math.max(mark.start, loc.start), end = Math.min(mark.end, loc.end);
          if (start >= end) continue;
          const key = `${mark.index}:${start}:${end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push({ sentenceIndex: mark.index, start, end,
            paragraphIndex: mark.paragraph, paragraphEndIndex: mark.paragraph });
        }
      }
    }
    return { ...item, locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated' };
  });
}

module.exports = { reportSourceOffsets, projectReportEvidence };
