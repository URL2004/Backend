'use strict';

function wilson(successes, n) {
  if (!n) return null;
  const z = 1.96, p = successes / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function evaluatePairedScores(rows, { split = 'holdout' } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('evaluation_empty');
  const ids = new Set(), groups = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('evaluation_duplicate_or_missing_id');
    ids.add(row.id);
    if (typeof row.group !== 'string' || !row.group || !['development', 'holdout'].includes(row.split)
      || !['human_reference', 'ai'].includes(row.authorship)) throw new Error('evaluation_invalid_provenance');
    if (groups.has(row.group) && groups.get(row.group) !== row.split) throw new Error('evaluation_group_leakage');
    groups.set(row.group, row.split);
    for (const key of ['baselineScore', 'candidateScore']) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 100) throw new Error('evaluation_missing_or_invalid_score');
    }
  }
  const selected = rows.filter(row => row.split === split);
  if (!selected.some(row => row.authorship === 'ai') || !selected.some(row => row.authorship === 'human_reference')) throw new Error('evaluation_missing_label_group');
  const metrics = {};
  for (const threshold of [21, 50]) {
    metrics[threshold] = {};
    for (const label of ['human_reference', 'ai']) {
      const group = selected.filter(row => row.authorship === label);
      const baselinePositive = group.filter(row => row.baselineScore >= threshold).length;
      const candidatePositive = group.filter(row => row.candidateScore >= threshold).length;
      const raised = group.filter(row => row.baselineScore < threshold && row.candidateScore >= threshold).length;
      const lowered = group.filter(row => row.baselineScore >= threshold && row.candidateScore < threshold).length;
      metrics[threshold][label] = {
        n: group.length, baselinePositive, candidatePositive,
        baselineRate: baselinePositive / group.length, candidateRate: candidatePositive / group.length,
        baselineWilson95: wilson(baselinePositive, group.length), candidateWilson95: wilson(candidatePositive, group.length),
        delta: (candidatePositive - baselinePositive) / group.length,
        pairedRaised: raised, pairedLowered: lowered
      };
    }
  }
  const human = metrics[50].human_reference, ai = metrics[50].ai;
  const passesPointCriteria = human.candidatePositive <= human.baselinePositive
    && (ai.candidatePositive - ai.baselinePositive) * 100 >= 5 * ai.n;
  return {
    version: 'detect-paired-evaluation-v1', split, n: selected.length,
    sourceGroups: new Set(selected.map(row => row.group)).size, metrics,
    passesPointCriteria,
    releaseEligible: split === 'holdout' && passesPointCriteria,
    note: 'Reference-human label is a provenance proxy. Rates describe this sample only. Release also requires frozen candidate, untouched heldout groups, representative genres, and operational checks.'
  };
}

module.exports = { evaluatePairedScores, wilson };
