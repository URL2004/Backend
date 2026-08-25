'use strict';

const { db, admin } = require('../config');
const { logger } = require('../lib/logger');

const memory = new Map();
const EVENTS = new Set([
  'PREPARE_READY', 'PREPARE_LIMITED', 'PREPARE_NEEDS_FACTS', 'PREPARE_POLICY_REVIEW', 'PREPARE_POLICY_BLOCKED',
  'GENERATE_READY', 'GENERATE_FALLBACK_READY', 'GENERATE_FAILED', 'FINAL_CHECK_READY', 'FINAL_CHECK_BLOCKED',
  'FINALIZE_HUMANIZED', 'FINALIZE_REPAIRED', 'FINALIZE_FALLBACK', 'FINALIZE_BLOCKED',
  'HUMANIZE_READY', 'HUMANIZE_FALLBACK', 'HUMANIZE_SKIPPED',
  'CLIPBOARD_FALLBACK', 'CLIPBOARD_FAILED'
]);

function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }

function latencyBucket(ms) {
  const value = Number(ms) || 0;
  if (value <= 15000) return 'lte15s';
  if (value <= 30000) return 'lte30s';
  if (value <= 45000) return 'lte45s';
  if (value <= 60000) return 'lte60s';
  return 'gt60s';
}

async function record(event, details = {}) {
  const name = String(event || '').toUpperCase();
  if (!EVENTS.has(name)) return { recorded: false, reason: 'invalid_event' };
  const day = dayKey();
  const genre = safeKey(details.genre, ['resume', 'review_blog', 'marketing', 'general']);
  const policyStatus = safeKey(details.policyStatus, ['ALLOW', 'ALLOW_WITH_NOTICE', 'REQUIRE_EVIDENCE', 'MANUAL_REVIEW', 'BLOCK']);
  const bucket = details.elapsedMs != null ? latencyBucket(details.elapsedMs) : '';
  recordMemory(day, name, genre, policyStatus, bucket, Number(details.elapsedMs) || 0);
  if (!db || !admin) return { recorded: true, storage: 'memory' };
  const update = {
    day,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    events: { [name]: admin.firestore.FieldValue.increment(1) }
  };
  if (genre) update.genres = { [genre]: admin.firestore.FieldValue.increment(1) };
  if (policyStatus) update.policyStatuses = { [policyStatus]: admin.firestore.FieldValue.increment(1) };
  if (bucket) {
    update.latencyBuckets = { [bucket]: admin.firestore.FieldValue.increment(1) };
    update.latencyTotalMs = admin.firestore.FieldValue.increment(Number(details.elapsedMs) || 0);
    update.latencyCount = admin.firestore.FieldValue.increment(1);
  }
  try {
    await db.collection('writingLabV2MetricsDaily').doc(day).set(update, { merge: true });
    return { recorded: true, storage: 'firestore' };
  } catch (error) {
    logger.warn('writinglab.telemetry_record_failed', { event: name, genre, err: error });
    return { recorded: true, storage: 'memory_fallback' };
  }
}

async function snapshot(days = 14) {
  const limit = Math.max(1, Math.min(90, Number(days) || 14));
  if (!db) return memorySnapshot(limit);
  try {
    const snap = await db.collection('writingLabV2MetricsDaily').orderBy('day', 'desc').limit(limit).get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  } catch (error) {
    logger.warn('writinglab.telemetry_read_failed', { days: limit, err: error });
    return memorySnapshot(limit);
  }
}

function recordMemory(day, event, genre, policyStatus, bucket, elapsedMs) {
  const row = memory.get(day) || { day, events: {}, genres: {}, policyStatuses: {}, latencyBuckets: {}, latencyTotalMs: 0, latencyCount: 0 };
  increment(row.events, event);
  if (genre) increment(row.genres, genre);
  if (policyStatus) increment(row.policyStatuses, policyStatus);
  if (bucket) {
    increment(row.latencyBuckets, bucket);
    row.latencyTotalMs += elapsedMs;
    row.latencyCount += 1;
  }
  memory.set(day, row);
}

function increment(target, key) { target[key] = (target[key] || 0) + 1; }

function safeKey(value, allowed) {
  const key = String(value || '');
  return allowed.includes(key) ? key : '';
}

function memorySnapshot(days) {
  return [...memory.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))).slice(-days).map(row => JSON.parse(JSON.stringify(row)));
}

function resetMemoryForTests() { memory.clear(); }

module.exports = { EVENTS, dayKey, latencyBucket, record, snapshot, resetMemoryForTests };
