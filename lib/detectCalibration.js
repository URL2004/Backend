const crypto = require('crypto');

const VERSION = 'history-calibration-v1';
const SETTINGS_COLLECTION = 'adminSettings';
const SETTINGS_DOC = 'detectCalibration';
const CACHE_TTL_MS = 15000;
const DEFAULT_CONFIG = {
  enabled: false,
  limit: 50,
  factor: 0.15,
  maxReduction: 12,
  floor: 35
};
let cachedRuntimeConfig = null;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function normalizeText(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function config() {
  return sanitizeConfig({
    enabled: truthy(process.env.DETECT_HISTORY_CALIBRATION),
    limit: numberEnv('DETECT_HISTORY_CALIBRATION_LIMIT', DEFAULT_CONFIG.limit),
    factor: numberEnv('DETECT_HISTORY_CALIBRATION_FACTOR', DEFAULT_CONFIG.factor),
    maxReduction: numberEnv('DETECT_HISTORY_CALIBRATION_MAX_REDUCTION', DEFAULT_CONFIG.maxReduction),
    floor: numberEnv('DETECT_HISTORY_CALIBRATION_FLOOR', DEFAULT_CONFIG.floor)
  });
}

function sanitizeConfig(raw = {}) {
  return {
    enabled: raw.enabled === true || truthy(raw.enabled),
    limit: Math.round(clamp(raw.limit ?? DEFAULT_CONFIG.limit, 1, 100)),
    factor: clamp(raw.factor ?? DEFAULT_CONFIG.factor, 0, 0.4),
    maxReduction: Math.round(clamp(raw.maxReduction ?? DEFAULT_CONFIG.maxReduction, 0, 30)),
    floor: Math.round(clamp(raw.floor ?? DEFAULT_CONFIG.floor, 0, 100))
  };
}

function publicConfig(cfg, source = 'env') {
  const clean = sanitizeConfig(cfg);
  return { ...clean, source, version: VERSION };
}

function clearRuntimeConfigCache() {
  cachedRuntimeConfig = null;
}

async function getRuntimeConfig({ db, logger, force = false } = {}) {
  const now = Date.now();
  if (!force && cachedRuntimeConfig && now - cachedRuntimeConfig.loadedAt < CACHE_TTL_MS) {
    return cachedRuntimeConfig.value;
  }

  const envCfg = config();
  if (!db) {
    const value = publicConfig(envCfg, 'env');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }

  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    const value = publicConfig({ ...envCfg, ...stored }, snap.exists ? 'firestore' : 'env');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('detect.calibration_config_failed_env_fallback', { err: e && e.message });
    }
    const value = publicConfig(envCfg, 'env_fallback');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }
}

function calibratedProbability(probability, cfg = config()) {
  const raw = clamp(Math.round(Number(probability)), 0, 100);
  const reduction = Math.min(cfg.maxReduction, Math.round(raw * cfg.factor));
  const adjusted = Math.max(cfg.floor, raw - reduction);
  return Math.min(raw, clamp(adjusted, 0, 100));
}

async function findOwnHumanizedHistoryMatch({ db, uid, text, limit }) {
  if (!db || !uid || !text) return null;
  const target = normalizeText(text);
  if (target.length < 100) return null;

  const snap = await db.collection('users').doc(uid).collection('history')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  for (const doc of snap.docs) {
    const h = doc.data() || {};
    if (h.type !== 'humanize') continue;
    const output = normalizeText(h.outputText);
    if (!output) continue;
    if (output === target) {
      return {
        id: doc.id,
        mode: h.mode || null,
        match: 'exact_normalized',
        outputHash: hashText(output)
      };
    }
  }
  return null;
}

async function applyHistoryCalibration({ db, uid, text, probability, logger, route }) {
  const cfg = await getRuntimeConfig({ db, logger });
  const raw = clamp(Math.round(Number(probability)), 0, 100);
  const base = { probability: raw, rawProbability: raw, applied: false, meta: null };
  if (!cfg.enabled) return base;

  let match = null;
  try {
    match = await findOwnHumanizedHistoryMatch({ db, uid, text, limit: cfg.limit });
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('detect.calibration_lookup_failed', { uid, route, err: e && e.message });
    }
    return base;
  }
  if (!match) return base;

  const adjusted = calibratedProbability(raw, cfg);
  const applied = adjusted < raw;
  const meta = {
    version: VERSION,
    applied,
    reason: 'own_humanized_history_match',
    match: match.match,
    historyId: match.id,
    historyMode: match.mode,
    inputHash: hashText(normalizeText(text)),
    outputHash: match.outputHash,
    rawProbability: raw,
    calibratedProbability: adjusted,
    maxReduction: cfg.maxReduction,
    floor: cfg.floor,
    factor: cfg.factor
  };

  if (logger && logger.info) {
    logger.info('detect.calibration_applied', {
      uid,
      route,
      historyId: match.id,
      rawProbability: raw,
      calibratedProbability: adjusted,
      applied
    });
  }

  return { probability: adjusted, rawProbability: raw, applied, meta };
}

module.exports = {
  VERSION,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
  DEFAULT_CONFIG,
  normalizeText,
  config,
  sanitizeConfig,
  publicConfig,
  getRuntimeConfig,
  clearRuntimeConfigCache,
  calibratedProbability,
  findOwnHumanizedHistoryMatch,
  applyHistoryCalibration
};
