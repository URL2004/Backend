'use strict';
const { sha } = require('./detectBenchmark');
const { auc, wilson, operatingPoint, repeatMetrics, quantile } = require('./detectEvaluation');

// Exact one-sided Clopper-Pearson upper bound; sum the binomial tail in log space.
function upperFpr(k, n, alpha = .05) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 1 || k < 0 || k > n || !(alpha > 0 && alpha < 1)) throw Error('invalid_binomial_counts');
  if (k === n) return 1;
  let low = 0, high = 1;
  for (let step = 0; step < 70; step++) {
    const p = (low + high) / 2;
    let term = n * Math.log1p(-p), sum = term;
    for (let i = 1; i <= k; i++) {
      term += Math.log(n - i + 1) - Math.log(i) + Math.log(p) - Math.log1p(-p);
      const max = Math.max(sum, term); sum = max + Math.log(Math.exp(sum - max) + Math.exp(term - max));
    }
    if (sum > Math.log(alpha)) low = p; else high = p;
  }
  return (low + high) / 2;
}
function atThreshold(rows, key, threshold) {
  const human = rows.filter(r => r.authorship === 'human_reference'), ai = rows.filter(r => r.authorship === 'ai');
  const fp = human.filter(r => r[key] >= threshold).length, tp = ai.filter(r => r[key] >= threshold).length;
  const families = new Map();
  for (const r of human) if (r.group) families.set(r.group, (families.get(r.group) || false) || r[key] >= threshold);
  const familyFp = [...families.values()].filter(Boolean).length;
  return { threshold, humanN: human.length, aiN: ai.length, falsePositives: fp, truePositives: tp,
    fpr: human.length ? fp / human.length : null, recall: ai.length ? tp / ai.length : null,
    fprWilson95: wilson(fp, human.length), recallWilson95: wilson(tp, ai.length),
    fprUpperOneSided95: human.length ? upperFpr(fp, human.length) : null,
    familyExposure: { n: families.size, anyFalsePositive: familyFp,
      upperOneSided95: families.size ? upperFpr(familyFp, families.size) : null,
      meaning: 'Any warning per recorded human family; distinct from document FPR. Independence between families is still an assumption.' } };
}
function reliability(rows, key) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ min: i * 10, max: (i + 1) * 10, n: 0, aiN: 0, scoreSum: 0 }));
  let brier = 0;
  for (const r of rows) {
    const score = r[key], y = Number(r.authorship === 'ai');
    if (!Number.isFinite(score) || score < 0 || score > 100) throw Error('invalid_reliability_score');
    const bin = bins[Math.min(9, Math.floor(score / 10))]; bin.n++; bin.aiN += y; bin.scoreSum += score;
    brier += (score / 100 - y) ** 2;
  }
  const results = bins.map(({ scoreSum, ...bin }) => ({ ...bin, meanScore: bin.n ? scoreSum / bin.n : null,
    observedAiFraction: bin.n ? bin.aiN / bin.n : null, observedAiWilson95: wilson(bin.aiN, bin.n) }));
  return { n: rows.length, brier: rows.length ? brier / rows.length : null,
    ece: rows.length ? results.reduce((s, r) => s + (r.n ? r.n * Math.abs(r.meanScore / 100 - r.observedAiFraction) : 0), 0) / rows.length : null,
    bins: results, meaning: 'Calibration diagnostic for this labelled sample and its class mixture, not production authorship probabilities.' };
}
function fastAuc(rows, key) {
  const sorted = [...rows].sort((a, b) => a[key] - b[key]); let h = 0, a = 0, wins = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i, hg = 0, ag = 0;
    while (j < sorted.length && sorted[j][key] === sorted[i][key]) { if (sorted[j++].authorship === 'ai') ag++; else hg++; }
    wins += ag * (h + hg / 2); h += hg; a += ag; i = j;
  }
  return h && a ? wins / (h * a) : null;
}
function pairedInterval(rows, before, after, { seed = 'paired-v1', iterations = 1000, threshold = 50 } = {}) {
  if (!Number.isInteger(iterations) || iterations < 100 || iterations > 10000) throw Error('invalid_bootstrap_iterations');
  const groups = new Map();
  for (const r of rows) { if (!r.group) throw Error('missing_family'); if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); }
  const values = [...groups.values()]; if (values.length < 2) return null;
  let state = parseInt(sha(seed).slice(0, 8), 16) || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const deltas = { auc: [], fpr: [], recall: [] };
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]).flat();
    const b = atThresholdFast(sample, before, threshold), c = atThresholdFast(sample, after, threshold);
    if (!b.h || !b.a) continue;
    deltas.auc.push(fastAuc(sample, after) - fastAuc(sample, before));
    deltas.fpr.push(c.fp / c.h - b.fp / b.h); deltas.recall.push(c.tp / c.a - b.tp / b.a);
  }
  return { method: 'paired_document_family_percentile_bootstrap', groups: values.length, iterations: deltas.auc.length, seed,
    intervals95: Object.fromEntries(Object.entries(deltas).map(([k, v]) => [k, [quantile(v, .025), quantile(v, .975)]])),
    note: 'Conditional on recorded families; does not resolve unrecorded semantic, author, source or generator dependence.' };
}
function atThresholdFast(rows, key, t) { return rows.reduce((s, r) => {
  if (r.authorship === 'human_reference') { s.h++; if (r[key] >= t) s.fp++; } else { s.a++; if (r[key] >= t) s.tp++; } return s;
}, { h: 0, a: 0, fp: 0, tp: 0 }); }

function evaluateValidation(rows, { thresholdPolicy, requiredGenres = ['report_assignment', 'resume_application'], iterations = 1000 } = {}) {
  const validated = require('./detectEvaluation').evaluatePairedScores(rows);
  validated.releaseEligible = false;
  const selected = rows.filter(r => r.split === 'holdout');
  const allKeys = ['baselineScore', 'candidateScore'];
  const groups = Object.fromEntries(['all', ...new Set(selected.map(r => r.genre))].map(genre => {
    const subset = genre === 'all' ? selected : selected.filter(r => r.genre === genre);
    return [genre, { n: subset.length, scores: Object.fromEntries(allKeys.map(key => [key, {
      auc: fastAuc(subset, key), reliability: reliability(subset, key), warningExposure21: atThreshold(subset, key, 21), positive50: atThreshold(subset, key, 50),
      diagnosticAtFpr01: operatingPoint(subset, key, .01), diagnosticAtFpr05: operatingPoint(subset, key, .05)
    }])), paired: pairedInterval(subset, ...allKeys, { iterations, seed: 'validation-v3:' + genre }) }];
  }));
  const reasons = [];
  if (thresholdPolicy) {
    const { digest, ...body } = thresholdPolicy;
    if (digest !== sha(JSON.stringify(body))) throw Error('threshold_policy_changed');
    if (selected.some(r => (thresholdPolicy.calibrationGroups || []).includes(r.group))) throw Error('threshold_calibration_leakage');
  }
  if (!thresholdPolicy || thresholdPolicy.selectedOn !== 'development_calibration' || !thresholdPolicy.digest) reasons.push('frozen_thresholds_missing');
  const frozen = {};
  for (const [genre, thresholds] of Object.entries(thresholdPolicy?.byGenre || {})) {
    const subset = selected.filter(r => r.genre === genre);
    frozen[genre] = {};
    for (const [target, threshold] of Object.entries(thresholds)) {
      if (!['0.01', '0.05'].includes(target) || !Number.isFinite(threshold) || threshold < 0 || threshold > 101) throw Error('invalid_frozen_threshold');
      const result = atThreshold(subset, 'candidateScore', threshold);
      frozen[genre][target] = result;
      if (!result.humanN || result.fprUpperOneSided95 > Number(target)
          || result.familyExposure.upperOneSided95 === null || result.familyExposure.upperOneSided95 > Number(target)) reasons.push('fpr_upper_bound:' + genre + ':' + target);
    }
  }
  for (const genre of requiredGenres) {
    const h = selected.filter(r => r.genre === genre && r.authorship === 'human_reference');
    if (!h.length || h.some(r => r.writingProcess !== 'human_original' || !r.processEvidence || r.labelQuality !== 'verified_process')) reasons.push('verified_human_process_missing:' + genre);
    if (!frozen[genre]?.['0.05']) reasons.push('frozen_threshold_missing:' + genre);
    // Missing controls already block promotion above. Do not turn an unmeasured
    // genre into fabricated 100% candidate / 0% baseline false-positive rates.
    const candidateFpr = groups[genre]?.scores.candidateScore.positive50.fpr;
    const baselineFpr = groups[genre]?.scores.baselineScore.positive50.fpr;
    if (Number.isFinite(candidateFpr) && Number.isFinite(baselineFpr) && candidateFpr > baselineFpr) reasons.push('genre_fpr_increased:' + genre);
  }
  const repeat = Object.fromEntries(allKeys.map((key, i) => [key, repeatMetrics(selected, i ? 'candidateRepeats' : 'baselineRepeats')]));
  const b = repeat.baselineScore, c = repeat.candidateScore;
  const pairedRepeats = selected.every(r => (Array.isArray(r.baselineRepeats) && r.baselineRepeats.length >= 3) === (Array.isArray(r.candidateRepeats) && r.candidateRepeats.length >= 3));
  if (!b.n || b.n !== c.n || !pairedRepeats) reasons.push('repeat_evidence_missing');
  else if (c.maxRange > b.maxRange || c.bandCrossing > b.bandCrossing || c.meanPairwiseAbsoluteDifference > 3) reasons.push('repeat_stability_regressed');
  const coverage = Object.fromEntries(['human_reference', 'ai'].map(label => {
    const subset = selected.filter(r => r.authorship === label);
    const counts = subset.reduce((s, r) => { const status = r.candidateStatus || (r.candidateApplied === true ? 'scored' : r.candidateApplied === false ? 'fallback' : 'unknown'); s[status] = (s[status] || 0) + 1; return s; }, {});
    return [label, { total: subset.length, statusCounts: counts, candidateCoverage: subset.length ? (counts.scored || 0) / subset.length : null,
      meaning: 'Candidate computation coverage; not evidence of whether authorship is determinable.' }];
  }));
  if (Object.values(coverage).some(c => c.statusCounts.unknown)) reasons.push('candidate_coverage_unknown');
  const performance = Object.fromEntries(['baselineLatencyMs', 'candidateLatencyMs', 'baselineCostUsd', 'candidateCostUsd'].map(k => {
    const values = selected.map(r => r[k]);
    return [k, values.every(v => Number.isFinite(v) && v >= 0) ? { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p95: quantile(values, .95) } : null];
  }));
  if (Object.values(performance).some(v => !v)) reasons.push('performance_evidence_missing');
  return { version: 'detect-validation-v3', paired: validated, groups, frozenOperatingPoints: frozen, coverage, repeat, performance, reasons,
    releaseEligible: false, note: 'New independent provenance and operational review required. ROC thresholds selected on this holdout are diagnostic only.' };
}

function evaluateRecheck(rows) {
  const grouped = new Map();
  for (const r of rows) {
    const primary = r.diagnostics?.attempts?.find(a => a.phase === 'primary')?.modelScore;
    const selected = r.diagnostics?.selectedModelScore;
    if (!Number.isFinite(primary) || !Number.isFinite(selected)) continue;
    const key = [r.genre || 'unknown', r.lengthBucket || 'unknown', r.diagnostics.recheckReason].join('/');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...r, primary, selected });
  }
  return { version: 'recheck-contribution-v1', applied: false, groups: Object.fromEntries([...grouped].map(([key, rs]) => [key, {
    n: rs.length, primaryAuc: auc(rs, 'primary'), selectedAuc: auc(rs, 'selected'),
    thresholds: Object.fromEntries([21, 50].map(t => [t, { primary: atThreshold(rs, 'primary', t), selected: atThreshold(rs, 'selected', t) }])),
    changed: rs.filter(r => r.primary !== r.selected).length,
    lowerSelected: rs.filter(r => r.selected < r.primary).length, higherSelected: rs.filter(r => r.selected > r.primary).length,
    note: 'First-call counterfactual is not the whole primary-only pipeline. Call-level cost required to estimate savings.'
  }])) };
}
module.exports = { upperFpr, atThreshold, reliability, fastAuc, pairedInterval, evaluateValidation, evaluateRecheck };
