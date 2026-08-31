'use strict';

const crypto = require('node:crypto');
const { logger: defaultLogger } = require('../lib/logger');
const { realClientIp } = require('../lib/clientip');

const COLLECTION = 'securityRateLimits';
const MODES = new Set(['off', 'shadow', 'enforce']);

function positiveInt(value, fallback, { min = 1, max = 100_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function durableRateLimitMode(env = process.env) {
  const mode = String(env.DURABLE_RATE_LIMIT_MODE || '').trim().toLowerCase();
  return MODES.has(mode) ? mode : 'off';
}

function policiesFromEnv(env = process.env) {
  return Object.freeze({
    ai: Object.freeze({
      hourly: positiveInt(env.DURABLE_AI_RATE_LIMIT_HOURLY, 120),
      daily: positiveInt(env.DURABLE_AI_RATE_LIMIT_DAILY, 800)
    }),
    payment: Object.freeze({
      hourly: positiveInt(env.DURABLE_PAYMENT_RATE_LIMIT_HOURLY, 60),
      daily: positiveInt(env.DURABLE_PAYMENT_RATE_LIMIT_DAILY, 200)
    })
  });
}

function requestPath(req) {
  return String(req?.path || req?.originalUrl || req?.url || '').split('?')[0];
}

function scopeForRequest(req) {
  if (String(req?.method || '').toUpperCase() !== 'POST') return '';
  const path = requestPath(req);
  if (
    /^\/(?:analyze|diagnose|detect-report|coach-suggest)$/u.test(path)
    || /^\/transform(?:$|\/[^/]+\/refine-paragraph$)/u.test(path)
    || /^\/writing-lab\/(?:v2\/)?(?:extract|prepare|generate|check|finalize)$/u.test(path)
  ) return 'ai';
  if (
    /^\/(?:checkout-context|prepare-payment|confirm-payment|request-refund)$/u.test(path)
    // `/subscription/charge` is a server-to-server renewal worker and must not
    // share an end-user network quota with browser billing operations.
    || /^\/subscription\/(?:issue-billing-key|cancel|resume)$/u.test(path)
  ) return 'payment';
  return '';
}

function bucketKeys(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return { hourKey: iso.slice(0, 13), dayKey: iso.slice(0, 10) };
}

function retryAfterSeconds(scope, nowMs) {
  const now = new Date(nowMs);
  const next = scope === 'daily'
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

function principalDocumentId(secret, scope, principal) {
  return crypto
    .createHmac('sha256', secret)
    .update(`gp:durable-rate-limit:v1\0${scope}\0${principal}`, 'utf8')
    .digest('hex');
}

async function consumeDurableLimit({ db, secret, scope, principal, policy, nowMs = Date.now() }) {
  if (!db?.runTransaction || !secret || !scope || !principal || !policy) {
    return { available: false, allowed: true, reason: 'not_configured' };
  }
  const id = principalDocumentId(secret, scope, principal);
  const ref = db.collection(COLLECTION).doc(id);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.exists ? (snapshot.data() || {}) : {};
    const { hourKey, dayKey } = bucketKeys(nowMs);
    const hourCount = previous.hourKey === hourKey ? Math.max(0, Number(previous.hourCount) || 0) : 0;
    const dayCount = previous.dayKey === dayKey ? Math.max(0, Number(previous.dayCount) || 0) : 0;
    if (hourCount >= policy.hourly) {
      return { available: true, allowed: false, scope: 'hourly', retryAfterSec: retryAfterSeconds('hourly', nowMs) };
    }
    if (dayCount >= policy.daily) {
      return { available: true, allowed: false, scope: 'daily', retryAfterSec: retryAfterSeconds('daily', nowMs) };
    }
    transaction.set(ref, {
      schemaVersion: 1,
      scope,
      hourKey,
      hourCount: hourCount + 1,
      dayKey,
      dayCount: dayCount + 1,
      updatedAt: new Date(nowMs),
      // Optional Firestore TTL policy can safely delete inactive counters.
      expiresAt: new Date(nowMs + (8 * 24 * 60 * 60 * 1000))
    }, { merge: true });
    return {
      available: true,
      allowed: true,
      hourlyRemaining: policy.hourly - hourCount - 1,
      dailyRemaining: policy.daily - dayCount - 1
    };
  });
}

function createDurableRateLimit({
  db,
  logger = defaultLogger,
  env = process.env,
  mode = null,
  secret = null,
  policies = null,
  now = () => Date.now(),
  clientPrincipal = realClientIp
} = {}) {
  let warnedUnavailable = false;
  let lastFailureLogAt = 0;
  return async function durableRateLimit(req, res, next) {
    const activeMode = mode || durableRateLimitMode(env);
    if (activeMode === 'off') return next();
    const scope = scopeForRequest(req);
    if (!scope) return next();
    const configuredPolicies = policies || policiesFromEnv(env);
    const signingSecret = String(secret || env.RATE_LIMIT_HMAC_SECRET || env.OPENAI_SAFETY_SALT || '').trim();
    if (!db || Buffer.byteLength(signingSecret, 'utf8') < 32) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        logger.warn('security.durable_rate_limit_unavailable', {
          reason: !db ? 'db_unavailable' : 'hmac_secret_missing',
          mode: activeMode,
          noAlert: activeMode !== 'enforce'
        });
      }
      return next();
    }

    try {
      const result = await consumeDurableLimit({
        db,
        secret: signingSecret,
        scope,
        principal: String(clientPrincipal(req) || 'unknown'),
        policy: configuredPolicies[scope],
        nowMs: now()
      });
      req.durableRateLimit = { mode: activeMode, scope, ...result };
      if (result.allowed) return next();
      logger.warn(activeMode === 'shadow'
        ? 'security.durable_rate_limit_shadow_exceeded'
        : 'security.durable_rate_limit_exceeded', {
        scope,
        quotaScope: result.scope,
        retryAfterSec: result.retryAfterSec,
        noAlert: activeMode === 'shadow'
      });
      if (activeMode === 'shadow') return next();
      res.set('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        ok: false,
        code: 'RATE_LIMITED',
        error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
      });
    } catch (error) {
      // A quota datastore outage must not become a site-wide outage. The
      // existing in-memory limiter remains in front of this optional layer.
      const failureAt = now();
      if (failureAt - lastFailureLogAt >= 60_000) {
        lastFailureLogAt = failureAt;
        logger.warn('security.durable_rate_limit_failed_open', {
          scope,
          mode: activeMode,
          err: error,
          noAlert: activeMode !== 'enforce'
        });
      }
      return next();
    }
  };
}

module.exports = {
  COLLECTION,
  bucketKeys,
  consumeDurableLimit,
  createDurableRateLimit,
  durableRateLimitMode,
  policiesFromEnv,
  principalDocumentId,
  scopeForRequest
};
