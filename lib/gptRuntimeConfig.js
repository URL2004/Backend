'use strict';

const VERSION = 'gpt-runtime-config-v1';
const SETTINGS_COLLECTION = 'adminSettings';
const SETTINGS_DOC = 'gptRuntimeConfig';
const CACHE_TTL_MS = 15000;

const DEFAULT_CONFIG = {
  activeProvider: 'gpt',
  fallbackProvider: 'claude',
  shadowMode: false,
  models: {
    humanizePrimary: 'gpt-5.4-mini',
    humanizeEscalation: 'gpt-5.4',
    judge: 'gpt-5.4-mini',
    repair: 'gpt-5.4-mini',
    classify: 'gpt-5.4-nano',
    detect: 'gpt-5.4-mini',
    detectEscalation: 'gpt-5.4',
    evidenceSearch: 'gpt-5.4-mini',
    evidenceEscalation: 'gpt-5.4'
  },
  reasoning: {
    humanize: 'low',
    factDense: 'medium',
    escalation: 'medium',
    judge: 'low',
    repair: 'low',
    classify: 'low',
    detect: 'low',
    evidenceSearch: 'medium'
  },
  cache: {
    enabled: true,
    keyPrefix: 'gp-prod',
    retention: ''
  },
  escalation: {
    enabled: true,
    longTextChars: 10000,
    protectedTermThreshold: 40,
    patchTargetThreshold: 12
  }
};

let cachedRuntimeConfig = null;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function falsey(value) {
  return /^(0|false|no|off)$/i.test(String(value || '').trim());
}

function boolValue(value, fallback) {
  if (value === true || value === false) return value;
  if (truthy(value)) return true;
  if (falsey(value)) return false;
  return fallback;
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function provider(value, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'claude' || v === 'gpt' ? v : fallback;
}

function model(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  return v.replace(/[^\w.:/-]/g, '').slice(0, 80) || fallback;
}

function reasoning(value, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'default', 'minimal', 'none'].includes(v) ? v : fallback;
}

function cacheKeyPrefix(value, fallback) {
  const v = String(value || '').trim().replace(/[^\w.-]+/g, '_').slice(0, 64);
  return v || fallback;
}

function envConfig() {
  const primary = process.env.OPENAI_MODEL_FAST || process.env.GPT_MODEL_FAST || process.env.OPENAI_MODEL_MAIN || DEFAULT_CONFIG.models.humanizePrimary;
  const escalation = process.env.OPENAI_MODEL_MAIN || process.env.GPT_MODEL_MAIN || DEFAULT_CONFIG.models.humanizeEscalation;
  const detect = process.env.OPENAI_MODEL_DETECT || process.env.GPT_MODEL_DETECT || primary;
  const evidence = process.env.OPENAI_MODEL_EVIDENCE || process.env.GPT_MODEL_EVIDENCE || primary;
  return sanitizeConfig({
    activeProvider: process.env.LLM_ACTIVE_PROVIDER || process.env.GPT_ACTIVE_PROVIDER || DEFAULT_CONFIG.activeProvider,
    fallbackProvider: process.env.LLM_FALLBACK_PROVIDER || process.env.GPT_FALLBACK_PROVIDER || DEFAULT_CONFIG.fallbackProvider,
    shadowMode: process.env.GPT_SHADOW_MODE,
    models: {
      humanizePrimary: primary,
      humanizeEscalation: process.env.OPENAI_MODEL_ESCALATION || process.env.GPT_MODEL_ESCALATION || escalation,
      judge: process.env.OPENAI_MODEL_JUDGE || process.env.GPT_MODEL_JUDGE || primary,
      repair: process.env.OPENAI_MODEL_REPAIR || process.env.GPT_MODEL_REPAIR || primary,
      classify: process.env.OPENAI_MODEL_CLASSIFY || process.env.GPT_MODEL_CLASSIFY || DEFAULT_CONFIG.models.classify,
      detect,
      detectEscalation: process.env.OPENAI_MODEL_DETECT_ESCALATION || process.env.GPT_MODEL_DETECT_ESCALATION || escalation,
      evidenceSearch: evidence,
      evidenceEscalation: process.env.OPENAI_MODEL_EVIDENCE_ESCALATION || process.env.GPT_MODEL_EVIDENCE_ESCALATION || escalation
    },
    reasoning: {
      humanize: process.env.OPENAI_REASONING_HUMANIZE || process.env.OPENAI_REASONING_MAIN || DEFAULT_CONFIG.reasoning.humanize,
      factDense: process.env.OPENAI_REASONING_FACT_DENSE || DEFAULT_CONFIG.reasoning.factDense,
      escalation: process.env.OPENAI_REASONING_ESCALATION || DEFAULT_CONFIG.reasoning.escalation,
      judge: process.env.OPENAI_REASONING_JUDGE || DEFAULT_CONFIG.reasoning.judge,
      repair: process.env.OPENAI_REASONING_REPAIR || DEFAULT_CONFIG.reasoning.repair,
      classify: process.env.OPENAI_REASONING_CLASSIFY || DEFAULT_CONFIG.reasoning.classify,
      detect: process.env.OPENAI_REASONING_DETECT || DEFAULT_CONFIG.reasoning.detect,
      evidenceSearch: process.env.OPENAI_REASONING_EVIDENCE || DEFAULT_CONFIG.reasoning.evidenceSearch
    },
    cache: {
      enabled: process.env.OPENAI_PROMPT_CACHE_ENABLED == null ? DEFAULT_CONFIG.cache.enabled : process.env.OPENAI_PROMPT_CACHE_ENABLED,
      keyPrefix: process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX || DEFAULT_CONFIG.cache.keyPrefix,
      retention: process.env.OPENAI_PROMPT_CACHE_RETENTION || DEFAULT_CONFIG.cache.retention
    },
    escalation: {
      enabled: process.env.GPT_ESCALATION_ENABLED == null ? DEFAULT_CONFIG.escalation.enabled : process.env.GPT_ESCALATION_ENABLED,
      longTextChars: numberEnv('GPT_ESCALATION_LONG_TEXT_CHARS', DEFAULT_CONFIG.escalation.longTextChars),
      protectedTermThreshold: numberEnv('GPT_ESCALATION_PROTECTED_TERM_THRESHOLD', DEFAULT_CONFIG.escalation.protectedTermThreshold),
      patchTargetThreshold: numberEnv('GPT_ESCALATION_PATCH_TARGET_THRESHOLD', DEFAULT_CONFIG.escalation.patchTargetThreshold)
    }
  });
}

function sanitizeConfig(raw = {}) {
  const base = DEFAULT_CONFIG;
  const models = raw.models || {};
  const r = raw.reasoning || {};
  const cache = raw.cache || {};
  const escalation = raw.escalation || {};
  return {
    activeProvider: provider(raw.activeProvider, base.activeProvider),
    fallbackProvider: provider(raw.fallbackProvider, base.fallbackProvider),
    shadowMode: boolValue(raw.shadowMode, base.shadowMode),
    models: {
      humanizePrimary: model(models.humanizePrimary, base.models.humanizePrimary),
      humanizeEscalation: model(models.humanizeEscalation, base.models.humanizeEscalation),
      judge: model(models.judge, base.models.judge),
      repair: model(models.repair, base.models.repair),
      classify: model(models.classify, base.models.classify),
      detect: model(models.detect, base.models.detect),
      detectEscalation: model(models.detectEscalation, base.models.detectEscalation),
      evidenceSearch: model(models.evidenceSearch, base.models.evidenceSearch),
      evidenceEscalation: model(models.evidenceEscalation, base.models.evidenceEscalation)
    },
    reasoning: {
      humanize: reasoning(r.humanize, base.reasoning.humanize),
      factDense: reasoning(r.factDense, base.reasoning.factDense),
      escalation: reasoning(r.escalation, base.reasoning.escalation),
      judge: reasoning(r.judge, base.reasoning.judge),
      repair: reasoning(r.repair, base.reasoning.repair),
      classify: reasoning(r.classify, base.reasoning.classify),
      detect: reasoning(r.detect, base.reasoning.detect),
      evidenceSearch: reasoning(r.evidenceSearch, base.reasoning.evidenceSearch)
    },
    cache: {
      enabled: boolValue(cache.enabled, base.cache.enabled),
      keyPrefix: cacheKeyPrefix(cache.keyPrefix, base.cache.keyPrefix),
      retention: String(cache.retention || '').trim().slice(0, 40)
    },
    escalation: {
      enabled: boolValue(escalation.enabled, base.escalation.enabled),
      longTextChars: Math.round(clamp(escalation.longTextChars, 1000, 100000, base.escalation.longTextChars)),
      protectedTermThreshold: Math.round(clamp(escalation.protectedTermThreshold, 1, 500, base.escalation.protectedTermThreshold)),
      patchTargetThreshold: Math.round(clamp(escalation.patchTargetThreshold, 1, 100, base.escalation.patchTargetThreshold))
    }
  };
}

function applyForceProvider(cfg) {
  const forced = provider(process.env.GPT_RUNTIME_FORCE_PROVIDER || process.env.LLM_FORCE_PROVIDER, '');
  if (!forced) return cfg;
  return { ...cfg, activeProvider: forced, source: cfg.source ? `${cfg.source}+forced_env` : 'forced_env' };
}

function publicConfig(cfg, source = 'env') {
  const clean = sanitizeConfig(cfg);
  return applyForceProvider({ ...clean, source, version: VERSION });
}

function clearRuntimeConfigCache() {
  cachedRuntimeConfig = null;
}

async function getRuntimeConfig({ db, logger, force = false } = {}) {
  const now = Date.now();
  if (!force && cachedRuntimeConfig && now - cachedRuntimeConfig.loadedAt < CACHE_TTL_MS) {
    return cachedRuntimeConfig.value;
  }

  const envCfg = envConfig();
  if (!db) {
    const value = publicConfig(envCfg, 'env');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }

  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    const merged = {
      ...envCfg,
      ...stored,
      models: { ...envCfg.models, ...(stored.models || {}) },
      reasoning: { ...envCfg.reasoning, ...(stored.reasoning || {}) },
      cache: { ...envCfg.cache, ...(stored.cache || {}) },
      escalation: { ...envCfg.escalation, ...(stored.escalation || {}) }
    };
    const value = publicConfig(merged, snap.exists ? 'firestore' : 'env');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('gpt_runtime.config_failed_env_fallback', { err: e && e.message });
    }
    const value = publicConfig(envCfg, 'env_fallback');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }
}

function isGptActive(cfg) {
  const c = cfg || publicConfig(envConfig(), 'env');
  return c.activeProvider === 'gpt' && c.shadowMode !== true;
}

module.exports = {
  VERSION,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
  DEFAULT_CONFIG,
  envConfig,
  config: envConfig,
  sanitizeConfig,
  publicConfig,
  getRuntimeConfig,
  clearRuntimeConfigCache,
  isGptActive
};
