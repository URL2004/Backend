'use strict';

// Offline evidence analysis. Inputs/outputs contain private evaluation data and must stay outside Git.
// Usage: node scripts/audit-quality-benchmark.js <input.json> <output.json>
const { latency } = require('../engine-gpt-prod/modelCostSummary');
const finite = value => Number.isFinite(value) && value >= 0;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function analyze(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const ids = new Set();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error('Each observation requires a unique id.');
    ids.add(row.id);
  }
  const buckets = new Map();
  for (const row of rows) {
    const length = finite(row.sourceChars) ? row.sourceChars < 1000 ? 'short' : row.sourceChars < 5000 ? 'medium' : 'long' : 'unknown';
    const key = JSON.stringify([row.genre || 'unknown', length, row.outcome || 'unknown']);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const groups = [...buckets].map(([key, group]) => {
    // Only matched experiments with explicit quality pass on both sides support cost comparisons.
    const paired = group.filter(row => row.baseline?.qualityPass === true && row.candidate?.qualityPass === true
      && row.baseline?.qualityContract && row.baseline.qualityContract === row.candidate?.qualityContract);
    const matching = field => paired.filter(row => finite(row.baseline[field]) && finite(row.candidate[field]));
    const summarize = side => ({
      callCount: mean(matching('logicalCalls').map(row => row[side].logicalCalls)),
      knownUsd: mean(matching('knownUsd').map(row => row[side].knownUsd)),
      unknownReservedUsd: mean(matching('unknownReservedUsd').map(row => row[side].unknownReservedUsd)),
      metricSampleCounts: Object.fromEntries(['logicalCalls', 'knownUsd', 'unknownReservedUsd'].map(field => [field, matching(field).length])),
      queue: latency(matching('queueWaitMs').map(row => row[side].queueWaitMs)),
      execution: latency(matching('executionWallMs').map(row => row[side].executionWallMs)),
      total: latency(matching('totalWallMs').map(row => row[side].totalWallMs)),
      stages: [...new Set(paired.flatMap(row => (row.baseline.stages || []).map(stage => stage.stage)))].map(stage => {
        const observations = paired.map(row => ({ baseline: (row.baseline.stages || []).find(item => item.stage === stage),
          candidate: (row.candidate.stages || []).find(item => item.stage === stage) }));
        return { stage, ...Object.fromEntries(['calls', 'knownUsd', 'unknownReservedUsd'].map(field => {
          const matched = observations.filter(row => finite(row.baseline?.[field]) && finite(row.candidate?.[field]));
          return [field, { sampleCount: matched.length, mean: mean(matched.map(row => row[side][field])) }];
        })) };
      })
    });
    return { cohort: JSON.parse(key), observations: group.length, qualityMatchedPairs: paired.length,
      excludedPairs: group.length - paired.length, baseline: summarize('baseline'), candidate: summarize('candidate') };
  });
  const threshold = input.detectorThreshold;
  const labelEligible = rows.filter(row => row.independentLabel === true && typeof row.labelSource === 'string' && row.labelSource.trim()
    && row.sourceGroupId && ['human', 'ai', 'mixed'].includes(row.workflowLabel));
  const groupCounts = new Map();
  for (const row of labelEligible) groupCounts.set(row.sourceGroupId, (groupCounts.get(row.sourceGroupId) || 0) + 1);
  const labels = labelEligible.filter(row => groupCounts.get(row.sourceGroupId) === 1 && finite(row.detectorScore) && row.detectorScore <= 100);
  const binary = labels.filter(row => row.workflowLabel !== 'mixed');
  const human = binary.filter(row => row.workflowLabel === 'human');
  const ai = binary.filter(row => row.workflowLabel === 'ai');
  const validThreshold = finite(threshold) && threshold <= 100;
  return { version: 1, mode: 'offline_observations_only', observationCount: rows.length, groups,
    detector: { threshold: validThreshold ? threshold : null, independentEligible: labels.length,
      excludedUnlabelledOrDependent: rows.length - labels.length, mixedCount: labels.length - binary.length,
      humanCount: human.length, aiCount: ai.length,
      falsePositiveRate: validThreshold && human.length ? human.filter(row => row.detectorScore >= threshold).length / human.length : null,
      falseNegativeRate: validThreshold && ai.length ? ai.filter(row => row.detectorScore < threshold).length / ai.length : null,
      inference: 'descriptive_only_no_population_accuracy_claim' } };
}

// Proposal only: never sends a model request or changes the production chunker.
// IDs, exact text and ordering are retained; protected blocks and contract boundaries flush a batch.
function planBatchExperiment(blocks, { enabled = false, maxChars = 1200, maxBlocks = 4 } = {}) {
  if (!enabled) return { enabled: false, batches: [], reason: 'explicit_experiment_required' };
  if (!Number.isInteger(maxChars) || maxChars < 1 || !Number.isInteger(maxBlocks) || maxBlocks < 1) throw new Error('Invalid batch limits');
  const batches = [], seen = new Set();
  let pending = [], chars = 0, boundary = null;
  const flush = () => { if (pending.length) batches.push({ blockIds: pending.map(block => block.id), blocks: pending }); pending = []; chars = 0; };
  for (const block of blocks) {
    if (!block.id || seen.has(block.id) || typeof block.text !== 'string') throw new Error('Stable unique block IDs and text required');
    seen.add(block.id);
    // An absent protection/contract decision is not permission to batch.
    if (block.editable !== true || block.protected !== false || !block.contractId || !block.parentId || block.text.length > maxChars) {
      flush(); boundary = null; continue;
    }
    const nextBoundary = JSON.stringify([block.contractId, block.parentId, block.role || 'unknown']);
    if (boundary !== nextBoundary || chars + block.text.length > maxChars || pending.length >= maxBlocks) flush();
    boundary = nextBoundary;
    pending.push({ id: block.id, text: block.text }); chars += block.text.length;
  }
  flush();
  return { enabled: true, mode: 'proposal_only', batches,
    acceptance: 'exact ID coverage, source/candidate/structure/judge/contract validation and matched quality gates required before runtime activation' };
}
if (require.main === module) {
  const fs = require('node:fs');
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Usage: node scripts/audit-quality-benchmark.js <input.json> <output.json>');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/u, ''));
  fs.writeFileSync(outputPath, JSON.stringify(analyze(input), null, 2) + '\n');
}
module.exports = { analyze, planBatchExperiment };
