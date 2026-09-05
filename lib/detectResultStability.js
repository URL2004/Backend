'use strict';

const crypto = require('node:crypto');
const { db, admin } = require('../config');
const { logger } = require('./logger');
const { accountDeletionBlocksWrites } = require('./accountActivityClaims');
const {
  causeScoreAlignmentEnabled,
  normalizeSignalEvidence,
  SIGNAL_POLICY_VERSION
} = require('./detectSignalPolicy');
const { secret: historyLinkSecret } = require('./historyLinkIntegrity');

const COLLECTION = 'analyzeRequests';
const PURPOSE = 'detect_result_stability_v2';
const VERSION = 'detect-result-stability-v3-grounded';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 500;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/u;
const PROCESS_LOCAL_SECRET = crypto.randomBytes(32);
const CACHE_KEY_DOMAIN = 'gpkorea:detect-result-stability:v2';
const DELETION_KEY_DOMAIN = 'gpkorea:detect-result-stability:deletion:v1';
const memory = new Map();
const inflight = new Map();

function cacheTtlMs(value = process.env.DETECT_STABILITY_TTL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(parsed)));
}

function compact(value, maxLength) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim()
    .slice(0, maxLength);
}

function cleanSignals(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter(item => typeof item === 'string')
    .map(item => compact(item, 160))
    .filter(Boolean))].slice(0, 12);
}

function cleanResult(value) {
  const probability = value?.probability;
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return null;
  const gptMeta = value?.gptMeta && typeof value.gptMeta === 'object'
    ? value.gptMeta
    : {};
  return {
    probability: Math.max(0, Math.min(100, Math.round(probability))),
    ...(typeof value.modelProbability === 'number' && Number.isFinite(value.modelProbability) ? {
      modelProbability: Math.max(0, Math.min(100, Math.round(Number(value.modelProbability))))
    } : {}),
    ...(value.causeScoreAdjusted === true ? {
      causeScoreAdjusted: true,
      causeScoreCeiling: Math.max(0, Math.min(100, Math.round(Number(value.causeScoreCeiling) || 0))),
      causeScoreAdjustmentCode: compact(value.causeScoreAdjustmentCode, 60)
    } : {}),
    summary: compact(value.summary, 800),
    detail: compact(value.detail, 2400),
    signals: cleanSignals(value.signals),
    ...(['model-signals-v1', 'model-signals-v2-grounded'].includes(value.signalContractVersion)
      ? { signalContractVersion: value.signalContractVersion } : {}),
    signalEvidence: normalizeSignalEvidence(value.signalEvidence)
      .filter(item => item.format === 'structured')
      .map(item => ({
        category: item.category,
        categoryLabel: item.categoryLabel,
        strength: item.strength,
        scope: item.scope,
        format: item.format,
        ...(value.signalContractVersion === 'model-signals-v2-grounded' ? cleanLocations(item) : {})
      })),
    confidence: ['low', 'medium', 'high'].includes(value.confidence)
      ? value.confidence
      : 'medium',
    gptMeta: {
      selectedModel: compact(gptMeta.selectedModel, 80),
      engine: compact(gptMeta.engine, 80),
      detectPromptVersion: compact(gptMeta.detectPromptVersion, 80),
      escalated: gptMeta.escalated === true
    }
  };
}

function cleanLocations(item) {
  const seen = new Set();
  const locations = (Array.isArray(item.locations) ? item.locations : [])
    .filter(location => {
      if (!location || ![location.sentenceIndex, location.start, location.end].every(Number.isSafeInteger)
          || location.sentenceIndex < 0 || location.start < 0 || location.end <= location.start
          || location.end > 100000 || seen.has(location.sentenceIndex)) return false;
      seen.add(location.sentenceIndex);
      return true;
    })
    .slice(0, 8)
    .map(({ sentenceIndex, start, end }) => ({ sentenceIndex, start, end }));
  return { locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function variantForConfig(config = {}, options = {}) {
  const payload = {
    version: VERSION,
    signalPolicyVersion: SIGNAL_POLICY_VERSION,
    causeScoreAlignmentEnabled: causeScoreAlignmentEnabled(),
    detectorVersion: compact(options.detectorVersion, 80),
    promptVersion: compact(options.promptVersion, 80),
    primaryModel: compact(config?.models?.detect, 80),
    escalationModel: compact(config?.models?.detectEscalation, 80),
    primaryReasoning: compact(config?.reasoning?.detect, 20),
    escalationReasoning: compact(config?.reasoning?.escalation, 20),
    documentProfile: compact(options.documentProfile, 80)
  };
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `${VERSION}:${digest}`;
}

function configuredPersistentSecret(override) {
  const configured = override === undefined
    ? String(historyLinkSecret() || '').trim()
    : String(override || '').trim();
  return configured.length >= 32 ? configured : '';
}

function cacheSecret(override) {
  const configured = configuredPersistentSecret(override);
  return configured.length >= 32 ? configured : PROCESS_LOCAL_SECRET;
}

function storageKey({ uid, payloadFingerprint, cacheVariant }, options = {}) {
  const safeUid = String(uid || '').trim();
  const fingerprint = String(payloadFingerprint || '').trim();
  const variant = String(cacheVariant || '').trim();
  if (!safeUid || !FINGERPRINT_RE.test(fingerprint) || !variant) return '';
  // The billing fingerprint is deterministic and can be guessed for short
  // inputs.  Never persist or index it directly: bind it to a server-only,
  // domain-separated HMAC first.
  return crypto.createHmac('sha256', cacheSecret(options.hmacSecret))
    .update(CACHE_KEY_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(safeUid, 'utf8')
    .update('\0', 'utf8')
    .update(fingerprint, 'utf8')
    .update('\0', 'utf8')
    .update(variant, 'utf8')
    .digest('hex');
}

function deletionKeyForUid(uid, options = {}) {
  const safeUid = String(uid || '').trim();
  const persistentSecret = configuredPersistentSecret(options.hmacSecret);
  if (!safeUid || !persistentSecret) return '';
  return crypto.createHmac('sha256', persistentSecret)
    .update(DELETION_KEY_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(safeUid, 'utf8')
    .digest('hex');
}

function memoryDeletionKeyForUid(uid, options = {}) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  return crypto.createHmac('sha256', cacheSecret(options.hmacSecret))
    .update(`${DELETION_KEY_DOMAIN}:memory`, 'utf8')
    .update('\0', 'utf8')
    .update(safeUid, 'utf8')
    .digest('hex');
}

function timestampMs(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  return 0;
}

function matches(row, input, now, options = {}) {
  const bindingHash = storageKey(input, options);
  return row?.purpose === PURPOSE
    && row?.bindingHash === bindingHash
    && row?.cacheVariant === String(input.cacheVariant || '')
    && timestampMs(row.expiresAtMs || row.expiresAt) > now;
}

function remember(key, row) {
  memory.delete(key);
  memory.set(key, row);
  while (memory.size > MAX_MEMORY_ENTRIES) {
    memory.delete(memory.keys().next().value);
  }
}

async function read(input, options = {}) {
  const now = Number(options.now) || Date.now();
  const key = storageKey(input, options);
  if (!key) return null;
  const local = memory.get(key);
  if (local && matches(local, input, now, options)) {
    const result = cleanResult(local.result);
    if (result) return { result: clone(result), source: 'memory' };
  }
  if (local) memory.delete(key);

  // A process-local fallback is safe for in-memory deduplication, but it must
  // never create Firestore rows that another instance/restart cannot address.
  if (!configuredPersistentSecret(options.hmacSecret)) return null;

  const firestore = options.firestore === undefined ? db : options.firestore;
  if (typeof firestore?.collection !== 'function') return null;
  try {
    const snapshot = await firestore.collection(COLLECTION).doc(key).get();
    if (!snapshot.exists) return null;
    const row = snapshot.data() || {};
    if (!matches(row, input, now, options)) return null;
    const result = cleanResult(row.result);
    if (!result) return null;
    remember(key, {
      ...row,
      result,
      memoryDeletionKey: memoryDeletionKeyForUid(input.uid, options)
    });
    return { result: clone(result), source: 'firestore' };
  } catch (error) {
    (options.log || logger).warn('detect_report.stability_cache_read_failed', {
      code: compact(error?.code || error?.message || 'CACHE_READ_FAILED', 80)
    });
    return null;
  }
}

async function write(input, result, options = {}) {
  const now = Number(options.now) || Date.now();
  const key = storageKey(input, options);
  const safeResult = cleanResult(result);
  if (!key || !safeResult) return false;
  const ttlMs = cacheTtlMs(options.ttlMs);
  const row = {
    purpose: PURPOSE,
    bindingHash: key,
    stabilityDeletionKey: deletionKeyForUid(input.uid, options),
    cacheVariant: String(input.cacheVariant),
    result: safeResult,
    createdAtMs: now,
    updatedAtMs: now,
    expiresAtMs: now + ttlMs
  };
  remember(key, {
    ...row,
    memoryDeletionKey: memoryDeletionKeyForUid(input.uid, options)
  });

  // Keep stability within this process when the deployment secret is absent,
  // while avoiding unreachable persistent cache documents.
  if (!configuredPersistentSecret(options.hmacSecret)) return true;

  const firestore = options.firestore === undefined ? db : options.firestore;
  const firebaseAdmin = options.firebaseAdmin === undefined ? admin : options.firebaseAdmin;
  if (typeof firestore?.collection !== 'function') return true;
  try {
    const ref = firestore.collection(COLLECTION).doc(key);
    const deletionRef = firestore.collection('accountDeletionJobs').doc(String(input.uid));
    if (typeof firestore.runTransaction === 'function') {
      const stored = await firestore.runTransaction(async transaction => {
        const deletionSnapshot = await transaction.get(deletionRef);
        if (deletionSnapshot.exists && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, now)) {
          return false;
        }
        const expiresAt = firebaseAdmin?.firestore?.Timestamp?.fromMillis
          ? firebaseAdmin.firestore.Timestamp.fromMillis(now + ttlMs)
          : new Date(now + ttlMs);
        transaction.set(ref, { ...row, expiresAt }, { merge: false });
        return true;
      });
      if (!stored) memory.delete(key);
      return stored;
    }
    const expiresAt = firebaseAdmin?.firestore?.Timestamp?.fromMillis
      ? firebaseAdmin.firestore.Timestamp.fromMillis(now + ttlMs)
      : new Date(now + ttlMs);
    await ref.set({ ...row, expiresAt }, { merge: false });
    return true;
  } catch (error) {
    (options.log || logger).warn('detect_report.stability_cache_write_failed', {
      code: compact(error?.code || error?.message || 'CACHE_WRITE_FAILED', 80)
    });
    return false;
  }
}

function purgeForUid(uid, options = {}) {
  const deletionKey = memoryDeletionKeyForUid(uid, options);
  if (!deletionKey) return 0;
  let removed = 0;
  for (const [key, row] of memory) {
    if (row?.memoryDeletionKey !== deletionKey) continue;
    memory.delete(key);
    removed += 1;
  }
  return removed;
}

async function getOrCompute(input, compute, options = {}) {
  if (typeof compute !== 'function') throw new TypeError('compute must be a function');
  const key = storageKey(input, options);
  if (!key) return { result: await compute(), cacheHit: false, source: 'live' };

  const cached = await read(input, options);
  if (cached) return { ...cached, cacheHit: true };

  const pending = inflight.get(key);
  if (pending) {
    const result = await pending;
    return { result: clone(result), cacheHit: true, source: 'inflight' };
  }

  const task = (async () => {
    const computed = await compute();
    const safeResult = cleanResult(computed);
    if (!safeResult) throw Object.assign(new Error('DETECT_INCOMPLETE'), { code: 'DETECT_INCOMPLETE' });
    await write(input, safeResult, options);
    return safeResult;
  })();
  inflight.set(key, task);
  try {
    return { result: clone(await task), cacheHit: false, source: 'live' };
  } finally {
    if (inflight.get(key) === task) inflight.delete(key);
  }
}

function resetForTests() {
  memory.clear();
  inflight.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, row] of memory) {
    if (timestampMs(row.expiresAtMs || row.expiresAt) <= now) memory.delete(key);
  }
}, 60 * 60 * 1000).unref();

module.exports = {
  COLLECTION,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
  PURPOSE,
  VERSION,
  cacheTtlMs,
  cleanResult,
  configuredPersistentSecret,
  deletionKeyForUid,
  memoryDeletionKeyForUid,
  getOrCompute,
  read,
  purgeForUid,
  resetForTests,
  storageKey,
  variantForConfig,
  write
};
