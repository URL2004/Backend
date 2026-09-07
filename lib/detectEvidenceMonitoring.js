'use strict';
const { quantile } = require('./detectEvaluation');
const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const directionCounts = () => ({ paired: 0, bothLow: 0, bothHigh: 0, candidateHigherBand: 0, candidateLowerBand: 0 });
function addComparison(group, current, candidate) {
  if (!validScore(current) || !validScore(candidate)) return;
  group.paired++;
  group[current >= 50 ? (candidate >= 50 ? 'bothHigh' : 'candidateLowerBand')
    : (candidate >= 50 ? 'candidateHigherBand' : 'bothLow')]++;
}

function summarizeEvents(events) {
  const groups = new Map(), seen = new Set(); let ignored = 0;
  for (const event of events) {
    if (!event || !['detect_report.evidence_shadow', 'detect_report.score_outcome', 'detect_report.idempotent_replay'].includes(event.event)) { ignored++; continue; }
    const r = event.fields || event;
    const id = r.requestId || r.clientRequestId;
    const classifierDigest = r.classifier?.modelDigest || null;
    const riskPolicyDigest = r.classifier?.calibrated?.policyDigest || null;
    const key = JSON.stringify([event.event, r.detectorVersion || 'unknown', r.profile || r.documentProfile || 'unknown', r.candidateDigest || 'none', classifierDigest, riskPolicyDigest]);
    const token = id ? key + '\0' + id : null;
    if (token && seen.has(token)) continue;
    if (token) seen.add(token);
    if (!groups.has(key)) groups.set(key, { event: event.event, detectorVersion: r.detectorVersion || 'unknown', profile: r.profile || r.documentProfile || 'unknown',
      candidateDigest: r.candidateDigest || null, classifierDigest, riskPolicyDigest,
      n: 0, scores: [], candidates: [], classifierScores: [], calibratedScores: [], overhead: [], latency: [], rawScores: [],
      classifierStatus: {}, calibratedStatus: {}, classifierComparison: directionCounts(), calibratedComparison: directionCounts(),
      sourceCounts: {}, shadowStatus: {}, diagnosed: 0, capped: 0, statistics: 0, actualCacheHits: 0, requestReplays: 0, shortRecheckCandidates: 0, crosses21: 0, crosses50: 0 });
    const g = groups.get(key); g.n++;
    for (const [key, value] of [['scores', r.currentScore ?? r.probability], ['candidates', r.candidateScore], ['overhead', r.computeMs], ['latency', r.latencyMs]]) if (typeof value === 'number' && Number.isFinite(value)) g[key].push(value);
    g.actualCacheHits += r.detectCacheHit === true ? 1 : 0;
    g.requestReplays += r.idempotentReplay === true || event.event === 'detect_report.idempotent_replay' ? 1 : 0;
    if (r.scoreSource) g.sourceCounts[r.scoreSource] = (g.sourceCounts[r.scoreSource] || 0) + 1;
    if (r.status) g.shadowStatus[r.status] = (g.shadowStatus[r.status] || 0) + 1;
    for (const [name, item] of [['classifier', r.classifier], ['calibrated', r.classifier?.calibrated]]) {
      if (['scored', 'out_of_scope', 'unavailable'].includes(item?.status)) g[name + 'Status'][item.status] = (g[name + 'Status'][item.status] || 0) + 1;
      if (item?.status === 'scored' && validScore(item.score)) {
        g[name + 'Scores'].push(item.score);
        // Compare to the engine result before optional history correction.
        addComparison(g[name + 'Comparison'], r.stageScores?.engineFinal ?? r.currentScore, item.score);
      }
    }
    const d = r.detectDiagnostics;
    const selected = d?.selectedModelScore ?? r.selectedModelScore;
    const aligned = d?.evidenceAlignedScore ?? r.evidenceAlignedScore;
    const statistical = d?.statisticalScore ?? r.stageScores?.statistical;
    if (r.statisticalSupport?.applied === true || (validScore(statistical) && validScore(aligned) && statistical > aligned)) g.statistics++;
    if (validScore(selected) && validScore(aligned)) {
      g.diagnosed++; g.rawScores.push(selected); g.capped += selected > aligned ? 1 : 0;
    }
    if (r.shortRecheckWouldSkip) g.shortRecheckCandidates++;
    if (Number.isFinite(r.currentScore) && Number.isFinite(r.candidateScore)) for (const t of [21, 50]) g['crosses' + t] += (r.currentScore >= t) !== (r.candidateScore >= t) ? 1 : 0;
  }
  const distribution = values => ({ n: values.length, mean: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null,
    p50: quantile(values, .5), p95: quantile(values, .95), ge21: values.filter(v => v >= 21).length, ge50: values.filter(v => v >= 50).length, ge60: values.filter(v => v >= 60).length, ge75: values.filter(v => v >= 75).length });
  return { version: 'detect-evidence-monitoring-v2', ignored,
    groups: [...groups.values()].map(g => ({ ...g, scores: distribution(g.scores), candidates: distribution(g.candidates), rawScores: distribution(g.rawScores),
      classifierScores: distribution(g.classifierScores), calibratedScores: distribution(g.calibratedScores),
      overhead: { n: g.overhead.length, p95Ms: quantile(g.overhead, .95) }, latency: { n: g.latency.length, p95Ms: quantile(g.latency, .95) } })),
    note: 'Unlabelled traffic, possibly including internal tests. Disagreement and score distribution are not accuracy. Cache and replay are separate.' };
}
module.exports = { summarizeEvents };
