'use strict';

const VERSION = 'queue-schedule-v2';
const poolOf = mode => mode === 'formal' || !mode ? 'formal' : 'short';
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const duration = job => Math.min(7200, positive(job.estSec, poolOf(job.mode) === 'formal' ? 900 : 120));

// Mirror drainQueue's chronological admission, pool ceilings and shared slots.
// This is a projection, not a reservation: elapsed runtime and each predecessor's
// own estimate are used, and unknown restart holds cannot promise an immediate start.
function estimateQueue(target, jobs, { now = Date.now(), sharedCap = 1,
  formalCap = 1, shortCap = 1, launching = new Set() } = {}) {
  if (!target || target.status !== 'queued') return {};
  const caps = { formal: positive(formalCap, 1), short: positive(shortCap, 1) };
  const totalCap = positive(sharedCap, 1);
  const rows = Array.from(jobs);
  const ordered = rows.filter(job => job.status === 'queued' && !launching.has(job.id))
    .sort((a, b) => (a.queuedAt || a.createdAt || 0) - (b.queuedAt || b.createdAt || 0)
      || Number(poolOf(a.mode) === 'short') - Number(poolOf(b.mode) === 'short'));
  const details = {
    queuePosition: Math.max(1, ordered.findIndex(job => job.id === target.id) + 1),
    queueSize: Math.max(1, ordered.length),
    queueWaitSec: Math.max(0, Math.floor((now - (target.queuedAt || target.createdAt || now)) / 1000)),
    queueWaitReason: target.queueWaitReason || 'capacity',
    queueEtaSec: null,
    queueEstimateVersion: VERSION
  };
  if (target.queueWaitReason === 'provider_recovery') return details;
  if (launching.has(target.id)) return { ...details, queueEtaSec: 15 };
  const readyAt = job => {
    if (job._restartRecoveryPending === true && !(Number(job._restartRecoveryHoldUntilMs) > 0)) return Infinity;
    return Math.max(0, (Number(job.retryNotBeforeMs) - now) / 1000 || 0,
      job._restartRecoveryPending === true ? (Number(job._restartRecoveryHoldUntilMs) - now) / 1000 : 0);
  };
  if (!Number.isFinite(readyAt(target))) return details;
  let active = rows.filter(job => job.status === 'running' || launching.has(job.id)).map(job => {
    const estimate = duration(job);
    const elapsed = job.status === 'running' && Number(job.startedAt) > 0
      ? Math.max(0, (now - Number(job.startedAt)) / 1000) : 0;
    const high = Math.min(7200, Math.max(estimate, positive(job.estHighSec, estimate)));
    // A predecessor past its upper estimate has no defensible finish time.
    // Keep its slot occupied until observed complete; another known worker
    // may still admit this job. Never renew a fictitious 30-second countdown.
    const remaining = elapsed >= high ? Infinity
      : Math.max(15, estimate > elapsed ? estimate - elapsed : high - elapsed);
    return { pool: poolOf(job.mode), end: remaining };
  });
  let pending = ordered.map(job => ({ job, pool: poolOf(job.mode), ready: readyAt(job) }));
  let time = 0;
  for (let step = 0; step <= rows.length * 3 + 3; step++) {
    active = active.filter(item => item.end > time);
    const counts = { formal: 0, short: 0 };
    active.forEach(item => counts[item.pool]++);
    const deferred = [];
    for (const item of pending) {
      if (item.ready > time || active.length >= totalCap || counts[item.pool] >= caps[item.pool]) {
        deferred.push(item); continue;
      }
      if (item.job.id === target.id) return { ...details, queueEtaSec: Math.max(15, Math.ceil(time)) };
      active.push({ pool: item.pool, end: time + duration(item.job) });
      counts[item.pool]++;
    }
    pending = deferred;
    const next = Math.min(...active.map(item => item.end), ...pending.filter(item => item.ready > time).map(item => item.ready));
    if (!Number.isFinite(next)) return details;
    time = next;
  }
  return details;
}

module.exports = { VERSION, estimateQueue };
