const VERSION = 'basic-humanize-style-v1';
const SETTINGS_COLLECTION = 'adminSettings';
const SETTINGS_DOC = 'basicHumanizeExperiment';
const CACHE_TTL_MS = 15000;

const DEFAULT_CONFIG = {
  enabled: false
};

let cachedRuntimeConfig = null;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function config() {
  return sanitizeConfig({
    enabled: truthy(process.env.BASIC_HUMANIZE_STYLE_EXPERIMENT)
  });
}

function sanitizeConfig(raw = {}) {
  return {
    enabled: raw.enabled === true || truthy(raw.enabled)
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
      logger.warn('basic_humanize.experiment_config_failed_env_fallback', { err: e && e.message });
    }
    const value = publicConfig(envCfg, 'env_fallback');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }
}

module.exports = {
  VERSION,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
  DEFAULT_CONFIG,
  config,
  sanitizeConfig,
  publicConfig,
  getRuntimeConfig,
  clearRuntimeConfigCache
};
