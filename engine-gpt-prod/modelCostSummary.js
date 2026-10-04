'use strict';

// Complete job accounting, independent of the optional recovery allowance.
// No source, prompt, provider message or user identifier is persisted here.
const amount = value => Number.isFinite(value) && value >= 0 ? value : 0;
const round = value => Math.round(value * 1e6) / 1e6;
const stageCode = value => /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value || '') ? value : 'unknown';

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
    const row = stages.get(key) || { stage: key, calls: 0, httpAttempts: 0, knownUsd: 0, unknownReservedUsd: 0 };
    row.calls += entry.httpAttemptCount > 0 ? 1 : 0;
    row.httpAttempts += amount(entry.httpAttemptCount);
    row.knownUsd = round(row.knownUsd + cost);
    row.unknownReservedUsd = round(row.unknownReservedUsd + unknown);
    stages.set(key, row);
  }
  return { version: 1, knownUsd: round(knownUsd), mandatoryAuditUsd: round(mandatoryAuditUsd),
    otherUsd: round(Math.max(0, knownUsd - mandatoryAuditUsd)), unknownReservedUsd: round(unknownReservedUsd),
    stages: [...stages.values()] };
}

function sanitize(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.stages)) return null;
  return { version: 1, ...Object.fromEntries(['knownUsd', 'mandatoryAuditUsd', 'otherUsd', 'unknownReservedUsd']
    .map(key => [key, round(amount(value[key]))])),
  stages: value.stages.slice(0, 80).map(row => ({ stage: stageCode(row?.stage),
    calls: Math.floor(amount(row?.calls)), httpAttempts: Math.floor(amount(row?.httpAttempts)),
    knownUsd: round(amount(row?.knownUsd)), unknownReservedUsd: round(amount(row?.unknownReservedUsd)) })) };
}
module.exports = { summarize, sanitize };
