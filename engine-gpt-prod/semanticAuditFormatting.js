'use strict';

// Settle the existing spelling/visual-gap formatter BEFORE a semantic judge
// sees the candidate. This grants no verdict: the resulting bytes must be
// judged, bound and (when frozen) reversibly mapped like any other candidate.
const korean = require('./koreanRefinement');
const structure = require('./structureChunk');
const literals = require('./literalSpans');
const { preparationRelationDigest } = require('./layoutRelations');
const content = text => String(text).replace(/\s/gu, '');
const literalValues = text => JSON.stringify([
  literals.freezeInlineCode(text).blocks.map(block => block.value),
  literals.freezeMath(text).blocks.map(block => block.value),
  [...String(text).matchAll(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/gu)].map(match => match[0])
]);

async function prepareSemanticAuditText(source, candidate, options = {}) {
  const before = String(candidate ?? '');
  if (!before.trim() || /ZXQ(?:LOCK|MATH|CODE)\d+QXZ/u.test(before)) return before;
  const chunks = structure.splitChunksForGpt(source).chunks;
  let metrics = null;
  const once = async value => {
    const formatted = korean.applySafeFormattingRepairs({
      source, outputText: value, documentProfile: options.documentProfile
    });
    const layout = await structure.restoreFinalDocumentLayoutAsync({
      source, outputText: formatted.text, chunks, signal: options.signal,
      mode: options.mode, requestStrength: options.requestStrength,
      documentProfile: options.documentProfile, humanizeContract: options.humanizeContract,
      normalizeVisualGaps: options.mode !== 'polish'
        && options.documentProfile?.profile !== 'creative'
    });
    const text = layout.applied && layout.contentPreserved ? layout.text : formatted.text;
    if (!metrics) metrics = {
      formattingChangeCount: Number(formatted.changeCount || 0),
      contextualSpacingCount: Number(formatted.contextualSpacingRepairCount || 0),
      paragraphRoleBoundaryCount: layout.applied && layout.contentPreserved
        ? Number(layout.paragraphs?.paragraphs?.roleBoundaryCount || 0) : 0
    };
    // Section separators belong to the enclosing aligned document. Keep them
    // byte-for-byte rather than altering the next section's ownership edge.
    return (value.match(/^\s*/u)?.[0] || '') + String(text).trim()
      + (value.match(/\s*$/u)?.[0] || '');
  };
  const first = await once(before);
  if (content(first) !== content(before)
      || literalValues(first) !== literalValues(before)
      || preparationRelationDigest(first) !== preparationRelationDigest(before)) return before;
  // A context-dependent or oscillating formatter cannot establish the final
  // form. Keep the prior candidate and let the existing final audit handle it.
  const second = await once(first);
  if (second !== first) return before;
  if (first !== before && typeof options.onApplied === 'function') options.onApplied(metrics);
  return first;
}

module.exports = { prepareSemanticAuditText };
