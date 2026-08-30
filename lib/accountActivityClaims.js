'use strict';

const crypto = require('node:crypto');

const COLLECTION = 'accountActivityClaims';
const TRANSFORM_LANE = 'activeTransformJobs';
const WRITING_LANE = 'activeWritingJobs';
const TRANSFORM_CLAIM_TTL_MS = 4 * 60 * 60 * 1000;
const WRITING_CLAIM_TTL_MS = 30 * 60 * 1000;

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return Number(value.toDate()?.getTime()) || 0;
  if (Number(value._seconds) > 0) return Number(value._seconds) * 1000;
  return Number(value) || 0;
}

function accountDeletionBlocksWrites(row, nowMs = Date.now()) {
  const value = row && typeof row === 'object' ? row : {};
  const status = String(value.status || '');
  if (['processing', 'retry_pending', 'manual_review'].includes(status)) return true;
  return status === 'completed' && timestampMs(value.protectUntilMs) > nowMs;
}

function deletionInProgressError() {
  return Object.assign(new Error('ACCOUNT_DELETION_IN_PROGRESS'), {
    code: 'ACCOUNT_DELETION_IN_PROGRESS',
    status: 409,
  });
}

function activityKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 40);
}

function activeLane(row, lane, nowMs = Date.now()) {
  const source = row && typeof row[lane] === 'object' && !Array.isArray(row[lane])
    ? row[lane]
    : {};
  const out = {};
  for (const [key, claim] of Object.entries(source)) {
    if (!claim || typeof claim !== 'object') continue;
    if (Number(claim.expiresAtMs || 0) <= nowMs) continue;
    out[key] = claim;
  }
  return out;
}

function laneWithClaim(row, lane, { id, status, ttlMs }, nowMs = Date.now()) {
  const current = activeLane(row, lane, nowMs);
  current[activityKey(id)] = {
    id: String(id || '').slice(0, 128),
    status: String(status || 'processing').slice(0, 40),
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(60_000, Number(ttlMs) || WRITING_CLAIM_TTL_MS),
  };
  return current;
}

function laneWithoutClaim(row, lane, id, nowMs = Date.now()) {
  const current = activeLane(row, lane, nowMs);
  delete current[activityKey(id)];
  return current;
}

function activeAccountActivityClaims(row, nowMs = Date.now()) {
  const transform = activeLane(row || {}, TRANSFORM_LANE, nowMs);
  const writing = activeLane(row || {}, WRITING_LANE, nowMs);
  return {
    active: Object.keys(transform).length > 0 || Object.keys(writing).length > 0,
    transformCount: Object.keys(transform).length,
    writingCount: Object.keys(writing).length,
  };
}

module.exports = {
  COLLECTION,
  TRANSFORM_CLAIM_TTL_MS,
  TRANSFORM_LANE,
  WRITING_CLAIM_TTL_MS,
  WRITING_LANE,
  accountDeletionBlocksWrites,
  activeAccountActivityClaims,
  activeLane,
  activityKey,
  deletionInProgressError,
  laneWithClaim,
  laneWithoutClaim,
  timestampMs,
};
