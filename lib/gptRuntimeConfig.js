'use strict';

const VERSION = 'gpt-runtime-config-v1';
const SETTINGS_COLLECTION = 'adminSettings';
const SETTINGS_DOC = 'gptRuntimeConfig';
const CACHE_TTL_MS = 15000;

const DEFAULT_CONFIG = {
  activeProvider: 'gpt',
  models: {
    humanizePrimary: 'gpt-5.4-mini',
    humanizeEscalation: 'gpt-5.4',
    judge: 'gpt-5.4-mini',
    judgeEscalation: 'gpt-5.4',
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
    judge: 'medium',
    repair: 'medium',
    classify: 'low',
    detect: 'low',
    evidenceSearch: 'medium'
  },
  cache: {
    enabled: true,
    keyPrefix: 'gp-v9-cksafe-ko-p20260704',
    retention: ''
  },
  escalation: {
    enabled: true,
    longTextChars: 9000,
    protectedTermThreshold: 12,
    patchTargetThreshold: 3
  }
};

// env-only 호출과 Firestore-backed 호출은 서로 다른 권한·신선도 경로다.
// 하나의 슬롯을 공유하면 관리자 랩이 env 값을 먼저 읽은 15초 동안 운영
// Firestore 설정까지 env로 고정될 수 있으므로 소스별로 캐시를 분리한다.
const cachedRuntimeConfigs = new Map();

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

function model(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  return v.replace(/[^\w.:/-]/g, '').slice(0, 80) || fallback;
}

function reasoning(value, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'default', 'minimal'].includes(v) ? v : fallback;
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
    activeProvider: 'gpt',
    models: {
      humanizePrimary: primary,
      humanizeEscalation: process.env.OPENAI_MODEL_ESCALATION || process.env.GPT_MODEL_ESCALATION || escalation,
      judge: process.env.OPENAI_MODEL_JUDGE || process.env.GPT_MODEL_JUDGE || primary,
      judgeEscalation: process.env.OPENAI_MODEL_JUDGE_ESCALATION || process.env.GPT_MODEL_JUDGE_ESCALATION || escalation,
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
    // GPT is the only production provider. Rollback is performed by restoring
    // the previous live deployment, not by switching providers at runtime.
    activeProvider: 'gpt',
    models: {
      humanizePrimary: model(models.humanizePrimary, base.models.humanizePrimary),
      humanizeEscalation: model(models.humanizeEscalation, base.models.humanizeEscalation),
      judge: model(models.judge, base.models.judge),
      judgeEscalation: model(models.judgeEscalation, base.models.judgeEscalation),
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
      protectedTermThreshold: Math.round(clamp(escalation.protectedTermThreshold, 1, 120, base.escalation.protectedTermThreshold)),
      patchTargetThreshold: Math.round(clamp(escalation.patchTargetThreshold, 1, 12, base.escalation.patchTargetThreshold))
    }
  };
}

function publicConfig(cfg, source = 'env') {
  const clean = sanitizeConfig(cfg);
  return { ...clean, source, version: VERSION };
}

function clearRuntimeConfigCache() {
  cachedRuntimeConfigs.clear();
}

async function getRuntimeConfig({ db, logger, force = false } = {}) {
  const now = Date.now();
  const cacheKey = db ? 'firestore' : 'env';
  const cachedRuntimeConfig = cachedRuntimeConfigs.get(cacheKey);
  if (!force && cachedRuntimeConfig && now - cachedRuntimeConfig.loadedAt < CACHE_TTL_MS) {
    return cachedRuntimeConfig.value;
  }

  const envCfg = envConfig();
  if (!db) {
    const value = publicConfig(envCfg, 'env');
    cachedRuntimeConfigs.set(cacheKey, { loadedAt: now, value });
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
    cachedRuntimeConfigs.set(cacheKey, { loadedAt: now, value });
    return value;
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('gpt_runtime.config_failed_env_fallback', { err: e && e.message });
    }
    const value = publicConfig(envCfg, 'env_fallback');
    cachedRuntimeConfigs.set(cacheKey, { loadedAt: now, value });
    return value;
  }
}

function isGptActive(cfg) {
  const c = cfg || publicConfig(envConfig(), 'env');
  return c.activeProvider === 'gpt';
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
