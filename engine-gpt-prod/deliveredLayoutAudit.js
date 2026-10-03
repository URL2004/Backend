'use strict';
const { createHash } = require('node:crypto');
const layout = require('./layoutStructure');
const structure = require('./structureChunk');
const digest = text => createHash('sha256').update(String(text || '')).digest('hex');

// Observation only. Never mutate the delivered text or reuse an earlier
// candidate's successful readability/failed layout verdict after a rollback.
function refreshDeliveredLayoutAudit({ layoutRepair = {}, ...options }) {
  const text = String(options.outputText || '');
  const candidateDigest = digest(text);
  const audit = structure.buildStructureAudit(options);
  const readability = layout.measureParagraphReadability(text, {
    ...options, protectedBlocks: (options.chunks || []).filter(c => c.locked).map(c => c.text)
  });
  const attempts = [layoutRepair.finalFixedPoint, layoutRepair.deliveryIntegrityFixedPoint].filter(Boolean);
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
    explicitParagraphCount: layout.splitExplicitParagraphs(text).length
  };
  return layoutRepair;
}
module.exports = { refreshDeliveredLayoutAudit, digest };
