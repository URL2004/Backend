'use strict';

const METHODS = new Set(['google', 'kakao']);
const FLOWS = new Set(['popup', 'redirect']);
const STAGES = new Set(['provider', 'sdk', 'popup', 'callback', 'token_exchange', 'backend_exchange', 'firebase_signin', 'complete']);
const OUTCOMES = new Set(['start', 'success', 'cancel', 'error']);
const ERROR_CODES = new Set(['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled',
  'auth/network-request-failed', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported',
  'auth/unauthorized-domain', 'auth/internal-error', 'auth/invalid-custom-token', 'auth/custom-token-mismatch',
  'auth/user-disabled', 'auth/account-exists-with-different-credential', 'auth/too-many-requests', 'CANCELED',
  'access_denied', 'oauth_state_invalid', 'KAKAO_BACKEND_ERROR', 'KAKAO_TOKEN_EXCHANGE_FAILED',
  'KAKAO_SDK_UNAVAILABLE', 'KAKAO_SDK_TIMEOUT', 'KAKAO_REAUTH_ACCOUNT_MISMATCH', 'storage_unavailable',
  'inapp_unsupported', 'network_timeout', 'network_or_runtime_error', 'unknown']);

function browserFamily(ua = '') {
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/KAKAOTALK/i.test(ua)) return 'kakao';
  if (/; wv\)|\bwv\b/i.test(ua)) return 'android_webview';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome|CriOS/i.test(ua)) return 'chrome';
  if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
  if (/Safari/i.test(ua)) return 'safari';
  return 'other';
}

function normalizeAuthDiagnostic(body, ua = '') {
  if (!body || typeof body !== 'object' || !/^[a-f0-9]{32}$/.test(body.attempt_id || '')
    || !METHODS.has(body.method) || !FLOWS.has(body.flow) || !STAGES.has(body.stage) || !OUTCOMES.has(body.outcome)) return null;
  if (body.outcome === 'success' && body.stage !== 'complete') return null;
  const sources = ['google', 'naver', 'bing', 'meta', 'instagram', 'direct'];
  const media = ['organic', 'cpc', 'paid_social', 'paid', 'social', 'referral', 'none'];
  return {
    schema_version: 1, attempt_id: body.attempt_id, method: body.method, flow: body.flow,
    stage: body.stage, outcome: body.outcome,
    error_code: ['start', 'success'].includes(body.outcome) ? '' : ERROR_CODES.has(body.error_code) ? body.error_code : 'unknown',
    duration_ms: Number.isFinite(body.duration_ms) ? Math.max(0, Math.min(600000, Math.round(body.duration_ms))) : 0,
    release: /^[a-zA-Z0-9._-]{1,40}$/.test(body.release || '') ? body.release : 'unknown',
    traffic_source: sources.includes(body.traffic_source) ? body.traffic_source : 'other',
    traffic_medium: media.includes(body.traffic_medium) ? body.traffic_medium : 'other',
    device: ['desktop', 'mobile', 'tablet'].includes(body.device) ? body.device : 'unknown',
    browser: browserFamily(ua), reported_by: 'client'
  };
}

// Independent of inquiry/payment limits. Bounded memory; no IP appears in the event.
function createDiagnosticLimiter({ windowMs = 300000, max = 60, capacity = 5000 } = {}) {
  const buckets = new Map();
  return function limited(key, now = Date.now()) {
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.since >= windowMs) {
      if (!bucket && buckets.size >= capacity) {
        for (const [id, value] of buckets) if (now - value.since >= windowMs) buckets.delete(id);
        if (buckets.size >= capacity) return true;
      }
      bucket = { since: now, count: 0 }; buckets.set(key, bucket);
    }
    return ++bucket.count > max;
  };
}

module.exports = { normalizeAuthDiagnostic, browserFamily, createDiagnosticLimiter };
