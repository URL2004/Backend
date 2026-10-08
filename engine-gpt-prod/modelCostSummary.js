'use strict';

// Complete job accounting, independent of the optional recovery allowance.
// No source, prompt, provider message or user identifier is persisted here.
const amount = value => Number.isFinite(value) && value >= 0 ? value : 0;
const round = value => Math.round(value * 1e6) / 1e6;
const stageCode = value => /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value || '') ? value : 'unknown';
function latency(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { sampleCount: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    totalCallElapsedMs: sorted.reduce((sum, n) => sum + n, 0) };
}

function summarize(entries = []) {
  const stages = new Map();
  let knownUsd = 0, mandatoryAuditUsd = 0, unknownReservedUsd = 0;
  for (const entry of entries) {
    const cost = amount(entry.usage?.estimatedUsd);
    const unknown = amount(entry.unknownEstimatedUsd);
    knownUsd += cost;
    unknownReservedUsd += unknown;
    if (entry.mandatoryAudit === true) mandatoryAuditUsd += cost;
    const key = stageCode(entry.stage);
    const row = stages.get(key) || { stage: key, calls: 0, httpAttempts: 0, knownUsd: 0, unknownReservedUsd: 0, durations: [] };
    row.calls += entry.httpAttemptCount > 0 ? 1 : 0;
    row.httpAttempts += amount(entry.httpAttemptCount);
    row.knownUsd = round(row.knownUsd + cost);
    row.unknownReservedUsd = round(row.unknownReservedUsd + unknown);
    if (entry.httpAttemptCount > 0 && Number.isFinite(entry.elapsedMs)) row.durations.push(amount(entry.elapsedMs));
    stages.set(key, row);
  }
  return { version: 1, knownUsd: round(knownUsd), mandatoryAuditUsd: round(mandatoryAuditUsd),
    otherUsd: round(Math.max(0, knownUsd - mandatoryAuditUsd)), unknownReservedUsd: round(unknownReservedUsd),
    // Call wall time includes retries/backoff, may overlap, and is not inference time or job latency.
    latencyBasis: 'logical_call_wall_including_retries',
    stages: [...stages.values()].map(({ durations, ...row }) => ({ ...row, latency: latency(durations) })) };
}

function sanitize(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.stages)) return null;
  return { version: 1, ...(value.latencyBasis === 'logical_call_wall_including_retries' ? { latencyBasis: value.latencyBasis } : {}), ...Object.fromEntries(['knownUsd', 'mandatoryAuditUsd', 'otherUsd', 'unknownReservedUsd']
    .map(key => [key, round(amount(value[key]))])),
  stages: value.stages.slice(0, 80).map(row => ({ stage: stageCode(row?.stage),
    calls: Math.floor(amount(row?.calls)), httpAttempts: Math.floor(amount(row?.httpAttempts)),
    knownUsd: round(amount(row?.knownUsd)), unknownReservedUsd: round(amount(row?.unknownReservedUsd)),
    ...(row?.latency && Number.isInteger(row.latency.sampleCount) && row.latency.sampleCount >= 0 ? { latency: {
      sampleCount: row.latency.sampleCount, p50Ms: Number.isFinite(row.latency.p50Ms) ? amount(row.latency.p50Ms) : null,
      p95Ms: Number.isFinite(row.latency.p95Ms) ? amount(row.latency.p95Ms) : null,
      totalCallElapsedMs: amount(row.latency.totalCallElapsedMs) } } : {}) })) };
}
module.exports = { summarize, sanitize, latency };
