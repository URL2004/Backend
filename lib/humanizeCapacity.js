'use strict';

// Admission and actual workers must use the same budget. Two independent route
// pools must not each admit a full worker pool and hide the excess as running.
function workerCapacity(env = process.env) {
  const configured = Number(env.HUMANIZE_ENGINE_WORKERS);
  return Math.max(1, Math.min(3, Math.floor(Number.isFinite(configured) && configured > 0 ? configured : 2)));
}

function executionLimits(env = process.env) {
  const safeCap = Math.max(1, Number(env.TRANSFORM_SAFE_ACTIVE_CAP) || 2);
  return {
    caps: {
      formal: Math.min(Number(env.RESTRUCTURE_MAX_ACTIVE) || 3, safeCap),
      short: Math.min(Number(env.BLOG_MAX_ACTIVE) || 4, safeCap)
    },
    totalCap: workerCapacity(env)
  };
}

module.exports = { workerCapacity, executionLimits };
