'use strict';

const { buildDetectInputDocument } = require('./detectInputDocument');

// Review routing only, NEVER a score floor/boost. The second configured judge
// independently re-reads the same input and may return a LOWER score. Sparse,
// unlocated, genre-only and short-sample observations cannot trigger it.
const CONTENT_PATTERNS = new Set([
  'generic_abstraction', 'formulaic_transition', 'lexical_template',
  'sentence_uniformity', 'overstructured_progression'
]);

function needsEvidenceReview(out, source) {
  const score = Number(out?.probability);
  if (!Number.isFinite(score) || score < 0 || score >= 50) return false;
  const eligible = buildDetectInputDocument(source).sentences.filter(s => s.eligibleForDetection);
  const units = new Set(eligible.map(s => s.sampleUnitIndex));
  if (units.size < 8) return false;
  const ranks = new Map([...units].map((unit, rank) => [unit, rank]));
  const spans = new Map(eligible.map(s => [`${s.start}:${s.end}`, s]));
  return (out?.signalEvidence || []).some(signal => {
    if (!CONTENT_PATTERNS.has(signal.category)
        || !['moderate', 'strong'].includes(signal.strength)
        || !['recurring', 'pervasive'].includes(signal.scope)
        || signal.locationStatus !== 'source_range_verified') return false;
    const covered = new Set((signal.locations || []).map(p => spans.get(`${p.start}:${p.end}`)?.sampleUnitIndex)
      .filter(unit => unit != null));
    if (covered.size < 6) return false;
    // This resolves a score/evidence tension, not a low-score population.
    if (covered.size / units.size >= 0.6) return true;
    // Grounding intentionally caps examples at eight. Never divide that sample
    // by a long document and call it complete coverage. A strong, explicitly
    // pervasive observation with examples spread across the document can still
    // merit an independent review; sparse/recurring examples alone cannot.
    if (units.size <= 13 || signal.scope !== 'pervasive' || signal.strength !== 'strong') return false;
    const positions = [...covered].map(unit => ranks.get(unit));
    const quarters = new Set(positions.map(rank => Math.min(3, Math.floor(rank * 4 / units.size))));
    return quarters.size >= 3 && Math.max(...positions) - Math.min(...positions) >= (units.size - 1) * 0.75;
  });
}

module.exports = { needsEvidenceReview };
