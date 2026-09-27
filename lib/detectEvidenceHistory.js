'use strict';
const { createHash } = require('node:crypto');
const { normalizeSignalEvidence } = require('./detectSignalPolicy');
const { buildDetectInputDocument } = require('./detectInputDocument');

// Store only source-verified canonical locations, never model descriptions,
// source quotations or UI sentence IDs. Report projection can split one
// canonical sentence; history always resolves back to the original namespace.
function historyEvidence(value, source) {
  const text = String(source || ''), document = buildDetectInputDocument(text);
  const evidence = normalizeSignalEvidence(value).filter(e => e.format === 'structured').map(item => {
    const locations = [], seen = new Set();
    if (item.locationStatus === 'source_range_verified') for (const loc of item.locations || []) {
      const id = loc?.canonicalSentenceIndex ?? loc?.sentenceIndex;
      const sentence = Number.isSafeInteger(id) ? document.sentences[id] : null;
      if (!sentence?.eligibleForDetection || ![loc?.start, loc?.end].every(Number.isSafeInteger)
          || loc.start < sentence.start || loc.end > sentence.end || loc.end <= loc.start || seen.has(id)) continue;
      // Non-projected locations must be exact, not an arbitrary in-range slice.
      if (loc.canonicalSentenceIndex == null && (loc.start !== sentence.start || loc.end !== sentence.end)) continue;
      seen.add(id);
      locations.push({ sentenceIndex: id, start: sentence.start, end: sentence.end,
        sampleUnitIndex: sentence.sampleUnitIndex, paragraphIndex: sentence.paragraphIndex,
        paragraphEndIndex: sentence.paragraphEndIndex });
      if (locations.length >= 16) break;
    }
    return { category: item.category, strength: item.strength, scope: item.scope,
      locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated' };
  });
  return { evidence, provenance: { version: 'detect-evidence-history-v1',
    inputVersion: document.version, inputHash: createHash('sha256').update(text).digest('hex'),
    coordinateSpace: 'canonical_source_utf16', locationCount: evidence.reduce((n,e)=>n+e.locations.length,0) } };
}
module.exports = { historyEvidence };
