'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const METRICS_COLLECTION = 'publicMetrics';
const METRICS_DOCUMENT = 'aggregate';
const EVENT_COLLECTION = 'publicMetricEvents';
const ALLOWED_OPERATIONS = new Set(['detect', 'humanize']);

function emptyPayload() {
  return {
    schemaVersion: SCHEMA_VERSION,
    verified: false,
    since: null,
    asOf: null,
    totals: {
      processedCharacters: 0,
      completedJobs: 0
    }
  };
}

function eventDocumentId(operation, eventId) {
  return crypto
    .createHash('sha256')
    .update(`${operation}:${String(eventId || '').trim()}`)
    .digest('hex');
}

function toIsoString(value) {
  if (!value) return null;
  const candidate = typeof value.toDate === 'function' ? value.toDate() : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeStoredMetrics(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const processedCharacters = safeCount(raw.totals?.processedCharacters);
  const completedJobs = safeCount(raw.totals?.completedJobs);
  const since = toIsoString(raw.since);
  const asOf = toIsoString(raw.asOf);
  const verified = raw.schemaVersion === SCHEMA_VERSION
    && raw.verified === true
    && processedCharacters !== null
    && completedJobs !== null
    && since !== null
    && asOf !== null;

  return {
    schemaVersion: SCHEMA_VERSION,
    verified,
    since,
    asOf,
    totals: {
      processedCharacters: processedCharacters ?? 0,
      completedJobs: completedJobs ?? 0
    }
  };
}

async function readPublicMetrics({ db }) {
  if (!db) return { status: 503, body: emptyPayload(), reason: 'db_unavailable' };

  const snapshot = await db.collection(METRICS_COLLECTION).doc(METRICS_DOCUMENT).get();
  // `verified:false` is a valid public state, not a transport failure. Returning
  // 503 here made every landing-page visit emit a failed network request even
  // though the client correctly hides unverified totals. Keep 503 exclusively
  // for an actual datastore/read failure so monitors retain a useful signal.
  if (!snapshot.exists) return { status: 200, body: emptyPayload(), reason: 'not_initialized' };

  const body = normalizeStoredMetrics(snapshot.data());
  return {
    status: 200,
    body,
    reason: body.verified ? 'verified' : 'not_verified'
  };
}

async function recordCompletedJob({
  db,
  operation,
  eventId,
  uid,
  processedCharacters,
  isAdmin = false,
  isTest = false,
  now = () => new Date()
}) {
  const normalizedOperation = String(operation || '').trim();
  const normalizedEventId = String(eventId || '').trim();
  const characters = safeCount(processedCharacters);

  if (!db) return { recorded: false, reason: 'db_unavailable' };
  if (isAdmin || isTest) return { recorded: false, reason: 'excluded_actor' };
  if (!uid) return { recorded: false, reason: 'missing_uid' };
  if (!ALLOWED_OPERATIONS.has(normalizedOperation)) {
    return { recorded: false, reason: 'invalid_operation' };
  }
  if (!normalizedEventId) return { recorded: false, reason: 'missing_event_id' };
  if (characters === null || characters <= 0) {
    return { recorded: false, reason: 'invalid_character_count' };
  }

  const markerId = eventDocumentId(normalizedOperation, normalizedEventId);
  const markerRef = db.collection(EVENT_COLLECTION).doc(markerId);
  const aggregateRef = db.collection(METRICS_COLLECTION).doc(METRICS_DOCUMENT);

  return db.runTransaction(async transaction => {
    const [markerSnapshot, aggregateSnapshot] = await Promise.all([
      transaction.get(markerRef),
      transaction.get(aggregateRef)
    ]);
    if (markerSnapshot.exists) return { recorded: false, reason: 'duplicate', markerId };

    const aggregate = aggregateSnapshot.exists && aggregateSnapshot.data()
      ? aggregateSnapshot.data()
      : {};
    const currentCharacters = safeCount(aggregate.totals?.processedCharacters) ?? 0;
    const currentJobs = safeCount(aggregate.totals?.completedJobs) ?? 0;
    const recordedAt = now();

    transaction.set(markerRef, {
      schemaVersion: SCHEMA_VERSION,
      operation: normalizedOperation,
      processedCharacters: characters,
      createdAt: recordedAt
    });
    transaction.set(aggregateRef, {
      schemaVersion: SCHEMA_VERSION,
      // Historical verification is an explicit operational step. Live events
      // must never silently turn an incomplete aggregate into public proof.
      verified: aggregate.verified === true,
      since: aggregate.since || null,
      asOf: recordedAt,
      totals: {
        processedCharacters: currentCharacters + characters,
        completedJobs: currentJobs + 1
      }
    }, { merge: true });

    return { recorded: true, reason: 'recorded', markerId };
  });
}

function trackDeliveredMetric(res, metric, { db, logger } = {}) {
  if (!res || typeof res.once !== 'function') return false;
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    recordCompletedJob({ db, ...metric }).catch(error => {
      logger?.warn?.('public_metrics.record_failed', {
        operation: metric?.operation,
        eventId: metric?.eventId,
        err: error
      });
    });
  });
  return true;
}

module.exports = {
  SCHEMA_VERSION,
  METRICS_COLLECTION,
  METRICS_DOCUMENT,
  EVENT_COLLECTION,
  emptyPayload,
  eventDocumentId,
  normalizeStoredMetrics,
  readPublicMetrics,
  recordCompletedJob,
  trackDeliveredMetric
};
