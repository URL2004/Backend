'use strict';

const SENSITIVE_ENV_NAME_RE = /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API[_-]?KEY|SERVICE[_-]?ACCOUNT|WEBHOOK)/iu;

function apiSecurityHeaders(_req, res, next) {
  // This server only returns API responses. Individual public endpoints may
  // deliberately replace Cache-Control later (for example /public/metrics).
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function sensitiveEnvironmentValues(env = process.env) {
  return Object.entries(env || {})
    .filter(([name, value]) => SENSITIVE_ENV_NAME_RE.test(String(name))
      && typeof value === 'string'
      && value.trim().length >= 12)
    .map(([, value]) => value.trim());
}

function payloadContainsSensitiveValue(value, secrets, seen = new WeakSet()) {
  if (typeof value === 'string') return secrets.some(secret => value.includes(secret));
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some(item => payloadContainsSensitiveValue(item, secrets, seen));
  }
  return Object.values(value).some(item => payloadContainsSensitiveValue(item, secrets, seen));
}

function protectPublicHealthPayload(payload, env = process.env) {
  const secrets = sensitiveEnvironmentValues(env);
  if (secrets.length && payloadContainsSensitiveValue(payload, secrets)) {
    const error = new Error('Public health payload contained a configured sensitive value.');
    error.code = 'HEALTH_PAYLOAD_SENSITIVE_VALUE';
    throw error;
  }
  return payload;
}

module.exports = {
  apiSecurityHeaders,
  protectPublicHealthPayload,
  sensitiveEnvironmentValues
};
