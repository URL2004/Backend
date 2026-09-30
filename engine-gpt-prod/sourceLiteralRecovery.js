'use strict';

const citation = require('./citationOwnership');
const quote = require('./quoteOwnership');
const lf = value => String(value || '').replace(/\r\n?/gu, '\n');

// A missing delimiter cannot be located by quote ordinal. A stronger witness
// exists when a source section consists solely of one quotation followed by
// its exact citation: the preserved heading and reference delimit that slot.
// Any source narrative before the quote makes this rule inapplicable.
function restoreAttributedQuoteSlots(source, output, chunks) {
  const citations = citation.restoreCitationLayout(source, output, chunks);
  const text = citations.text;
  if (!citations.pass) return { text: lf(output), restoredCount: 0, refusedCount: 1 };
  const src = quote.parseQuoteOwnership(source), out = quote.parseQuoteOwnership(text);
  if (src.sections.length !== out.sections.length
      || src.sections.some((section, i) => section.key !== out.sections[i].key)) {
    return { text: lf(output), restoredCount: 0, refusedCount: 1 };
  }
  const edits = [];
  let refusedCount = 0;
  const auditBefore = quote.auditQuoteOwnership(source, text);
  const quotes = src.candidates.filter(item => item.owned && item.kind !== 'unresolved');
  for (const item of quotes) {
    const section = src.sections[item.section], targetSection = out.sections[item.section];
    const bodyStart = section.key ? src.text.indexOf('\n', section.start) + 1 : section.start;
    const targetStart = section.key ? out.text.indexOf('\n', targetSection.start) + 1 : targetSection.start;
    if (bodyStart < section.start || item.start < bodyStart || targetStart < targetSection.start
        || src.text.slice(bodyStart, item.start).trim()) continue;
    const ref = citations.atoms.find(atom => atom.srcStart >= item.end
      && atom.srcStart < section.end && !src.text.slice(item.end, atom.srcStart).trim());
    if (!ref || ref.start < targetStart || ref.start >= targetSection.end) continue;
    // Only a section consisting of this quote plus citations is a complete
    // ownership witness. Following narrative may have migrated before the
    // citation in the output; replacing that slot would silently erase it.
    let tailCursor = item.end;
    let narrative = false;
    for (const atom of citations.atoms.filter(atom => atom.srcStart >= item.end && atom.srcStart < section.end)) {
      if (src.text.slice(tailCursor, atom.srcStart).trim()) narrative = true;
      tailCursor = atom.srcEnd;
    }
    if (narrative || src.text.slice(tailCursor, section.end).trim()) continue;
    let outputTail = ref.end;
    for (const atom of citations.atoms.filter(atom => atom.start >= ref.end && atom.start < targetSection.end)) {
      if (text.slice(outputTail, atom.start).trim()) narrative = true;
      outputTail = atom.end;
    }
    if (narrative || text.slice(outputTail, targetSection.end).trim()) continue;
    // An existing source quote anywhere in the section is evidence that it
    // is not missing. In particular never duplicate one moved after its ref.
    if (out.candidates.some(other => other.section === item.section && other.key === item.key)) continue;
    let start = targetStart, end = ref.start;
    while (start < end && /\s/u.test(text[start])) start += 1;
    while (end > start && /\s/u.test(text[end - 1])) end -= 1;
    if (start === end) { refusedCount += 1; continue; }
    const literal = src.text.slice(item.start, item.end);
    const slot = text.slice(start, end);
    const excessCurly = [/[“”]/gu, /[‘’]/gu].some(pattern =>
      (slot.match(pattern) || []).length > (literal.match(pattern) || []).length);
    // Ordinary parenthetical terms already attested inside the quotation
    // are not migrated book titles. Allow them only as the exact same ordered
    // literals, with no unmatched/nested/new parentheses left over.
    const parentheticals = value => (value.match(/\([^()\r\n]*\)/gu) || []).map(item => item.replace(/\s/gu, ''));
    const sourceParens = parentheticals(literal), outputParens = parentheticals(slot);
    const unsafeParens = JSON.stringify(sourceParens) !== JSON.stringify(outputParens)
      || /[()]/u.test(slot.replace(/\([^()\r\n]*\)/gu, ''));
    if (slot.replace(/\s/gu, '').length > literal.replace(/\s/gu, '').length * 1.5
        || /[『「《〈』」》〉【】〔〕"'\x60\[\]{}<>]/u.test(slot)
        || excessCurly || unsafeParens) { refusedCount += 1; continue; }
    // An exact quotation owned elsewhere is evidence of movement, not a
    // paraphrase that can safely be replaced by this section's quotation.
    const occupants = out.candidates.filter(other => other.start < end && other.end > start);
    if (occupants.some(other => other.kind === 'unresolved'
        || (other.key !== item.key && src.candidates.some(original => original.key === other.key)))) {
      refusedCount += 1;
      continue;
    }
    if (text.slice(start, end) !== literal) edits.push({ start, end, text: literal, section: item.section });
  }
  let restored = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    restored = restored.slice(0, edit.start) + edit.text + restored.slice(edit.end);
  }
  const auditAfter = quote.auditQuoteOwnership(source, restored);
  const citationAfter = citation.restoreCitationLayout(source, restored, chunks);
  const parsedAfter = quote.parseQuoteOwnership(restored);
  const sourceKeys = new Set(src.candidates.map(item => item.key));
  const lostExisting = [...sourceKeys].some(key =>
    out.candidates.filter(item => item.key === key).length > parsedAfter.candidates.filter(item => item.key === key).length);
  if (auditAfter.missingCount > auditBefore.missingCount
      || auditAfter.unresolvedCount > auditBefore.unresolvedCount
      || auditAfter.introducedCount > auditBefore.introducedCount
      || auditAfter.introducedMalformedCount > auditBefore.introducedMalformedCount
      || (auditBefore.orderPreserved && !auditAfter.orderPreserved)
      || lostExisting || !citationAfter.pass || citationAfter.text !== restored) {
    return { text: lf(output), restoredCount: 0, refusedCount: refusedCount + edits.length };
  }
  return { text: restored, restoredCount: edits.length, refusedCount,
    edits: edits.map(edit => ({ section: edit.section,
      slotChars: text.slice(edit.start, edit.end).replace(/\s/gu, '').length,
      literalChars: edit.text.replace(/\s/gu, '').length,
      removedChars: Math.max(0, text.slice(edit.start, edit.end).replace(/\s/gu, '').length - edit.text.replace(/\s/gu, '').length),
      addedChars: Math.max(0, edit.text.replace(/\s/gu, '').length - text.slice(edit.start, edit.end).replace(/\s/gu, '').length) })) };
}

// Content restoration happens BEFORE whitespace-only layout and final
// semantic validation. This function never invents a citation or converts
// direct quotations into indirect quotations.
function recoverSourceLiterals(source, output, chunks) {
  const before = lf(output);
  const structure = require('./structureChunk');
  // Already-correct heading boundaries may carry readability blank lines.
  // Do not reset them to the source's spacing on every delivery pass.
  const headings = structure.compareLineAnchorLayout(source, before, { allowAdditions: true }).pass
    ? { text: before } : structure.restoreLockedHeadingLayout(source, before, chunks);
  const citations = citation.restoreCitationContents(source, headings.text, chunks);
  const slots = restoreAttributedQuoteSlots(source, citations.text, chunks);
  const quotes = require('./voiceProfile').restoreDirectQuoteContents(source, slots.text);
  const layout = quote.restoreOwnedQuoteLayout(source, quotes.text);
  const finalCitations = citation.restoreCitationLayout(source, layout.text, chunks);
  return { text: layout.text, applied: layout.text !== before,
    citationRestoredCount: citations.restoredCount,
    quoteRestoredCount: slots.restoredCount + quotes.restoredCount,
    refusedCount: slots.refusedCount + citations.refusedCount,
    quoteSlotEdits: slots.edits || [],
    citationPass: finalCitations.pass && finalCitations.text === layout.text,
    quotePass: quote.auditQuoteOwnership(source, layout.text).pass
      && require('./voiceProfile').auditDirectQuoteIntegrity(source, layout.text).pass };
}

module.exports = { recoverSourceLiterals, restoreAttributedQuoteSlots };
