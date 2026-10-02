'use strict';

const { buildDetectInputDocument } = require('./detectInputDocument');
const { scoreContract } = require('./detectScoreContract');
const { assessCauseCoverage } = require('./detectSignalPolicy');

// Review routing only, NEVER a score floor/boost. The second configured judge
// independently re-reads the same input and may return a LOWER score. Sparse,
// unlocated and genre-only observations cannot trigger it. Short prose needs
// two distinct located content patterns, not a low score or length alone.
const CONTENT_PATTERNS = new Set([
  'generic_abstraction', 'formulaic_transition', 'lexical_template',
  'sentence_uniformity', 'overstructured_progression'
]);

function needsEvidenceReview(out, source) {
  const score = Number(out?.probability);
  if (!Number.isFinite(score) || score < 0 || score >= 50) return false;
  const eligible = buildDetectInputDocument(source).sentences.filter(s => s.eligibleForDetection);
  const units = new Set(eligible.map(s => s.sampleUnitIndex));
  if (units.size < 2) return false;
  const ranks = new Map([...units].map((unit, rank) => [unit, rank]));
  const spans = new Map(eligible.map(s => [`${s.start}:${s.end}`, s]));
  if (units.size < 8) {
    const categories = new Set();
    const jointlyCovered = new Set();
    for (const signal of out?.signalEvidence || []) {
      if (!CONTENT_PATTERNS.has(signal.category) || !['moderate', 'strong'].includes(signal.strength)
          || !['recurring', 'pervasive'].includes(signal.scope)
          || signal.locationStatus !== 'source_range_verified') continue;
      const covered = new Set((signal.locations || []).map(p => spans.get(`${p.start}:${p.end}`)?.sampleUnitIndex)
        .filter(unit => unit != null));
      // A three-sentence input cannot require EVERY distinct pattern in all
      // three sentences: one valid pair plus a document-wide second pattern
      // used to switch confirmation on/off according to the chosen examples.
      // Each pattern must recur; together they must cover the same substantial
      // input fraction. This changes routing, not the score or its floor.
      if (covered.size >= 2) {
        categories.add(signal.category);
        for (const unit of covered) jointlyCovered.add(unit);
      }
    }
    return categories.size >= 2 && jointlyCovered.size >= Math.max(2, Math.ceil(units.size * 0.8));
  }
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

// Resolve short-sample category-count instability with the existing bounded
// second opinion, not a score uplift. Pure endings/transition/genre structure
// cannot enter here. A high second score still needs independent fresh causes.
function needsShortConsistencyReview(out, source) {
  if (!Number.isFinite(out?.probability) || out.probability < 21 || out.probability >= 50) return false;
  const sentences = buildDetectInputDocument(source).sentences.filter(s => s.eligibleForDetection);
  const units = new Set(sentences.map(s => s.sampleUnitIndex));
  if (units.size < 2 || units.size >= 8) return false;
  const spans = new Map(sentences.map(s => [`${s.start}:${s.end}`, s.sampleUnitIndex]));
  return (out.signalEvidence || []).some(s => {
    if (!['generic_abstraction','lexical_template','sentence_uniformity'].includes(s.category)
        || !['moderate','strong'].includes(s.strength) || !['recurring','pervasive'].includes(s.scope)
        || s.locationStatus !== 'source_range_verified') return false;
    const covered = new Set((s.locations || []).map(p => spans.get(`${p.start}:${p.end}`)).filter(p => p != null));
    return covered.size >= Math.max(2, Math.ceil(units.size * 0.8));
  });
}
function selectShortConsistencyResult(primary, reviewed, source) {
  // No synthetic ceiling/floor. Keep score and causal evidence from ONE judge.
  if (candidateConsistency(reviewed, source).status !== 'consistent') return primary;
  if (reviewed.probability >= 50 && !needsEvidenceReview({ ...reviewed, probability: 49 }, source))
    return primary;
  return reviewed;
}

function candidateConsistency(candidate, source) {
  if (!scoreContract(candidate?.probability).valid) return { status: 'invalid', reason: 'score_contract' };
  const evidence = candidate.signalEvidence || [];
  const spans = new Set(buildDetectInputDocument(source).sentences.filter(s => s.eligibleForDetection)
    .map(s => `${s.start}:${s.end}`));
  if (evidence.some(s => s.locationStatus === 'source_range_verified'
      && (!s.locations?.length || s.locations.some(p => !spans.has(`${p.start}:${p.end}`)))))
    return { status: 'conflict', reason: 'evidence_location_mismatch' };
  // The current rubric defines 0–20 as weak/isolated observations. This does
  // not synthesize a floor; a fresh judge may remove/reinterpret the signals.
  if (candidate.probability <= 20 && evidence.some(s => CONTENT_PATTERNS.has(s.category)
      && ['moderate', 'strong'].includes(s.strength) && ['recurring', 'pervasive'].includes(s.scope)
      && s.locationStatus === 'source_range_verified' && s.locations?.length >= 2))
    return { status: 'conflict', reason: 'low_score_recurring_evidence' };
  const coverage = assessCauseCoverage(candidate.probability, evidence, { source: 'llm' });
  if (coverage.status === 'partial') return { status: 'conflict', reason: 'unsupported_high_score' };
  return { status: 'consistent', reason: 'consistent' };
}

function selectReviewedCandidate(primary, reviewed, source, { shortConsistency = false } = {}) {
  const review = candidateConsistency(reviewed, source);
  if (review.status !== 'consistent') return { result: primary, reason: review.reason };
  if (shortConsistency && selectShortConsistencyResult(primary, reviewed, source) !== reviewed)
    return { result: primary, reason: 'short_review_support_insufficient' };
  return { result: reviewed, reason: 'review_consistent' };
}
module.exports = { needsEvidenceReview, needsShortConsistencyReview, selectShortConsistencyResult,
  candidateConsistency, selectReviewedCandidate };
