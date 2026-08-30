'use strict';

const DEFAULT_MAX_AGE_SECONDS = 10 * 60;

function hasRecentAuthentication(decodedToken, options = {}) {
  const maxAgeSeconds = Number.isFinite(options.maxAgeSeconds)
    ? Math.max(0, Math.floor(options.maxAgeSeconds))
    : DEFAULT_MAX_AGE_SECONDS;
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? Math.floor(options.nowSeconds)
    : Math.floor(Date.now() / 1000);
  const authTime = Number(decodedToken && decodedToken.auth_time);

  if (!Number.isFinite(authTime) || authTime <= 0) return false;
  // A small amount of clock skew is harmless, but a token claiming a future
  // authentication time must not satisfy a destructive-action gate.
  if (authTime > nowSeconds + 60) return false;
  return nowSeconds - authTime <= maxAgeSeconds;
}

module.exports = {
  DEFAULT_MAX_AGE_SECONDS,
  hasRecentAuthentication,
};
