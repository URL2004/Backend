'use strict';

const { splitSentences } = require('../engine/koreanText');

// These measures describe rhythm, not factual fidelity. They may be retained
// as review warnings after a localized factual repair passes a fresh judge.
// Every other repair/integrity rejection remains a hard boundary.
const RHYTHM_REASONS = new Set(['sentence_shape_worsened', 'sentence_distribution_worsened']);
const FACTUAL_VIOLATIONS = new Set(['distortion', 'added_claim', 'experience_novelty']);

function assessSemanticRepairPriority(beforeText, candidateText, violations, safety) {
  const reasons = Array.isArray(safety?.reasons) ? safety.reasons : [];
  if (!reasons.length || reasons.some(code => !RHYTHM_REASONS.has(code))) {
    return { eligible: false, reason: 'hard_boundary_or_no_rhythm_conflict' };
  }
  const before = String(beforeText || '');
  const candidate = String(candidateText || '');
  const targets = [];
  for (const item of violations || []) {
    if (!FACTUAL_VIOLATIONS.has(item?.type)) continue;
    const span = String(item?.span || '').trim();
    const start = span.length >= 8 ? before.indexOf(span) : -1;
    // A vague or repeated quotation does not authorize editing an arbitrary
    // sentence. The actual current text, rather than the model flag, binds it.
    if (start < 0 || before.indexOf(span, start + 1) >= 0) continue;
    targets.push({ start, end: start + span.length });
  }
  if (!targets.length) return { eligible: false, reason: 'no_grounded_factual_target' };

  let cursor = 0;
  const sentences = [];
  for (const value of splitSentences(before)) {
    const sentence = String(value || '').trim();
    const start = before.indexOf(sentence, cursor);
    if (!sentence || start < 0) return { eligible: false, reason: 'unresolved_sentence_boundary' };
    const end = start + sentence.length;
    sentences.push({ start, end, targeted: targets.some(item => item.start < end && item.end > start) });
    cursor = end;
  }
  const targeted = sentences.filter(item => item.targeted);
  if (!targeted.length || targeted.length > Math.floor(sentences.length / 2)) {
    return { eligible: false, reason: 'repair_scope_too_broad' };
  }
  // Exact immutable anchors enforce the existing instruction to edit only
  // listed sentences, while allowing a targeted sentence to split or merge.
  const ranges = [];
  for (const sentence of sentences) {
    if (!sentence.targeted) continue;
    const previous = ranges.at(-1);
    if (previous && !before.slice(previous.end, sentence.start).trim()) previous.end = sentence.end;
    else ranges.push({ start: sentence.start, end: sentence.end });
  }
  const prefix = before.slice(0, ranges[0].start);
  const suffix = before.slice(ranges.at(-1).end);
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) {
    return { eligible: false, reason: 'unrelated_text_changed' };
  }
  let candidateCursor = prefix.length;
  const suffixStart = candidate.length - suffix.length;
  for (let index = 1; index < ranges.length; index++) {
    const anchor = before.slice(ranges[index - 1].end, ranges[index].start);
    const position = candidate.indexOf(anchor, candidateCursor + 1);
    if (position < 0 || position + anchor.length > suffixStart) {
      return { eligible: false, reason: 'unrelated_text_changed' };
    }
    candidateCursor = position + anchor.length;
  }
  if (candidateCursor >= suffixStart) return { eligible: false, reason: 'empty_repaired_target' };
  return { eligible: true, reason: 'localized_factual_repair', warnings: [...new Set(reasons)], targetCount: targeted.length };
}

module.exports = { assessSemanticRepairPriority };
