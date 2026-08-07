'use strict';

// Offline evaluation helper. This must not be imported by the production graph.
const { compareNumberMultiset } = require('../../engine-gpt-prod/factAudit');
const { buildVoiceProfile, auditVoice } = require('../../engine-gpt-prod/voiceProfile');
const humanizationDepth = require('../../engine-gpt-prod/humanizationDepth');
const structureChunk = require('../../engine-gpt-prod/structureChunk');
const { buildHumanizationDepthPair } = require('../../engine-gpt-prod');

const VERSION = 2;
const INVARIANT_VOICE_CODES = new Set([
  'speaker_injected',
  'speaker_removed',
  'quote_count_changed',
  'quote_content_changed',
  'list_structure_changed',
  'heading_structure_changed',
  'questionnaire_structure_changed',
  'title_line_merged',
  'structural_line_loss',
  'creative_line_structure',
  'line_structure_changed'
]);

function auditRepeatability({
  source,
  outputs,
  documentProfile = 'unknown',
  mode = 'assignment',
  requestStrength = '',
  maxEditRatioSpread = 0.08,
  maxCarryoverRatioSpread = 0.18,
  maxStructuralRatioSpread = 0.22
} = {}) {
  const sourceText = String(source || '');
  const candidates = Array.isArray(outputs) ? outputs.map(value => String(value || '')) : [];
  const sourceProfile = buildVoiceProfile(sourceText, { documentProfile, mode });
  const strength = requestStrength || (mode === 'blog' ? 'basic' : (mode === 'polish' ? 'polish' : 'advanced'));
  const chunkPlan = structureChunk.splitChunksForGpt(sourceText, { coalesceEditable: true });
  const canonicalPair = buildHumanizationDepthPair({
    source: sourceText,
    outputText: sourceText,
    chunks: chunkPlan.chunks
  });
  const depthPlan = humanizationDepth.buildHumanizationPlan(canonicalPair.source, {
    requestStrength: strength,
    documentProfile
  });
  const runs = candidates.map((output, index) => auditRun({
    index,
    source: sourceText,
    sourceProfile,
    output,
    documentProfile,
    mode,
    depthPlan,
    chunks: chunkPlan.chunks
  }));
  const variance = summarizeVariance(sourceText, runs, {
    maxEditRatioSpread,
    maxCarryoverRatioSpread,
    maxStructuralRatioSpread
  });
  const failureCodes = [...new Set([
    ...runs.flatMap(run => run.issueCodes),
    ...variance.failureCodes
  ])];
  return {
    version: VERSION,
    runCount: runs.length,
    passedRunCount: runs.filter(run => run.pass).length,
    failedRunCount: runs.filter(run => !run.pass).length,
    pass: runs.length > 0 && runs.every(run => run.pass) && variance.pass,
    failureCodes,
    variance,
    runs
  };
}

function auditRun({ index, source, sourceProfile, output, documentProfile, mode, depthPlan, chunks }) {
  if (!output.trim()) {
    return {
      runOrdinal: index + 1,
      pass: false,
      issueCodes: ['empty_output'],
      numberChanged: false,
      quoteCountChanged: false,
      quoteContentChanged: false
    };
  }
  const numberAudit = compareNumberMultiset(source, output);
  const voiceAudit = auditVoice(sourceProfile, output, { documentProfile, mode, sourceText: source });
  const depthPair = buildHumanizationDepthPair({ source, outputText: output, chunks });
  const depth = humanizationDepth.evaluateHumanizationDepth(depthPair.source, depthPair.output, depthPlan);
  const issueCodes = [
    ...(numberAudit.changed ? ['number_multiset_changed'] : []),
    ...(voiceAudit.warnings || [])
      .map(item => String(item?.code || ''))
      .filter(code => INVARIANT_VOICE_CODES.has(code))
  ];
  const uniqueIssueCodes = [...new Set(issueCodes)];
  return {
    runOrdinal: index + 1,
    pass: uniqueIssueCodes.length === 0,
    issueCodes: uniqueIssueCodes,
    numberChanged: numberAudit.changed === true,
    numberRemovedCount: Number(numberAudit.removedCount || 0),
    numberAddedCount: Number(numberAudit.addedCount || 0),
    quoteCountChanged: voiceAudit.directQuoteIntegrity?.countChanged === true,
    quoteContentChanged: voiceAudit.directQuoteIntegrity?.contentChanged === true,
    substantiveEditRatio: Number(depth.metrics?.substantiveEditRatio || 0),
    substantiveCarryoverRatio: Number(depth.metrics?.substantiveCarryoverRatio || 0),
    structuralChangedSentenceRatio: Number(depth.metrics?.structuralChangedSentenceRatio || 0),
    minimumEffectPass: depth.minimumEffectPass === true,
    humanizationDenominatorVersion: depthPair.denominatorVersion,
    depthAuditSourceHash: depthPair.sourceHash
  };
}

function summarizeVariance(source, runs, limits) {
  const valid = (runs || []).filter(run => Number.isFinite(run.substantiveEditRatio));
  const applicable = String(source || '').replace(/\s+/gu, '').length >= 80
    && splitSentenceCount(source) >= 4
    && valid.length >= 2;
  const editRatioSpread = spread(valid.map(run => run.substantiveEditRatio));
  const carryoverRatioSpread = spread(valid.map(run => run.substantiveCarryoverRatio));
  const structuralRatioSpread = spread(valid.map(run => run.structuralChangedSentenceRatio));
  const failureCodes = [];
  if (applicable && editRatioSpread > limits.maxEditRatioSpread + 1e-9) {
    failureCodes.push('repeatability_edit_depth_variance_high');
  }
  if (applicable && carryoverRatioSpread > limits.maxCarryoverRatioSpread + 1e-9) {
    failureCodes.push('repeatability_carryover_variance_high');
  }
  if (applicable && structuralRatioSpread > limits.maxStructuralRatioSpread + 1e-9) {
    failureCodes.push('repeatability_structure_variance_high');
  }
  return {
    pass: failureCodes.length === 0,
    applicable,
    failureCodes,
    editRatioSpread: round4(editRatioSpread),
    carryoverRatioSpread: round4(carryoverRatioSpread),
    structuralRatioSpread: round4(structuralRatioSpread),
    limits: {
      maxEditRatioSpread: limits.maxEditRatioSpread,
      maxCarryoverRatioSpread: limits.maxCarryoverRatioSpread,
      maxStructuralRatioSpread: limits.maxStructuralRatioSpread
    }
  };
}

function splitSentenceCount(value) {
  return String(value || '').split(/(?<=[.!?。！？])\s+/u).map(item => item.trim()).filter(Boolean).length;
}

function spread(values) {
  const finite = (values || []).filter(Number.isFinite);
  return finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

module.exports = { VERSION, INVARIANT_VOICE_CODES, auditRepeatability };
