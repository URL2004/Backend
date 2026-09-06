'use strict';
const { quantile } = require('./detectEvaluation');

function summarizeEvents(events) {
  const groups = new Map(), seen = new Set(); let ignored = 0;
  for (const event of events) {
    if (!event || !['detect_report.evidence_shadow', 'detect_report.score_outcome', 'detect_report.idempotent_replay'].includes(event.event)) { ignored++; continue; }
    const r = event.fields || event;
    const id = r.requestId || r.clientRequestId;
    const token = id ? event.event + '\0' + id : null;
    if (token && seen.has(token)) continue;
    if (token) seen.add(token);
    const key = JSON.stringify([event.event, r.detectorVersion || 'unknown', r.profile || r.documentProfile || 'unknown', r.candidateDigest || 'none']);
    if (!groups.has(key)) groups.set(key, { event: event.event, detectorVersion: r.detectorVersion || 'unknown', profile: r.profile || r.documentProfile || 'unknown',
      candidateDigest: r.candidateDigest || null, n: 0, scores: [], candidates: [], overhead: [], latency: [], rawScores: [],
      sourceCounts: {}, shadowStatus: {}, diagnosed: 0, capped: 0, statistics: 0, actualCacheHits: 0, requestReplays: 0, shortRecheckCandidates: 0, crosses21: 0, crosses50: 0 });
    const g = groups.get(key); g.n++;
    for (const [key, value] of [['scores', r.currentScore ?? r.probability], ['candidates', r.candidateScore], ['overhead', r.computeMs], ['latency', r.latencyMs]]) if (typeof value === 'number' && Number.isFinite(value)) g[key].push(value);
    g.actualCacheHits += r.detectCacheHit === true ? 1 : 0;
    g.requestReplays += r.idempotentReplay === true || event.event === 'detect_report.idempotent_replay' ? 1 : 0;
    if (r.scoreSource) g.sourceCounts[r.scoreSource] = (g.sourceCounts[r.scoreSource] || 0) + 1;
    if (r.status) g.shadowStatus[r.status] = (g.shadowStatus[r.status] || 0) + 1;
    if (r.statisticalSupport?.applied) g.statistics++;
    const d = r.detectDiagnostics;
    if (Number.isFinite(d?.selectedModelScore) && Number.isFinite(d?.evidenceAlignedScore)) {
      g.diagnosed++; g.rawScores.push(d.selectedModelScore); g.capped += d.selectedModelScore > d.evidenceAlignedScore ? 1 : 0;
    }
    if (r.shortRecheckWouldSkip) g.shortRecheckCandidates++;
    if (Number.isFinite(r.currentScore) && Number.isFinite(r.candidateScore)) for (const t of [21, 50]) g['crosses' + t] += (r.currentScore >= t) !== (r.candidateScore >= t) ? 1 : 0;
  }
  const distribution = values => ({ n: values.length, mean: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null,
    p50: quantile(values, .5), p95: quantile(values, .95), ge21: values.filter(v => v >= 21).length, ge50: values.filter(v => v >= 50).length, ge60: values.filter(v => v >= 60).length, ge75: values.filter(v => v >= 75).length });
  return { version: 'detect-evidence-monitoring-v1', ignored,
    groups: [...groups.values()].map(g => ({ ...g, scores: distribution(g.scores), candidates: distribution(g.candidates), rawScores: distribution(g.rawScores),
      overhead: { n: g.overhead.length, p95Ms: quantile(g.overhead, .95) }, latency: { n: g.latency.length, p95Ms: quantile(g.latency, .95) } })),
    note: 'Unlabelled traffic, possibly including internal tests. Disagreement and score distribution are not accuracy. Cache and replay are separate.' };
}
module.exports = { summarizeEvents };
