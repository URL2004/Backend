'use strict';

const DEFAULT_MAX_RESTART_RECOVERIES = 8;

function restartRecoveryLimit(value = process.env.TRANSFORM_RESTART_RECOVERY_MAX) {
  const parsed = Number(value);
  return Math.max(
    1,
    Math.min(20, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_MAX_RESTART_RECOVERIES)
  );
}

function canRecoverRunningJob(job, { maxRecoveries = restartRecoveryLimit() } = {}) {
  if (!job || String(job.status || '') !== 'running') return { ok: false, reason: 'not_running' };
  if (!String(job.id || '').trim()) return { ok: false, reason: 'missing_job_id' };
  if (!String(job.text || '').trim()) return { ok: false, reason: 'missing_source_text' };
  const count = Math.max(0, Number(job.restartRecoveryCount) || 0);
  if (count >= maxRecoveries) return { ok: false, reason: 'restart_recovery_limit' };
  return { ok: true, reason: 'recoverable' };
}

function prepareRunningJobForRestart(job, {
  now = Date.now(),
  maxRecoveries = restartRecoveryLimit(),
  reason = 'server_restart'
} = {}) {
  const eligibility = canRecoverRunningJob(job, { maxRecoveries });
  if (!eligibility.ok) return { recovered: false, reason: eligibility.reason, job };

  job.status = 'queued';
  job.stage = '서버 교체 후 자동 재개 대기';
  job.error = null;
  job.queuedAt = Number(now) || Date.now();
  job.startedAt = null;
  job.terminalAtMs = null;
  job.restartRecoveryCount = Math.max(0, Number(job.restartRecoveryCount) || 0) + 1;
  job.restartRecoveryAtMs = Number(now) || Date.now();
  job.restartRecoveryReason = String(reason || 'server_restart').slice(0, 48);
  job._restartRecoveryPending = true;
  return { recovered: true, reason: 'queued_for_restart_recovery', job };
}

function holdRestoredRunningJob(job, { now = Date.now(), delayMs = 30000 } = {}) {
  if (!job || String(job.status || '') !== 'running') return { held: false, job };
  job.status = 'queued';
  job.stage = '서버 교체 확인 중 · 자동 재개 예정';
  job.error = null;
  job.queuedAt = Number(now) || Date.now();
  job.startedAt = null;
  job.terminalAtMs = null;
  job._restartRecoveryPending = true;
  job._restartRecoveryHoldUntilMs = (Number(now) || Date.now()) + Math.max(0, Number(delayMs) || 0);
  return { held: true, job };
}

function releaseRestartRecoveryHold(job) {
  if (!job) return job;
  job._restartRecoveryPending = false;
  job._restartRecoveryHoldUntilMs = 0;
  return job;
}

function isRestartRecoveryHeld(job, now = Date.now()) {
  if (!job || job._restartRecoveryPending !== true) return false;
  const holdUntil = Number(job._restartRecoveryHoldUntilMs) || 0;
  return holdUntil <= 0 || holdUntil > (Number(now) || Date.now());
}

function markRestartRecoveryExhausted(job, { now = Date.now() } = {}) {
  if (!job) return job;
  job.status = 'error';
  job.stage = '자동 재개 한도 초과';
  job.error = '서버 교체가 반복되어 자동 재개 한도에 도달했어요. 크레딧은 중복 차감되지 않았습니다.';
  job.terminalAtMs = Number(now) || Date.now();
  job._restartRecoveryPending = false;
  job._restartRecoveryHoldUntilMs = 0;
  return job;
}

module.exports = {
  DEFAULT_MAX_RESTART_RECOVERIES,
  restartRecoveryLimit,
  canRecoverRunningJob,
  prepareRunningJobForRestart,
  holdRestoredRunningJob,
  releaseRestartRecoveryHold,
  isRestartRecoveryHeld,
  markRestartRecoveryExhausted
};
