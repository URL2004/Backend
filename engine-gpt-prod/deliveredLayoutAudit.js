'use strict';
const { createHash } = require('node:crypto');
const layout = require('./layoutStructure');
const structure = require('./structureChunk');
const digest = text => createHash('sha256').update(String(text || '')).digest('hex');

// Run after candidate selection/rollback, before final semantic validation.
// Reflow only whitespace; independently audit the candidate with the complete
// source/plan contract before accepting it. A failed repair cannot erase a
// real missing heading, quote, table cell or semantic warning.
async function settleDeliveredLayout({ layoutRepair = {}, submittedSource = '', acceptCandidate = null, ...options }) {
  const before = String(options.outputText || '');
  const preserveLines = options.documentProfile?.profile === 'creative'
    || options.documentProfile === 'creative' || (options.chunks || []).some(c => c.lineBoundaryPolicy === 'all');
  const seams = preserveLines ? { text: before, repairCount: 0 }
    : require('./physicalProseLines').restoreSourceWordSeams(submittedSource, before);
  const result = await structure.restoreFinalDocumentLayoutAsync({ ...options, outputText: seams.text });
  const audit = structure.buildStructureAudit({ ...options, outputText: result.text });
  const accepted = result.structuralPass === true && result.contentPreserved === true && audit.pass === true
    && (typeof acceptCandidate !== 'function' || acceptCandidate(result.text));
  const text = accepted ? result.text : before;
  layoutRepair.deliverySettledFixedPoint = {
    candidateDigest: digest(result.text), applied: accepted && text !== before,
    accepted, converged: result.converged === true, structuralPass: result.structuralPass === true && audit.pass === true,
    contentPreserved: result.contentPreserved === true,
    wordSeamRepairCount: accepted ? seams.repairCount : 0,
    midSentenceParagraphRepairCount: accepted ? Number(result.midSentenceParagraphRepairCount || 0) : 0
  };
  if (accepted) {
    const previous = layoutRepair.paragraphs || {}, delivered = result.paragraphs?.paragraphs || {};
    layoutRepair.paragraphs = { ...previous, ...delivered,
      beforeCount: previous.beforeCount ?? delivered.beforeCount,
      policy: delivered.policy === 'none' && previous.afterCount === delivered.afterCount
        ? previous.policy || delivered.policy : delivered.policy };
  }
  return { text, applied: text !== before, accepted };
}

// Observation only. Never mutate the delivered text or reuse an earlier
// candidate's successful readability/failed layout verdict after a rollback.
function refreshDeliveredLayoutAudit({ layoutRepair = {}, ...options }) {
  const text = String(options.outputText || '');
  const candidateDigest = digest(text);
  const audit = structure.buildStructureAudit(options);
  const readability = layout.measureParagraphReadability(text, {
    ...options, protectedBlocks: (options.chunks || []).filter(c => c.locked).map(c => c.text)
  });
  const attempts = [layoutRepair.finalFixedPoint, layoutRepair.deliveryIntegrityFixedPoint,
    layoutRepair.deliverySettledFixedPoint].filter(Boolean);
  const latestAttempt = attempts.filter(a => a.candidateDigest === candidateDigest).at(-1);
  const unsettled = latestAttempt?.converged === false;
  const structuralPass = audit.pass === true && !unsettled;
  const readabilityPass = readability.overlongCount === 0;
  const previous = layoutRepair.paragraphs || {};
  if (!layoutRepair.preDeliverySnapshot) layoutRepair.preDeliverySnapshot = {
    structuralPass: (layoutRepair.structuralPass ?? layoutRepair.pass) !== false,
    readabilityPass: layoutRepair.readabilityPass !== false,
    paragraphCount: Number(previous.afterCount || 0),
    explicitParagraphCount: Number(previous.explicitParagraphCountAfter || 0)
  };
  layoutRepair.paragraphs = { ...previous,
    afterCount: readability.paragraphCount,
    explicitParagraphCountAfter: layout.splitExplicitParagraphs(text).length,
    readability: Object.fromEntries(Object.entries(readability).filter(([key]) => key !== 'details')),
    pass: readabilityPass
  };
  layoutRepair.pass = structuralPass;
  layoutRepair.structuralPass = structuralPass;
  layoutRepair.readabilityPass = readabilityPass;
  layoutRepair.finalDelivered = {
    version: 'delivered-layout-v1', candidateDigest, structuralPass, readabilityPass,
    unsettled, paragraphCount: readability.paragraphCount,
    explicitParagraphCount: layout.splitExplicitParagraphs(text).length,
    maxReadableParagraphChars: readability.maxBare,
    maxExplicitParagraphChars: Math.max(0, ...layout.splitExplicitParagraphs(text).map(p => p.replace(/\s/gu, '').length)),
    overlongReadableParagraphCount: readability.overlongCount
  };
  return layoutRepair;
}
module.exports = { settleDeliveredLayout, refreshDeliveredLayoutAudit, digest };
