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

function quantile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))];
}

function auc(rows, key) {
  const human = rows.filter(r => r.authorship === 'human_reference');
  const ai = rows.filter(r => r.authorship === 'ai');
  if (!human.length || !ai.length) return null;
  let wins = 0;
  for (const a of ai) for (const h of human) wins += a[key] > h[key] ? 1 : a[key] === h[key] ? .5 : 0;
  return wins / (human.length * ai.length);
}

function calibration(rows, key, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, score: 0, positives: 0 }));
  let brier = 0;
  for (const r of rows) {
    const p = r[key] / 100, y = r.authorship === 'ai' ? 1 : 0;
    const b = buckets[Math.min(bins - 1, Math.floor(p * bins))];
    b.n++; b.score += p; b.positives += y; brier += (p - y) ** 2;
  }
  const reliability = buckets.map((b, i) => ({ from: i / bins, to: (i + 1) / bins, n: b.n,
    meanScore: b.n ? b.score / b.n : null, aiFraction: b.n ? b.positives / b.n : null }));
  return { ece: rows.length ? reliability.reduce((s, b) => s + b.n * Math.abs((b.meanScore || 0) - (b.aiFraction || 0)), 0) / rows.length : null,
    brier: rows.length ? brier / rows.length : null, reliability,
    meaning: 'Benchmark-class-mixture diagnostic only; not a production authorship probability.' };
}

function operatingPoint(rows, key, maxFpr = .05) {
  const human = rows.filter(r => r.authorship === 'human_reference');
  const ai = rows.filter(r => r.authorship === 'ai');
  if (!human.length || !ai.length) return null;
  const thresholds = [...new Set([101, ...rows.map(r => r[key])])].sort((a, b) => a - b);
  for (const threshold of thresholds) {
    const fp = human.filter(r => r[key] >= threshold).length;
    if (fp / human.length <= maxFpr) return { threshold, humanPositive: fp, humanN: human.length,
      aiRecall: ai.filter(r => r[key] >= threshold).length / ai.length,
      note: 'Post-hoc diagnostic; this threshold must not be selected on final validation for deployment.' };
  }
  return null;
}

function exactMcNemar(raised, lowered) {
  const n = raised + lowered;
  if (!n) return 1;
  // Sum the binomial lower tail in log space (large evaluations must not overflow).
  let logTerm = -n * Math.log(2), logSum = logTerm;
  for (let k = 1; k <= Math.min(raised, lowered); k++) {
    logTerm += Math.log(n - k + 1) - Math.log(k);
    const m = Math.max(logSum, logTerm);
    logSum = m + Math.log(Math.exp(logSum - m) + Math.exp(logTerm - m));
  }
  return Math.min(1, 2 * Math.exp(logSum));
}

function repeatMetrics(rows, key) {
  const differences = [], ranges = [];
  let crossing = 0, n = 0;
  for (const row of rows) {
    const values = row[key];
    if (!Array.isArray(values) || values.length < 3) continue;
    n++;
    ranges.push(Math.max(...values) - Math.min(...values));
    for (let a = 0; a < values.length; a++) for (let b = a + 1; b < values.length; b++) differences.push(Math.abs(values[a] - values[b]));
    if ([21, 50].some(t => values.some(v => v < t) && values.some(v => v >= t))) crossing++;
  }
  return { n, meanPairwiseAbsoluteDifference: differences.length ? differences.reduce((s, v) => s + v, 0) / differences.length : null,
    maxRange: ranges.length ? Math.max(...ranges) : null, bandCrossing: crossing };
}

function groupMetrics(rows) {
  const out = { n: rows.length, humanN: rows.filter(r => r.authorship === 'human_reference').length,
    aiN: rows.filter(r => r.authorship === 'ai').length };
  for (const key of ['baselineScore', 'candidateScore']) {
    const scores = rows.map(r => r[key]);
    out[key] = { auc: auc(rows, key), operatingPointAtFpr05: operatingPoint(rows, key),
      mean: scores.reduce((s, v) => s + v, 0) / scores.length, median: quantile(scores, .5),
      calibration: calibration(rows, key), thresholds: {} };
    for (const t of [21, 50, 60, 75]) {
      out[key].thresholds[t] = Object.fromEntries(['human_reference', 'ai'].map(label => {
        const subset = rows.filter(r => r.authorship === label), k = subset.filter(r => r[key] >= t).length;
        return [label, { n: subset.length, positive: k, rate: subset.length ? k / subset.length : null, wilson95: wilson(k, subset.length) }];
      }));
    }
  }
  return out;
}

function evaluateEvidenceScores(rows, { split = 'holdout', requiredGenres = ['explainer', 'report_assignment', 'resume_application', 'short_review', 'personal_essay'], minPerClass = 20 } = {}) {
  const paired = evaluatePairedScores(rows, { split });
  for (const r of rows) for (const key of ['baselineRepeats', 'candidateRepeats']) {
    if (r[key] !== undefined && (!Array.isArray(r[key]) || r[key].some(v => !Number.isFinite(v) || v < 0 || v > 100))) throw new Error('evaluation_invalid_repeats');
  }
  const selected = rows.filter(r => r.split === split);
  const genres = Object.fromEntries([...new Set(selected.map(r => r.genre || 'unknown'))].map(g => [g, groupMetrics(selected.filter(r => (r.genre || 'unknown') === g))]));
  const lengths = Object.fromEntries([...new Set(selected.map(r => r.lengthBucket || 'unknown'))].map(g => [g, groupMetrics(selected.filter(r => (r.lengthBucket || 'unknown') === g))]));
  const all = groupMetrics(selected), repeat = { baseline: repeatMetrics(selected, 'baselineRepeats'), candidate: repeatMetrics(selected, 'candidateRepeats') };
  const reasons = [];
  if (split !== 'holdout') reasons.push('development_only');
  for (const genre of requiredGenres) if (!genres[genre] || genres[genre].humanN < minPerClass || genres[genre].aiN < minPerClass) reasons.push('insufficient_genre:' + genre);
  const h = paired.metrics[50].human_reference, a = paired.metrics[50].ai;
  if (h.candidateRate > h.baselineRate || h.candidateRate > .05) reasons.push('human_false_positive_gate');
  if (a.delta < .1 - 1e-12) reasons.push('ai_recall_gain_below_10pp');
  // The fraction above 60 is diagnostic. Raising the numeric scale alone is
  // not a release objective and cannot compensate for false positives.
  const repeatPairsMatch = selected.every(r => (Array.isArray(r.baselineRepeats) && r.baselineRepeats.length >= 3)
    === (Array.isArray(r.candidateRepeats) && r.candidateRepeats.length >= 3));
  if (!repeat.baseline.n || repeat.baseline.n !== repeat.candidate.n || !repeatPairsMatch) reasons.push('repeat_evidence_missing');
  else if (repeat.candidate.meanPairwiseAbsoluteDifference > repeat.baseline.meanPairwiseAbsoluteDifference || repeat.candidate.meanPairwiseAbsoluteDifference > 3) reasons.push('repeat_variance_gate');
  const performance = {};
  for (const key of ['baselineLatencyMs', 'candidateLatencyMs', 'baselineCostUsd', 'candidateCostUsd']) {
    const values = selected.map(r => r[key]);
    performance[key] = values.every(v => Number.isFinite(v) && v >= 0) ? { n: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length, p95: quantile(values, .95) } : null;
  }
  if (Object.values(performance).some(v => !v)) reasons.push('performance_evidence_missing');
  else if (performance.candidateLatencyMs.p95 > performance.baselineLatencyMs.p95 * 1.3 || performance.candidateCostUsd.mean > performance.baselineCostUsd.mean * 1.3) reasons.push('performance_overhead_gate');
  return { version: 'detect-evidence-evaluation-v2', split, all, genres, lengths, repeat, performance, paired,
    aiExactMcNemarP: exactMcNemar(a.pairedRaised, a.pairedLowered), humanExactMcNemarP: exactMcNemar(h.pairedRaised, h.pairedLowered),
    pointCriteriaPassed: reasons.length === 0, reasons,
    // Only the benchmark runner, with its frozen-candidate/one-use ledger, can authorize a release review.
    releaseEligible: false, note: 'Metrics alone never authorize release. Require provenance, untouched holdout, calibration split, subgroup and human review.' };
}

function evaluateHumanizePairs(rows) {
  const ids = new Set(), valid = [], excluded = [];
  for (const row of rows) {
    if (!row?.id || ids.has(row.id)) throw Error('humanize_evaluation_duplicate_id');
    ids.add(row.id);
    if (!row.detectorBefore || row.detectorBefore !== row.detectorAfter || row.historyCalibrationExcluded !== true
      || ![row.beforeScore, row.afterScore].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)) {
      excluded.push({ id: row.id, reason: 'incomparable_score' }); continue;
    }
    if (row.contentPreserved !== true) { excluded.push({ id: row.id, reason: row.contentPreserved === false ? 'content_changed' : 'content_not_verified' }); continue; }
    valid.push(row);
  }
  const bySourceBand = {};
  for (const [name, low, high] of [['low', 0, 20], ['mixed', 21, 49], ['high', 50, 100]]) {
    const r = valid.filter(row => row.beforeScore >= low && row.beforeScore <= high);
    bySourceBand[name] = { n: r.length, meanDelta: r.length ? r.reduce((s, row) => s + row.afterScore - row.beforeScore, 0) / r.length : null,
      worsened: r.filter(row => row.afterScore > row.beforeScore).length };
  }
  return { version: 'humanize-paired-evaluation-v1', n: rows.length, valid: valid.length, excluded, bySourceBand,
    note: 'Score reduction is not authorship proof or a release objective on its own; assess content preservation independently. Humanized AI retains its origin label.' };
}

// Offline diagnostic: separate stochastic repeat noise from a genuine response
// to an edit. Never reuse similar-text production caches or change user scores.
function evaluateMinimalEditStability(rows, { maxRepeatRange = 6, maxMedianDelta = 5 } = {}) {
  const ids = new Set();
  const pairs = rows.map(row => {
    if (!row.id || ids.has(row.id)) throw Error('stability_duplicate_id');
    ids.add(row.id);
    if (!['equivalent', 'meaning_changed'].includes(row.editKind)) throw Error('stability_unverified_edit_kind');
    for (const key of ['beforeRepeats', 'afterRepeats']) {
      if (!Array.isArray(row[key]) || row[key].length < 3
        || row[key].some(n => !Number.isFinite(n) || n < 0 || n > 100)) throw Error('stability_repeats_required');
    }
    const range = values => Math.max(...values) - Math.min(...values);
    const beforeRange = range(row.beforeRepeats), afterRange = range(row.afterRepeats);
    const medianDelta = quantile(row.afterRepeats, .5) - quantile(row.beforeRepeats, .5);
    const reasons = [];
    if (Math.max(beforeRange, afterRange) > maxRepeatRange) reasons.push('same_input_variance');
    if (row.editKind === 'equivalent' && Math.abs(medianDelta) > maxMedianDelta) reasons.push('minimal_edit_sensitivity');
    return { id: row.id, editKind: row.editKind, beforeRange, afterRange, medianDelta, reasons };
  });
  return { version: 'detect-minimal-edit-stability-v1', pairs,
    diagnosticPass: pairs.length > 0 && pairs.every(pair => pair.reasons.length === 0), releaseEligible: false };
}

// Paired, cache-free repeated calls, not cached equality or cross-version
// historical comparisons. This is a development screen, never release approval.
function evaluateConsistencyComparison(rows, { maxRange = 6, maxOverhead = 1.3 } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw Error('consistency_evaluation_empty');
  const ids = new Set(), all = { baseline: [], candidate: [] };
  const pairs = rows.map(row => {
    if (!row?.id || ids.has(row.id)) throw Error('consistency_duplicate_id');
    ids.add(row.id);
    if (!['human_reference', 'ai', 'unknown'].includes(row.label) || typeof row.genre !== 'string' || !row.genre
      || row.cacheExcluded !== true || row.historyCalibrationExcluded !== true) throw Error('consistency_incomparable_input');
    for (const key of ['baseline', 'candidate']) {
      if (!Array.isArray(row[key]) || row[key].length < 3 || row[key].some(item =>
        !item || !Number.isFinite(item.score) || item.score < 0 || item.score > 100
        || !Number.isFinite(item.seconds) || item.seconds <= 0 || !Number.isFinite(item.usd) || item.usd < 0)) {
        throw Error('consistency_repeats_required');
      }
      all[key].push(...row[key]);
    }
    if (row.baseline.length !== row.candidate.length) throw Error('consistency_unpaired_repeats');
    const view = values => {
      const scores = values.map(item => item.score);
      return { range: Math.max(...scores) - Math.min(...scores), median: quantile(scores, .5),
        bands: new Set(scores.map(n => n <= 20 ? 0 : n < 50 ? 1 : n < 75 ? 2 : 3)).size };
    };
    return { id: row.id, genre: row.genre, label: row.label, baseline: view(row.baseline), candidate: view(row.candidate) };
  });
  const performance = {};
  for (const key of ['baseline', 'candidate']) performance[key] = {
    calls: all[key].length,
    p95Seconds: quantile(all[key].map(item => item.seconds), .95),
    totalUsd: all[key].reduce((sum, item) => sum + item.usd, 0)
  };
  const human = pairs.filter(row => row.label === 'human_reference'), ai = pairs.filter(row => row.label === 'ai');
  const labelMetrics = group => ({ n: group.length,
    baselineAbove50: group.filter(row => row.baseline.median >= 50).length,
    candidateAbove50: group.filter(row => row.candidate.median >= 50).length,
    baselineAbove20: group.filter(row => row.baseline.median > 20).length,
    candidateAbove20: group.filter(row => row.candidate.median > 20).length });
  const reasons = [];
  if (pairs.some(row => row.candidate.range > maxRange)) reasons.push('repeat_range_above_target');
  if (pairs.some(row => row.candidate.range > row.baseline.range)) reasons.push('repeat_variance_regression');
  const labels = { human: labelMetrics(human), ai: labelMetrics(ai) };
  if (labels.human.candidateAbove50 > labels.human.baselineAbove50) reasons.push('human_false_positive_regression');
  if (labels.ai.candidateAbove50 < labels.ai.baselineAbove50) reasons.push('ai_detection_regression');
  if (labels.ai.candidateAbove20 < labels.ai.baselineAbove20) reasons.push('ai_low_band_sensitivity_regression');
  if (performance.candidate.p95Seconds > performance.baseline.p95Seconds * maxOverhead) reasons.push('latency_overhead');
  if (performance.candidate.totalUsd > performance.baseline.totalUsd * maxOverhead) reasons.push('cost_overhead');
  const genres = [...new Set(pairs.map(row => row.genre))];
  if (genres.filter(genre => human.filter(row => row.genre === genre).length >= 20
    && ai.filter(row => row.genre === genre).length >= 20).length < 5) reasons.push('insufficient_labelled_genre_coverage');
  return { version: 'detect-consistency-evaluation-v1', pairs, performance, labels, reasons,
    diagnosticPass: reasons.length === 0, releaseEligible: false,
    note: 'Development screening only. Require untouched holdout, verified provenance, human review and calibration before deployment.' };
}

module.exports = { evaluatePairedScores, evaluateEvidenceScores, evaluateHumanizePairs, evaluateMinimalEditStability,
  evaluateConsistencyComparison, wilson, auc, calibration, operatingPoint, exactMcNemar, quantile, repeatMetrics };
