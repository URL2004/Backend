'use strict';

// A whole-document semantic repair is validated as one candidate. When that
// candidate fails, every local repair in it used to be discarded together, so
// a single unsafe block could keep confirmed errors elsewhere in delivery.
// Adopt repaired paragraphs one at a time instead, each through the caller's
// full candidate validation against the text accumulated so far, then require
// the combined result to pass the same validation against the original input.
// Paragraph boundaries must be unchanged; nothing here writes new wording and
// the result is never reported as semantically verified.
const PARAGRAPH_BREAK = /(\n[ \t]*\n+)/u;
const MAX_ADOPTED_BLOCKS = 12;

function splitParagraphBlocks(value) {
  const parts = String(value || '').split(PARAGRAPH_BREAK);
  return {
    blocks: parts.filter((_, index) => index % 2 === 0),
    breaks: parts.filter((_, index) => index % 2 === 1)
  };
}

function joinParagraphBlocks(blocks, breaks) {
  return blocks.reduce((text, block, index) => text + (index > 0 ? breaks[index - 1] : '') + block, '');
}

function adoptValidatedRepairBlocks({ current, repaired, validate, maxBlocks = MAX_ADOPTED_BLOCKS } = {}) {
  const unchanged = { applied: false, text: String(current || ''), adoptedCount: 0, rejectedCount: 0, reason: '' };
  if (typeof validate !== 'function') return { ...unchanged, reason: 'no_validator' };
  const before = splitParagraphBlocks(current);
  const after = splitParagraphBlocks(repaired);
  if (before.blocks.length < 2 || before.blocks.length !== after.blocks.length
      || before.breaks.some((value, index) => value.replace(/[ \t]/gu, '') !== after.breaks[index].replace(/[ \t]/gu, ''))) {
    return { ...unchanged, reason: 'paragraph_boundaries_changed' };
  }
  const changed = before.blocks.map((block, index) => (block !== after.blocks[index] ? index : -1))
    .filter(index => index >= 0);
  // A single changed block is exactly the rejected whole candidate.
  if (changed.length < 2) return { ...unchanged, reason: 'single_block_repair' };
  if (changed.length > maxBlocks) return { ...unchanged, reason: 'too_many_blocks' };
  const blocks = [...before.blocks];
  let text = joinParagraphBlocks(blocks, before.breaks);
  const adopted = [];
  const rejected = [];
  for (const index of changed) {
    const trialBlocks = [...blocks];
    trialBlocks[index] = after.blocks[index];
    const trial = joinParagraphBlocks(trialBlocks, before.breaks);
    const validation = validate(text, trial);
    const accepted = validation?.pass === true ? String(validation.candidate || trial) : '';
    // The validator may normalize locked layout. Keep that only when the
    // other paragraphs are untouched, otherwise ownership becomes ambiguous.
    const acceptedBlocks = accepted ? splitParagraphBlocks(accepted) : null;
    if (!acceptedBlocks || acceptedBlocks.blocks.length !== blocks.length
        || acceptedBlocks.blocks.some((block, position) => position !== index && block !== blocks[position])) {
      rejected.push({ index, codes: (validation?.codes || []).slice(0, 8) });
      continue;
    }
    blocks[index] = acceptedBlocks.blocks[index];
    text = joinParagraphBlocks(blocks, before.breaks);
    adopted.push(index);
  }
  if (!adopted.length) return { ...unchanged, rejectedCount: rejected.length, rejected, reason: 'no_block_passed' };
  // Chained relative checks are not transitive; the combination must pass the
  // same validation against the original input, and it must differ from the
  // rejected whole candidate.
  if (!rejected.length) return { ...unchanged, rejectedCount: 0, reason: 'equals_rejected_candidate' };
  const combined = validate(String(current || ''), text);
  if (combined?.pass !== true) {
    return { ...unchanged, rejectedCount: rejected.length, rejected, reason: 'combined_candidate_rejected' };
  }
  return {
    applied: true,
    text: String(combined.candidate || text),
    adoptedCount: adopted.length,
    adoptedBlocks: adopted,
    rejectedCount: rejected.length,
    rejected,
    reason: 'partial_blocks_adopted'
  };
}

module.exports = { adoptValidatedRepairBlocks, splitParagraphBlocks, joinParagraphBlocks };
