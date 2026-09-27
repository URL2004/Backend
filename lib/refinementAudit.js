'use strict';
const { createHash, createHmac } = require('node:crypto');
const VERSION = 'refined-paragraph-audit-v1';
const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(value) ? value : null;
function createRefinementAudit({ parent, output, source, candidate, memo, paragraphIndex, parentEngineVersion,
  generationModel, validation }, key = require('./historyLinkIntegrity').secret()) {
  if (validation?.pass !== true || validation.preservesMeaning !== true || validation.integratesMemo !== true) return null;
  return sanitizeRefinementAudit({ version: VERSION, scope: 'refined_paragraph',
    parentHash: hash(parent), outputHash: hash(output), sourceParagraphHash: hash(source), candidateHash: hash(candidate),
    paragraphIndex, parentEngineVersion: safeId(parentEngineVersion), generationModel: safeId(generationModel),
    judgeModel: safeId(validation.model), policyVersion: safeId(validation.version),
    memoLength: String(memo || '').length,
    memoReference: String(key).length >= 32
      ? createHmac('sha256', key).update(`refinement-memo-v1\u0000${hash(parent)}\u0000${paragraphIndex}\u0000${memo}`).digest('hex') : null,
    preservesMeaning: true, integratesMemo: true, deterministicChecksPassed: true,
    wholeDocumentVerified: false });
}
function sanitizeRefinementAudit(value) {
  if (!value || value.version !== VERSION || value.scope !== 'refined_paragraph'
      || !['parentHash','outputHash','sourceParagraphHash','candidateHash'].every(k=>/^[a-f0-9]{64}$/u.test(value[k] || ''))
      || !Number.isSafeInteger(value.paragraphIndex) || value.paragraphIndex < 0
      || !Number.isSafeInteger(value.memoLength) || value.memoLength < 5 || value.memoLength > 500
      || value.preservesMeaning !== true || value.integratesMemo !== true
      || value.deterministicChecksPassed !== true || value.wholeDocumentVerified !== false) return null;
  return { version: VERSION, scope: 'refined_paragraph', parentHash: value.parentHash, outputHash: value.outputHash,
    sourceParagraphHash: value.sourceParagraphHash, candidateHash: value.candidateHash, paragraphIndex: value.paragraphIndex,
    parentEngineVersion: safeId(value.parentEngineVersion), generationModel: safeId(value.generationModel),
    judgeModel: safeId(value.judgeModel), policyVersion: safeId(value.policyVersion), memoLength: value.memoLength,
    memoReference: /^[a-f0-9]{64}$/u.test(value.memoReference || '') ? value.memoReference : null,
    preservesMeaning: true, integratesMemo: true, deterministicChecksPassed: true, wholeDocumentVerified: false };
}
module.exports = { createRefinementAudit, sanitizeRefinementAudit };
